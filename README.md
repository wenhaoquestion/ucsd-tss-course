# Quarterplan

[Open Quarterplan](https://wenhaoquestion.github.io/ucsd-tss-course/) to build a Winter 2027 UC San Diego schedule. The planner works without an account in English and Simplified Chinese.

Pick a lecture or discussion, compare instructors’ historical grades, inspect a walk between classes and compare alternative packages. Search by course, instructor, printed package code or section ID. Finish booking in the official TSS window. Your plans, PDF imports, commitments and appointments stay on your device. A shared link contains the term and selected packages.

## Start locally

Use Node 22 and npm. From the project root:

```sh
npm ci
npm run dev
```

For a production build and tests:

```sh
npm test
npm run build
npm run preview
```

Browser tests exercise the production build under the same repository subpath used by Pages. Install Playwright Chromium with `npx playwright install chromium`, then run `npx playwright test`. You can also set `PW_CHROMIUM_EXECUTABLE_PATH` to an installed Chromium-family browser.

## GitHub Pages

In Settings → Pages, choose **GitHub Actions** as the source. Pushing to `main` runs the tests and deploys the contents of `dist`. Use **Actions → Deploy Quarterplan to GitHub Pages → Run workflow** to redeploy. No hosting credentials are required for the static planner.

The separate **Public seat observations** workflow reads the anonymous catalog hourly and writes observations to `public-data`. The page fetches the shards for the displayed or watched sections and falls back to the dated bundled snapshot. Rereading a count does not establish when the university recounted it. For a fork, set the `VITE_OBSERVATIONS_URL` Actions variable to your own `https://raw.githubusercontent.com/OWNER/REPO/public-data/WI27/`.

A local watch checks thresholds while the page is open. Background browser push needs the optional Go service, PostgreSQL and VAPID keys. Deploy the service behind HTTPS, set its allowed origin to your Pages origin, set the Pages workflow variable `VITE_API_BASE_URL` to the service URL and redeploy. Subscription endpoints and delivery keys stay in the service database. [Backend setup and API](server/README.md)

## Data and coverage

- UCSD’s public WI27 catalog provides courses, package membership, seats and meeting times. Exact room matches supplement the public catalog. For a verified booking link the button opens the official course page. Otherwise it opens TSS and copies the section identifier. The student confirms Book/Save in TSS.
- CAPE contains 61,791 historical records from SU07 through WI23. The planner exposes reported actual and expected GPA separately. It averages valid records equally and includes their count. Recent grade and SET archives are linked. Historical seats ship as sampled WI24 and WI25 records; open a series to see its actual coverage.
- The map uses a versioned campus pedestrian graph. Walking time includes a configurable pace and room buffer. Route verification compares 28 building pairs with another pedestrian routing engine. Indoor timing, construction and step-free access can require independent confirmation.
- The `starter.json` selection is an editable example made from real WI27 data. The first visit loads the remaining catalog in the background. Choose **Plan B** for an empty plan. The service worker caches the course directory and saves previously opened data on the device.

[Data sources, reuse notices and refresh commands](public/data/SOURCES.md) · [Map sources](public/data/routes-sources.txt) · [Walking verification](public/data/routes-verification.json) · [Official academic calendar](https://blink.ucsd.edu/instructors/resources/academic/calendars/2026.html)

## 中文

网页首版面向 UCSD 2027 冬季学期。选择课程后可查看教师历史给分、每周学习时长、候补和余位，点击两节课之间的空档即可查看校园实际步道与换楼缓冲。导入 PDF 后先核对班次，自选方案支持本机保存、跨设备链接和日历导出。

GitHub Pages 承载静态工作台，独立的 GitHub Actions 工作流按小时更新余位。浏览器内提醒在页面打开时检查；关闭网页后的推送由单独部署的 Go 服务提供。正式选课由学生在 TSS 确认。
