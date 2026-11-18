import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createObservationReader } from "../src/observations";
import { readJson, requestAPI } from "../src/data";

const published = "https://data.test/WI27/";
const service = "https://api.test";
const bundled = "https://planner.test/data/seats.json";
const then = "2026-11-15T10:00:00Z",
  now = "2026-11-17T10:00:00Z",
  later = "2026-11-18T10:00:00Z";
const counts = (available: number | null) => ({
  available,
  capacity: 80,
  waitlist: 0,
});
const name = (type: string, k: string) =>
  type + "/" + k + "." + "a".repeat(24) + ".json";
const files = (k: string) => ({
  seats: name("seats", k),
  history: name("history", k),
});
const details = {
  term: "WI27",
  observedAt: now,
  shards: { "01": files("01"), "02": files("02"), "04": files("04") },
};
const a = "E 00101",
  b = "E 00201",
  c = "E 00302",
  d = "E 00403",
  e = "E 00504";

function reader(responses: Record<string, unknown>, api = "") {
  const seen: string[] = [];
  const read = async <T>(url: string) => {
    seen.push(url);
    await Promise.resolve();
    if (!(url in responses)) throw new Error("offline: " + url);
    return responses[url] as T;
  };
  return {
    ...createObservationReader({ published, service: api, bundled, read }),
    seen,
  };
}
test("partial sources merge per section, preserve null, provenance and freshest timestamp", async () => {
  const ids = [a, b, c, d, e];
  const apiPath =
    service + "/api/seats?term=WI27&ids=" + encodeURIComponent(ids.join(","));
  const r = reader(
    {
      [bundled]: {
        observedAt: then,
        seats: Object.fromEntries(ids.map((id) => [id, counts(7)])),
      },
      [published + "manifest.json"]: details,
      [published + files("01").seats]: {
        seats: { [a]: counts(0), [b]: counts(null) },
      },
      [published + files("02").seats]: { seats: {} },
      [apiPath]: {
        seats: {
          [a]: { ...counts(1), observedAt: then },
          [c]: { ...counts(6), observedAt: later },
        },
      },
    },
    service,
  );
  const result = await r.latestSeats([...ids, a]);
  assert.deepEqual(
    ids.map((id) => [
      result.seats[id].available,
      result.seats[id].source,
      result.seats[id].observedAt,
    ]),
    [
      [0, "published", now],
      [null, "published", now],
      [6, "api", later],
      [7, "bundled", then],
      [7, "bundled", then],
    ],
  );
  assert.equal(
    r.seen.filter((s) => s === published + files("01").seats).length,
    1,
  );
});
test("simultaneous calls share manifest, raw shards, bundled data and identical service lookups", async () => {
  const path =
    service +
    "/api/seats?term=WI27&ids=" +
    encodeURIComponent([a, b].join(","));
  const r = reader(
    {
      [bundled]: { observedAt: then, seats: {} },
      [published + "manifest.json"]: details,
      [published + files("01").seats]: { seats: { [a]: counts(2) } },
      [path]: { seats: {} },
    },
    service,
  );
  await Promise.all([r.latestSeats([a, b]), r.latestSeats([b, a])]);
  assert.equal(r.seen.length, 4);
  assert.equal(new Set(r.seen).size, 4);
  const before = r.seen.length;
  assert.deepEqual(await r.latestSeats([]), { seats: {} });
  assert.equal(r.seen.length, before);
});
test("an unavailable service keeps per-section last observation and a missing field remains unknown", async () => {
  const path = service + "/api/seats?term=WI27&ids=" + encodeURIComponent(a);
  const data: Record<string, unknown> = {
    [path]: { seats: { [a]: { ...counts(3), observedAt: now } } },
    [bundled]: { observedAt: then, seats: { [a]: counts(2) } },
  };
  const r = reader(data, service);
  await r.latestSeats([a]);
  delete data[path];
  assert.equal((await r.latestSeats([a])).seats[a].available, 3);
  assert.deepEqual((await r.latestSeats(["absent"])).seats, {});
});
test("history merges dates across feeds and includes the bundled observation when offline", async () => {
  const path =
    service + "/api/history?term=WI27&section=" + encodeURIComponent(a);
  const r = reader(
    {
      [bundled]: { observedAt: then, seats: { [a]: counts(1) } },
      [published + "manifest.json"]: details,
      [published + files("01").history]: {
        sections: {
          [a]: [
            { at: then, ...counts(1) },
            { at: now, ...counts(0) },
          ],
        },
      },
      [path]: {
        points: [
          { at: now, ...counts(2) },
          { at: later, ...counts(2) },
        ],
      },
    },
    service,
  );
  assert.deepEqual(
    (await r.recentHistory(a)).map((p) => [p.at, p.available]),
    [
      [then, 1],
      [now, 2],
    ],
  );
  const offline = reader({
    [bundled]: { observedAt: then, seats: { [a]: counts(1) } },
  });
  assert.deepEqual(
    (await offline.recentHistory(a)).map((p) => p.available),
    [1],
  );
});
test("raw text/plain parses, an empty 204 resolves, HTML errors and aborted requests reject", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init?: RequestInit) => {
      if (init?.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      if (path.endsWith("/watch/one"))
        return new Response(null, { status: 204 });
      if (path.endsWith("/404"))
        return new Response("<html>error</html>", {
          headers: { "Content-Type": "text/html" },
        });
      return new Response('{"seats":{}}', {
        headers: { "Content-Type": "text/plain" },
      });
    },
  );
  assert.deepEqual(await readJson("https://raw.test/seats.json"), {
    seats: {},
  });
  assert.equal(
    await requestAPI(service, "/watch/one", { method: "DELETE" }),
    undefined,
  );
  await assert.rejects(readJson("https://raw.test/404"), /HTML/);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    requestAPI(service, "/path", { signal: ctrl.signal }),
    /Aborted/,
  );
});
test("API timeout remains active when headers arrive but the response body stalls", async (t) => {
  const schedule = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (fn: Function, ms: number, ...args: unknown[]) =>
      schedule(fn as () => void, ms === 8000 ? 5 : ms, ...args),
  );
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener(
              "abort",
              () =>
                controller.error(new DOMException("Timed out", "AbortError")),
              { once: true },
            );
          },
        }),
      ),
  );
  await assert.rejects(requestAPI(service, "/api/history"), /Timed out/);
});
test("service worker retains a dated manifest and immutable shards for offline visits", async () => {
  const cache = new Map<string, Response>();
  const key = (request: Request | string) =>
    typeof request === "string" ? request : request.url;
  const storage = {
    match: async (req: Request) => cache.get(key(req))?.clone(),
    put: async (req: Request, res: Response) =>
      cache.set(key(req), res.clone()),
    keys: async () => [...cache.keys()].map((x) => new Request(x)),
  };
  const listeners = new Map<string, Function>();
  const urls: string[] = [];
  let offline = false,
    broken = false;
  const worker = await readFile(
    new URL("../scripts/offline-template.js", import.meta.url),
    "utf8",
  );
  runInNewContext(
    worker
      .replace('"__PRECACHE__"', "[]")
      .replace('"__OBSERVATIONS__"', JSON.stringify(published)),
    {
      self: {
        registration: { scope: "https://planner.test/app/" },
        addEventListener: (k: string, f: Function) => listeners.set(k, f),
      },
      caches: { open: async () => storage },
      URL,
      Request,
      Response,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: async (req: Request) => {
        urls.push(req.url);
        if (offline) throw Error("offline");
        return new Response(
          broken
            ? "invalid"
            : JSON.stringify(
                req.url.endsWith("manifest.json")
                  ? details
                  : { seats: { [a]: counts(3) } },
              ),
          { headers: { "content-type": "text/plain" } },
        );
      },
    },
  );
  const handle = async (path: string) => {
    let response: Promise<Response> | undefined;
    listeners.get("fetch")!({
      request: new Request(path),
      respondWith: (r: Promise<Response>) => {
        response = r;
      },
    });
    return response;
  };
  const manifestURL = published + "manifest.json",
    shardURL = published + files("01").seats;
  await handle(manifestURL);
  await handle(shardURL);
  broken = true;
  assert.deepEqual(await (await handle(manifestURL))!.json(), details);
  offline = true;
  assert.deepEqual(await (await handle(manifestURL))!.json(), details);
  assert.equal((await (await handle(shardURL))!.json()).seats[a].available, 3);
  assert.equal(urls.filter((u) => u === shardURL).length, 1);
  assert.equal(
    await handle("https://other.test/WI27/manifest.json"),
    undefined,
  );
  assert.equal(await handle("https://planner.test/app/api/watch"), undefined);
});
