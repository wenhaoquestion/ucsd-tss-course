import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Weekly calendar" }),
  ).toBeVisible();
  await expect(page.locator(".qp-route-map")).toBeVisible();
  await page.screenshot({
    path: join(
      process.env.QP_SCREENSHOTS || tmpdir(),
      "quarterplan-desktop.png",
    ),
    fullPage: true,
  });
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
  await page.getByRole("button", { name: "Open TSS", exact: true }).click();
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
  await page.getByRole("button", { name: "Search courses" }).click();
  const search = page.getByPlaceholder("Course, instructor or section ID");
  await search.fill("CSE100");
  await page
    .locator(".search-results button")
    .filter({ has: page.getByText("CSE 100", { exact: true }) })
    .click();
  await page.getByRole("button", { name: "Use this section" }).click();
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
  await expect(page.getByRole("heading", { name: "每周课表" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "每周课表" })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "每周课表" })).toBeVisible();
  await expect(page.locator(".course-list")).toContainText("CSE 100");
});
test("mobile fits without page-level overflow and provides daily classes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
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
