// Run against a production build: node scripts/perf-check.mjs [--output report.json]
// Optional Windows/Linux browser override: PW_CHROMIUM_EXECUTABLE_PATH.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../dist/", import.meta.url)),
  prefix = "/ucsd-tss-course/";
const cpuRate = 4,
  down = 1_600_000 / 8,
  up = 750_000 / 8,
  latency = 150;
const arg = (flag) =>
  process.argv.includes(flag)
    ? process.argv[process.argv.indexOf(flag) + 1]
    : undefined;
const output = arg("--output"),
  screenshot = arg("--screenshot");
const BASE_PASS_COUNT = 5,
  SEARCH_COUNT = 30,
  WORKER_COUNT = 25;
const types = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};

async function serve() {
  const blobs = new Map();
  async function asset(name) {
    if (blobs.has(name)) return blobs.get(name);
    const p = path.resolve(root, name);
    if (!p.startsWith(path.resolve(root) + path.sep))
      throw Error("Outside build");
    const data = await readFile(p),
      ext = path.extname(p),
      compress = [
        ".html",
        ".js",
        ".mjs",
        ".css",
        ".json",
        ".svg",
        ".webmanifest",
        ".txt",
      ].includes(ext);
    const blob = {
      mime: types[ext] || "application/octet-stream",
      data,
      gzip: compress ? gzipSync(data, { level: 6 }) : null,
    };
    blobs.set(name, blob);
    return blob;
  }
  // Freeze the build during the run; neighboring workspaces may rebuild.
  const staticFiles = await readdir(path.join(root, "assets"));
  for (const name of [
    "index.html",
    "data/starter.json",
    "data/catalog.json",
    "data/routes-graph.json",
    "data/seats.json",
    ...staticFiles.map((f) => "assets/" + f),
  ])
    await asset(name);
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      if (!u.pathname.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }
      const uri =
          decodeURIComponent(u.pathname.slice(prefix.length)) || "index.html",
        blob = await asset(uri);
      const compressed =
        blob.gzip && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      res.writeHead(200, {
        "Content-Type": blob.mime,
        "Content-Length": (compressed ? blob.gzip : blob.data).length,
        Vary: "Accept-Encoding",
        "Cache-Control": uri.startsWith("assets/")
          ? "public,max-age=31536000,immutable"
          : "no-cache",
        ...(compressed ? { "Content-Encoding": "gzip" } : {}),
      });
      res.end(compressed ? blob.gzip : blob.data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}${prefix}`,
    worker: staticFiles.find((k) => /^solver\.worker-[\w-]+\.js$/.test(k)),
    build: staticFiles.filter((f) => /^(index-|solver\.worker-)/.test(f)),
    courses: JSON.parse(blobs.get("data/catalog.json").data).courses,
  };
}
const rounded = (n) => Math.round(n * 10) / 10;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p) => rounded(sorted[Math.ceil(sorted.length * p) - 1]);
  return {
    n: values.length,
    p50: quantile(0.5),
    p95: quantile(0.95),
    min: rounded(sorted[0]),
    max: rounded(sorted.at(-1)),
  };
}
function fixture() {
  const meeting = (type, days, start, end, extra = {}) => ({
    type,
    days,
    start,
    end,
    building: "CENTR",
    room: "115",
    ...extra,
  });
  const courses = Array.from({ length: 6 }, (_, c) => ({
    code: "PERF " + c,
    title: "Performance fixture",
    units: "4",
    instructors: ["Test"],
    options: Array.from({ length: 10 }, (_, o) => ({
      id: "choice" + o,
      label: "P" + o,
      instructor: "Test",
      sectionId: "pkg" + c + "-" + o,
      available: 1,
      capacity: 30,
      waitlist: 0,
      meetings: [
        meeting("LE", [1, 3, 5], 420 + c * 100 + o, 465 + c * 100 + o),
        meeting("DI", [2, 4], 420 + c * 100 + o, 455 + c * 100 + o),
        meeting("FI", [2], 420 + c * 100, 465 + c * 100, {
          date: "2027-03-16",
        }),
      ],
    })),
  }));
  return {
    courses,
    current: [],
    prefs: {
      early: 0,
      minGap: 0,
      speed: 80,
      buffer: 2,
      stepFree: false,
      busy: [],
      locked: [],
      teachers: {},
    },
  };
}

async function contextFor(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    serviceWorkers: "block",
  });
  // No UCSD login or external service is used. The benchmark origin is the local production preview.
  await context.route(/^https:\/\//, (r) => r.abort("blockedbyclient"));
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency,
    downloadThroughput: down,
    uploadThroughput: up,
    connectionType: "cellular4g",
  });
  await client.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  await page.addInitScript(() => {
    window.__measure = { lcp: 0, element: "", ready: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__measure.lcp = e.startTime;
        window.__measure.element =
          (e.element?.tagName || "") +
          " " +
          (e.element?.textContent || "").slice(0, 45);
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    const observer = new MutationObserver(() => {
      if (document.querySelector("main.workspace")) {
        requestAnimationFrame(() => {
          window.__measure.ready = performance.now();
        });
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  const faults = [];
  page.on("pageerror", (e) => faults.push(e.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page
    .getByRole("heading", { name: "Build your schedule" })
    .waitFor({ timeout: 30000 });
  if (await page.locator(".calendar-grid .event").count())
    throw Error("A new plan should start without any classes");
  if (!/Quarterplan/i.test(await page.title()))
    throw Error("Page title did not identify the production application");
  // Wait until the first viewport has rendered and upcoming visual changes from the full catalog have settled.
  await page.waitForFunction(
    () =>
      performance
        .getEntriesByType("resource")
        .some((r) => r.name.endsWith("/data/catalog.json")),
    null,
    { timeout: 30000 },
  );
  await page.waitForTimeout(900);
  const perf = await page.evaluate(() => ({
    ...window.__measure,
    overlay: !!document.querySelector("vite-error-overlay"),
  }));
  if (!perf.lcp || !perf.ready || perf.overlay || faults.length)
    throw Error(
      "Incomplete first-screen measurement " + JSON.stringify({ perf, faults }),
    );
  return { context, page, client, perf };
}

function queries(courses) {
  const norm = (s) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const compact = (s) => s.replace(/\s/g, "").toUpperCase();
  const result = [],
    used = new Set();
  for (let i = 0; result.length < SEARCH_COUNT && i < courses.length; i++) {
    const c = courses[(i * 317 + 41) % courses.length],
      kind = i % 3;
    let query, expected;
    if (kind === 0) {
      query = c.code;
      expected = c.code;
    }
    if (kind === 1) {
      query = c.instructors.find((s) => s && norm(s) !== "staff");
      if (!query) continue;
      expected = courses.find((v) =>
        norm(v.title + " " + v.instructors.join(" ")).includes(norm(query)),
      )?.code;
    }
    if (kind === 2) {
      // Browser search uses real TSS codes, including internal spaces (e.g. E 00009863).
      query = c.options.find((o) => o.sectionId)?.sectionId;
      if (!query) continue;
      expected = courses.find((v) =>
        v.options.some((o) =>
          [o.sectionId, ...o.meetings.map((m) => m.sectionId)].some(
            (id) => id && compact(id) === compact(query),
          ),
        ),
      )?.code;
    }
    if (!expected || used.has(query) || result.at(-1)?.expected === expected)
      continue;
    result.push({
      query,
      expected,
      kind: ["course", "instructor", "section"][kind],
    });
    used.add(query);
  }
  return result;
}
async function searchTimes(page, courses) {
  const searchInput = page.getByPlaceholder("Course, instructor or section ID");
  if (!(await searchInput.first().isVisible())) {
    await page
      .getByRole("button", { name: "Find a course", exact: true })
      .click();
  }
  const visibleInput = searchInput.filter({ visible: true }).first();
  await visibleInput.waitFor();
  await page.evaluate(() => {
    window.__searchSamples = [];
    window.addEventListener(
      "input",
      (e) => {
        if (
          !e.target.matches(
            'input[placeholder="Course, instructor or section ID"]',
          )
        )
          return;
        const start = performance.now(),
          { expected } = window.__query;
        const check = () => {
          if (
            document.querySelector(".search-results button b")?.textContent ===
            expected
          ) {
            // A following frame ensures the correct DOM had a presentation opportunity.
            requestAnimationFrame(() =>
              window.__searchSamples.push(performance.now() - start),
            );
          } else if (performance.now() - start < 3000)
            requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      },
      true,
    );
  });
  const samples = [],
    failures = [];
  for (const q of queries(courses)) {
    await page.evaluate((q) => {
      window.__query = q;
      window.__searchSamples = [];
    }, q);
    await visibleInput.fill(q.query);
    try {
      await page.waitForFunction(
        () => window.__searchSamples.length === 1,
        null,
        { timeout: 1300 },
      );
      const ms = await page.evaluate(() => window.__searchSamples[0]);
      samples.push({ ...q, ms: rounded(ms) });
    } catch {
      const shown = await page
        .locator(".search-results button b")
        .first()
        .textContent({ timeout: 100 })
        .catch(() => null);
      failures.push({ ...q, shown });
    }
  }
  return { samples, failures };
}

async function throttleWorker(browser, url) {
  // Dedicated workers are separate DevTools targets. Apply the rate there as well
  // when the browser implements it; explicitly report when that target rejects it.
  const root = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await root.send("Target.getTargets");
    const target = targetInfos.find(
      (t) => t.type === "worker" && t.url === url,
    );
    if (!target) {
      await root.detach();
      return "worker DevTools target not exposed";
    }
    const { sessionId } = await root.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    const response = new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve("worker emulation command timed out"),
        2500,
      );
      root.on("Target.receivedMessageFromTarget", (e) => {
        const r = JSON.parse(e.message);
        if (e.sessionId === sessionId && r.id === 1) {
          clearTimeout(timer);
          resolve(r.error?.message || "4× acknowledged by worker target");
        }
      });
    });
    await root.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: "Emulation.setCPUThrottlingRate",
        params: { rate: cpuRate },
      }),
    });
    return { root, status: await response };
  } catch (e) {
    await root.detach();
    return String(e.message);
  }
}
async function workerTimes(browser, page, workerURL) {
  const input = fixture();
  const ready = page.waitForEvent("worker");
  await page.evaluate((url) => {
    window.__benchWorker = new Worker(url, { type: "module" });
  }, workerURL);
  await ready;
  const setup = await throttleWorker(browser, workerURL),
    status = typeof setup === "string" ? setup : setup.status;
  try {
    const samples = await page.evaluate(
      async ({ input, count }) => {
        const elapsed = [];
        for (let n = 0; n <= count; n++) {
          const w = window.__benchWorker;
          const wait = new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("worker timeout")),
              10000,
            );
            w.onmessage = (e) => {
              clearTimeout(timer);
              const plans = e.data?.result?.plans;
              if (
                !Array.isArray(plans) ||
                plans.length !== 5 ||
                plans.some((p) => p.picks.length !== 6)
              )
                reject(Error("Invalid worker output"));
              else resolve(performance.now());
            };
            w.onerror = (e) => {
              clearTimeout(timer);
              reject(Error(e.message));
            };
          });
          const start = performance.now();
          w.postMessage(input);
          const ms = (await wait) - start;
          if (n > 0) elapsed.push(ms);
        }
        return elapsed;
      },
      { input, count: WORKER_COUNT },
    );
    return { status, stats: stats(samples), samples: samples.map(rounded) };
  } finally {
    await page.evaluate(() => window.__benchWorker.terminate());
    if (typeof setup === "object") await setup.root.detach();
  }
}

async function throttledSolverControl(page, workerURL) {
  // Chromium currently rejects CPU emulation on a dedicated-worker target.
  // Execute exactly the built local worker program in a module with an isolated
  // message port on the throttled renderer. This measures algorithm cost only.
  return page.evaluate(
    async ({ input, url, count }) => {
      const response = await fetch(url);
      if (!response.ok) throw Error("Cannot read built solver for CPU control");
      const code = await response.text();
      const prologue =
        "let answer; const self={onmessage:null,postMessage(value){answer=value}};\n";
      const appendix =
        "\nexport function callSolver(data){answer=undefined;self.onmessage({data});return answer?.result}\n";
      const blob = URL.createObjectURL(
        new Blob([prologue, code, appendix], { type: "text/javascript" }),
      );
      try {
        const { callSolver } = await import(blob),
          samples = [];
        for (let i = 0; i <= count; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          const start = performance.now(),
            out = callSolver(input),
            elapsed = performance.now() - start;
          if (
            out?.plans.length !== 5 ||
            out.plans.some((p) => p.picks.length !== 6)
          )
            throw Error("Invalid CPU control result");
          if (i) samples.push(elapsed);
        }
        return samples;
      } finally {
        URL.revokeObjectURL(blob);
      }
    },
    { input: fixture(), url: workerURL, count: WORKER_COUNT },
  );
}

const host = await serve();
let browser;
try {
  const defaultEdge =
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const exe =
    process.env.PW_CHROMIUM_EXECUTABLE_PATH ||
    (process.platform === "win32" && existsSync(defaultEdge)
      ? defaultEdge
      : undefined);
  browser = await chromium.launch({ headless: true, executablePath: exe });
  const loads = [];
  let last;
  for (let i = 0; i < BASE_PASS_COUNT; i++) {
    const session = await contextFor(browser, host.url);
    loads.push(session.perf);
    console.error("cold load", i + 1, rounded(session.perf.lcp), "ms");
    if (i < BASE_PASS_COUNT - 1) await session.context.close();
    else last = session;
  }
  if (screenshot) await last.page.screenshot({ path: screenshot });
  const search = await searchTimes(last.page, host.courses);
  const worker = await workerTimes(
    browser,
    last.page,
    host.url + "assets/" + host.worker,
  );
  const control = await throttledSolverControl(
    last.page,
    host.url + "assets/" + host.worker,
  );
  const report = {
    checkedAt: new Date().toISOString(),
    build: host.build,
    browser: browser.version(),
    environment: {
      viewport: "390×844",
      deviceScaleFactor: 2,
      network: "1.6 Mbit/s down, 750 kbit/s up, 150 ms latency",
      pageCpuSlowdown: cpuRate,
      workerCpu: worker.status,
      origin: "loopback " + prefix,
      compression: "gzip",
      cold: "fresh mobile browser context, HTTP cache disabled, service worker blocked; third-party requests blocked",
    },
    lcpMs: stats(loads.map((s) => s.lcp)),
    calendarReadyMs: stats(loads.map((s) => s.ready)),
    coldRuns: loads,
    loadedSearchMs: search.samples.length
      ? stats(search.samples.map((s) => s.ms))
      : null,
    searchKinds: search.samples.reduce(
      (v, s) => ((v[s.kind] = (v[s.kind] || 0) + 1), v),
      {},
    ),
    searchFailures: search.failures,
    searchMethod:
      "real input event to first frame after correct first matching course was rendered, after complete catalog",
    worker6x10Ms: worker.stats,
    workerSamples: worker.samples,
    workerMethod:
      "one warm-up then 25 posted messages to production solver worker, including structured clone and round trip",
    fourTimesCpuSolverControlMs: stats(control),
    fourTimesCpuSolverMethod:
      "same built worker bundle and same input executed synchronously in the 4× throttled renderer; computational control, not a worker round trip",
    catalogFingerprint: createHash("sha256")
      .update(host.courses.map((c) => c.code).join("|"))
      .digest("hex")
      .slice(0, 12),
  };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (search.failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  host.server.closeAllConnections();
  await new Promise((resolve) => host.server.close(resolve));
}
