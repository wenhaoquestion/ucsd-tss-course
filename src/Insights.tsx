import { useState, useEffect } from "react";
import { ChevronDown, ArrowUpRight, TrendingUp, BarChart3 } from "lucide-react";
import { loadHistory, loadGrades, dataset } from "./data";
import type { Entry, T, Grade, Series, Point } from "./model";
import { recentHistory } from "./observations";
import { PassChart } from "./PassChart";
function mean(
  rows: Grade[],
  key: "actual" | "expected" | "hours" | "recommend",
) {
  const nums = rows
    .map((r) => r[key])
    .filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  return nums.length
    ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(
        key === "recommend" ? 0 : 2,
      )
    : "—";
}
const ordinal = (s: string) =>
  Number(s.slice(2)) * 10 +
  (["WI", "SP", "S1", "S2", "SU", "FA"].indexOf(s.slice(0, 2)) + 1);
function HistChart({
  series,
  t,
  aligned,
}: {
  series: Series;
  t: T;
  aligned: boolean;
}) {
  const points = series.points
    .filter((p) => p.available !== null && Number.isFinite(Date.parse(p.at)))
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const [active, setActive] = useState<number | null>(null);
  if (!points.length)
    return (
      <p className="note">{t("No seat observations.", "没有座位观测。")}</p>
    );
  const t0 = Date.parse(points[0].at),
    t1 = Date.parse(points.at(-1)!.at),
    max = Math.max(1, ...points.map((p) => p.available!)),
    xs = (p: Point) =>
      4 + ((Date.parse(p.at) - t0) / Math.max(1, t1 - t0)) * 272,
    ys = (p: Point) => 62 - (54 * p.available!) / max;
  const delta = points
      .slice(1)
      .map((p, i) => Date.parse(p.at) - Date.parse(points[i].at))
      .sort((a, b) => a - b),
    gap = Math.max(
      36 * 3600000,
      3 * (delta[Math.floor(delta.length / 2)] || 0),
    );
  const paths: string[] = [];
  let prev = 0;
  for (const p of points) {
    const time = Date.parse(p.at);
    if (!paths.length || time - prev > gap)
      paths.push("M" + xs(p) + " " + ys(p));
    else paths[paths.length - 1] += " L" + xs(p) + " " + ys(p);
    prev = time;
  }
  const format = (at: string) =>
    aligned && series.firstPass
      ? "D" +
        Math.round((Date.parse(at) - Date.parse(series.firstPass)) / 86400000)
      : new Date(at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "America/Los_Angeles",
        });
  const selected =
    points[Math.min(active ?? points.length - 1, points.length - 1)];
  return (
    <>
      <svg
        role="img"
        aria-label={t("Observed seats, chronological", "按观测时间排列的余位")}
        viewBox="0 0 282 70"
        className="history-chart"
      >
        <path d="M2 62H280M2 36H280M2 9H280" className="chart-grid" />
        {paths.map((p, i) => (
          <path d={p} key={i} className="chart-line" />
        ))}
        <circle
          cx={xs(selected)}
          cy={ys(selected)}
          r="3"
          fill="var(--accent)"
        />
      </svg>
      <div className="chart-dates">
        <span>{format(points[0].at)}</span>
        <span>{format(points.at(-1)!.at)}</span>
      </div>
      <input
        className="scrubber"
        type="range"
        aria-label={t("Inspect seat observation", "查看余位记录")}
        min="0"
        max={points.length - 1}
        value={active ?? points.length - 1}
        onChange={(e) => setActive(+e.target.value)}
      />
      <small>
        {format(selected.at)} · {selected.available} {t("open", "余位")} ·{" "}
        {selected.waitlist ?? "—"} {t("waiting", "候补")} ·{" "}
        {selected.capacity ?? "—"} {t("capacity", "容量")}
      </small>
    </>
  );
}
export function Insights({
  entry,
  t,
  which,
}: {
  entry: Entry;
  t: T;
  which?: "grades" | "seats" | null;
}) {
  const [open, setOpen] = useState<"grades" | "seats" | null>(which ?? null),
    [grades, setGrades] = useState<Grade[] | null>(null),
    [series, setSeries] = useState<Series[] | null>(null),
    [pick, setPick] = useState(0),
    [aligned, setAligned] = useState(false),
    [who, setWho] = useState(""),
    [allTeaching, setAllTeaching] = useState<string[]>([]),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    setOpen(which ?? null);
  }, [which]);
  useEffect(() => {
    setPick(0);
    setGrades(null);
    setSeries(null);
    setWho("");
    setAllTeaching([]);
    setFailed(false);
  }, [entry.course.code, entry.option.id]);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    if (open === "grades")
      loadGrades(entry.course.code)
        .then((v) => alive && setGrades(v))
        .catch(() => {
          if (alive) {
            setGrades([]);
            setFailed(true);
          }
        });
    if (open === "seats")
      Promise.all([
        loadHistory(entry.course.code).catch(() => [] as Series[]),
        recentHistory(entry.option.sectionId).then((points) =>
          points.length
            ? [{ term: "WI27", section: entry.option.sectionId, points }]
            : [],
        ),
      ]).then(([hist, live]) => {
        if (alive) setSeries([...live, ...hist]);
      });
    return () => {
      alive = false;
    };
  }, [open, entry.course.code, entry.option.sectionId]);
  const gradeRows = grades || [],
    teachers = [...new Set(gradeRows.map((r) => r.instructor))],
    filtered = who ? gradeRows.filter((r) => r.instructor === who) : gradeRows;
  async function otherCourses() {
    if (!who) return;
    setAllTeaching([t("Loading…", "加载中…")]);
    try {
      const all = await dataset<Record<string, string[]>>(
        "grades/instructors.json",
      );
      setAllTeaching(all[who] || []);
    } catch {
      setAllTeaching([t("Index unavailable", "索引暂不可用")]);
    }
  }
  return (
    <div className="insights">
      {(["grades", "seats"] as const).map((k) => (
        <div className="insight" key={k}>
          <button
            className="accordion"
            aria-expanded={open === k}
            onClick={() => setOpen(open === k ? null : k)}
          >
            {k === "grades" ? (
              <BarChart3 size={17} />
            ) : (
              <TrendingUp size={17} />
            )}
            <strong>
              {k === "grades"
                ? t("Grade history", "历史给分")
                : t("Seat history", "历史余位")}
            </strong>
            <ChevronDown size={16} className={open === k ? "flipped" : ""} />
          </button>
          {open === k && (
            <div className="accordion-body">
              {k === "grades" ? (
                <>
                  {grades === null ? (
                    <p>{t("Loading…", "加载中…")}</p>
                  ) : gradeRows.length ? (
                    <>
                      <select
                        aria-label={t("Historical instructor", "历史教师")}
                        value={who}
                        onChange={(e) => {
                          setWho(e.target.value);
                          setAllTeaching([]);
                        }}
                      >
                        <option value="">
                          {t("All instructors", "全部教师")}
                        </option>
                        {teachers.map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                      <div className="stat-pair">
                        <div>
                          <b>{mean(filtered, "actual")}</b>
                          <span>{t("Actual GPA", "实际 GPA")}</span>
                        </div>
                        <div>
                          <b>{mean(filtered, "expected")}</b>
                          <span>{t("Expected GPA", "预期 GPA")}</span>
                        </div>
                      </div>
                      <small>
                        {t("Equal-weight records", "记录等权")} ·{" "}
                        {filtered.filter((r) => r.actual !== null).length}{" "}
                        {t("graded records", "条有效给分")} ·{" "}
                        {mean(filtered, "hours")}{" "}
                        {t("study hrs/wk", "学习小时/周")}
                      </small>
                      {!who ? (
                        <div className="teacher-table">
                          <table>
                            <thead>
                              <tr>
                                <th>{t("Instructor", "教师")}</th>
                                <th>GPA</th>
                                <th>{t("Records", "记录")}</th>
                                <th>{t("Last", "最近")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {teachers.map((n) => {
                                const rows = gradeRows.filter(
                                  (r) => r.instructor === n,
                                );
                                return (
                                  <tr key={n}>
                                    <td>
                                      <button onClick={() => setWho(n)}>
                                        {n}
                                      </button>
                                    </td>
                                    <td>{mean(rows, "actual")}</td>
                                    <td>{rows.length}</td>
                                    <td>
                                      {
                                        rows
                                          .slice()
                                          .sort(
                                            (a, b) =>
                                              ordinal(b.term) - ordinal(a.term),
                                          )[0].term
                                      }
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <>
                          <small>
                            {t("Recommended instructor", "推荐教师")}{" "}
                            {mean(filtered, "recommend")}% ·{" "}
                            {filtered.reduce(
                              (s, r) => s + (r.responses || 0),
                              0,
                            )}{" "}
                            {t("survey responses", "份问卷")}
                          </small>
                          <div className="teacher-table">
                            <table>
                              <tbody>
                                {filtered
                                  .slice()
                                  .sort(
                                    (a, b) => ordinal(b.term) - ordinal(a.term),
                                  )
                                  .map((r, i) => (
                                    <tr key={i}>
                                      <td>{r.term}</td>
                                      <td>{r.actual?.toFixed(2) ?? "—"}</td>
                                      <td>{r.hours ?? "—"} h</td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                          <button
                            className="text-action"
                            onClick={otherCourses}
                          >
                            {t("Other courses taught", "查看该教师所授课程")}
                          </button>
                          {allTeaching.length > 0 && (
                            <p>{allTeaching.join(" · ")}</p>
                          )}
                        </>
                      )}
                      <small>CAPE · SU07–WI23</small>
                    </>
                  ) : (
                    <p>
                      {failed
                        ? t(
                            "Grade data unavailable for this subject.",
                            "该学科数据暂不可用。",
                          )
                        : t(
                            "No archived grade records for this course.",
                            "该课程暂无历史给分记录。",
                          )}
                    </p>
                  )}
                  <div className="links">
                    <a
                      href="https://myclassgrades.com/school/ucsd/overview"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("Recent grades", "近年成绩")}{" "}
                      <ArrowUpRight size={12} />
                    </a>
                    <a
                      href="https://set.ucsd.edu/student/evaluation-results.html"
                      target="_blank"
                      rel="noreferrer"
                    >
                      SET / CAPE <ArrowUpRight size={12} />
                    </a>
                  </div>
                </>
              ) : (
                <>
                  {series === null ? (
                    <p>{t("Loading…", "加载中…")}</p>
                  ) : series.length ? (
                    <>
                      <select
                        aria-label={t("Historical series", "历史序列")}
                        value={pick}
                        onChange={(e) => setPick(+e.target.value)}
                      >
                        {series.map((s, i) => (
                          <option key={i} value={i}>
                            {s.term} ·{" "}
                            {s.section || t("Course total", "课程合计")}
                          </option>
                        ))}
                      </select>
                      {series[pick]?.firstPass && (
                        <label>
                          <input
                            type="checkbox"
                            checked={aligned}
                            onChange={(e) => setAligned(e.target.checked)}
                          />
                          {t("Days from First Pass", "距 First Pass 天数")}
                        </label>
                      )}
                      {aligned && series[pick] && (
                        <PassChart
                          t={t}
                          series={series.filter(
                            (s) => s.section === series[pick].section,
                          )}
                        />
                      )}
                      {series[pick] && (
                        <HistChart
                          key={entry.course.code + pick}
                          series={series[pick]}
                          t={t}
                          aligned={aligned}
                        />
                      )}
                    </>
                  ) : (
                    <p>
                      {t(
                        "No archived seat observations for this course.",
                        "此课程暂无历史余位记录。",
                      )}
                    </p>
                  )}
                  <a
                    href="https://github.com/UCSD-Historical-Enrollment-Data/UCSDHistEnrollData"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("Archive & coverage", "数据归档与覆盖范围")}{" "}
                    <ArrowUpRight size={12} />
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
