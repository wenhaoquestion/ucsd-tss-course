import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Load known real sections explicitly for tests that start with a schedule.
const sharedSchedule = new URLSearchParams({
  term: "WI27",
  plan: JSON.stringify([
    ["CSE 12", "WI27:165078"],
    ["MATH 20C", "WI27:163118"],
    ["PSYC 1", "WI27:163966"],
  ]),
});

test.beforeEach(async ({ context }) => {
  await context.route("https://raw.githubusercontent.com/**", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
});
test("a student compares grades and walks, switches a package, then opens the correct TSS page", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const layouts =
    "https://wenhaoquestion.github.io/ucsd-classrooms/indoor/layouts/";
  const crossOrigin = { "Access-Control-Allow-Origin": "*" };
  await page.route(layouts + "index.json", (route) =>
    route.fulfill({
      headers: crossOrigin,
      json: { schemaVersion: 1, buildings: ["WLH"] },
    }),
  );
  await page.route(layouts + "WLH.json", (route) =>
    route.fulfill({
      headers: crossOrigin,
      json: {
        schemaVersion: 1,
        building: "WLH",
        name: "Warren Lecture Hall",
        geometryStatus: "facilities-plan",
        floors: [
          {
            id: "level-2",
            label: "Level 2",
            shortLabel: "2",
            outline: [
              {
                outer: [
                  [0, 0],
                  [20, 0],
                  [20, 10],
                  [0, 10],
                ],
              },
            ],
            rooms: [
              {
                id: "2001",
                label: "2001",
                scheduleKey: "2001",
                footprint: {
                  outer: [
                    [2, 2],
                    [9, 2],
                    [9, 8],
                    [2, 8],
                  ],
                },
              },
            ],
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto(`./?${sharedSchedule}`);
  await expect(page.locator(".calendar-grid .event").first()).toBeVisible();
  await expect(page.locator(".qp-route-map")).toBeVisible();
  await expect(page).toHaveURL((url) => !url.searchParams.has("plan"));
  await page.screenshot({
    path: join(
      process.env.QP_SCREENSHOTS || tmpdir(),
      "quarterplan-desktop.png",
    ),
    fullPage: true,
  });
  const plannerUrl = page.url();
  await page.getByRole("button", { name: "WLH 2001", exact: true }).click();
  const classroom = page.getByRole("dialog", { name: "WLH 2001" });
  await expect(classroom).toBeVisible();
  await expect(
    classroom.getByRole("region", { name: "Classroom location for WLH 2001" }),
  ).toBeVisible();
  await classroom
    .getByRole("button", { name: "Floor plan", exact: true })
    .click();
  await expect(
    classroom.getByRole("img", { name: "WLH 2001 floor plan · Level 2" }),
  ).toBeVisible();
  await expect(classroom.locator(".qp-room-highlight")).toBeAttached();
  await classroom.getByRole("button", { name: "Campus", exact: true }).click();
  await expect(
    classroom.getByRole("img", { name: "Campus map for WLH 2001" }),
  ).toBeVisible();
  await expect(page).toHaveURL(plannerUrl);
  expect(page.context().pages()).toHaveLength(1);
  await classroom.getByRole("button", { name: "Close / 关闭" }).click();
  await page.getByRole("button", { name: "Grade history" }).click();
  await expect(page.getByText("Actual GPA", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Seat history" }).click();
  await expect(
    page.getByRole("combobox", { name: "Historical series" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Compare alternatives" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator(".alt-row").first().click();
  await expect(
    page.getByRole("heading", { name: "Course details" }),
  ).toBeVisible();
  const expected = await page.locator(".course-code").innerText();
  expect(expected).toBe("MATH 20C");
  await page
    .context()
    .route("https://tss.ucsd.edu/**", (r) =>
      r.fulfill({ body: "Official handoff test" }),
    );
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: /open tss/i }).click();
  const next = await popup;
  await next.waitForLoadState();
  expect(new URL(next.url()).hostname).toBe("tss.ucsd.edu");
  await next.close();
  await page.getByRole("button", { name: "Watch section" }).click();
  await page.getByRole("button", { name: "Watch while open" }).click();
  await page.getByRole("button", { name: /^Watchlist/ }).click();
  await expect(page.getByText("MATH 20C", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /^Watchlist/ }).click();
  await expect(page.getByText("MATH 20C", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("search, worker suggestions, language switch, export and offline restoration", async ({
  page,
  context,
}) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Build your schedule" }),
  ).toBeVisible();
  await expect(page.locator(".calendar-grid .event")).toHaveCount(0);
  await expect(page.locator(".course-list .course-row")).toHaveCount(0);
  await page.screenshot({
    path: join(
      process.env.QP_SCREENSHOTS || tmpdir(),
      "quarterplan-empty-desktop.png",
    ),
  });
  const searchInput = page.getByPlaceholder("Course, instructor or section ID");
  if (!(await searchInput.first().isVisible())) {
    await page
      .getByRole("button", { name: "Find a course", exact: true })
      .click();
  }
  const search = searchInput.filter({ visible: true }).first();
  await search.fill("CSE100");
  await page
    .locator(".search-results button")
    .filter({ has: page.getByText("CSE 100", { exact: true }) })
    .click();
  await page.getByRole("button", { name: "Use this section" }).click();
  await expect(page.locator(".calendar-grid .event").first()).toBeAttached();
  await page.getByRole("button", { name: "Generate schedules" }).click();
  await page.getByRole("button", { name: "Find schedules" }).click();
  await expect(page.locator(".solutions")).toBeVisible();
  await page.getByRole("button", { name: "Close / 关闭" }).click();
  await page.getByRole("button", { name: "Plan tools" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export calendar (.ics)" }).click();
  expect((await download).suggestedFilename()).toMatch(/ics$/);
  await page.getByRole("button", { name: "Close / 关闭" }).click();
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".course-list")).toContainText("CSE 100");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".course-list")).toContainText("CSE 100");
});

test.describe("first visit in Chinese", () => {
  test.use({ locale: "zh-CN", viewport: { width: 390, height: 844 } });
  test("both plans are empty", async ({ page }) => {
    await page.goto("./");
    await expect(page.getByRole("heading", { name: "开始排课" })).toBeVisible();
    await expect(page.locator(".calendar-grid .event")).toHaveCount(0);
    await page.getByRole("combobox", { name: "当前课表" }).selectOption("1");
    await expect(page.getByRole("heading", { name: "开始排课" })).toBeVisible();
    await expect(page.locator(".course-list .course-row")).toHaveCount(0);
    await page.screenshot({
      path: join(
        process.env.QP_SCREENSHOTS || tmpdir(),
        "quarterplan-empty-mobile.png",
      ),
    });
  });
});
test("mobile fits without page-level overflow and provides daily classes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`./?${sharedSchedule}`);
  await expect(page.locator(".qp-route-map")).toBeVisible();
  await page
    .locator(".phone-days")
    .getByRole("button", { name: "Mon", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await expect(
    page.locator(".day-column.current .event").first(),
  ).toBeVisible();
  await page.screenshot({
    path: join(
      process.env.QP_SCREENSHOTS || tmpdir(),
      "quarterplan-mobile.png",
    ),
    fullPage: true,
  });
});
