import { useEffect, useRef, useState } from "react";
import {
  X,
  Download,
  Share2,
  FileUp,
  Plus,
  Trash2,
  ChevronRight,
  WandSparkles,
  CalendarClock,
  ArrowUpRight,
} from "lucide-react";
import {
  type T,
  type Course,
  type Entry,
  type Selection,
  clock,
  parseClock,
  weekdays,
  dayZh,
  place,
  officialTSS,
  trustedBooking,
} from "./model";
import { type Saved, shareUrl } from "./store";
import { makeIcs } from "./calendar";
import type { SolveResult } from "./solver";
export async function copyText(value: string) {
  if (navigator.clipboard && window.isSecureContext)
    return navigator.clipboard.writeText(value);
  const i = document.createElement("textarea");
  i.value = value;
  document.body.append(i);
  i.select();
  const ok = document.execCommand("copy");
  i.remove();
  if (!ok) throw Error("clipboard");
}
export function Dialog({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const r = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = r.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={r}
      className={`dialog ${className}`}
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === r.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <header>
          <h2>{title}</h2>
          <button
            className="icon-btn"
            aria-label="Close / 关闭"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
type Props = {
  t: T;
  s: Saved;
  update: (fn: (v: Saved) => Saved) => void;
  tab: "generate" | "tools" | "booking";
  plan: Entry[];
  courses: Course[];
  onClose: () => void;
  apply: (ss: Selection[]) => void;
  notify: (text: string) => void;
  book: (e: Entry) => void;
};
export function ToolPanel({
  t,
  s,
  update,
  tab,
  plan,
  courses,
  onClose,
  apply,
  notify,
  book,
}: Props) {
  const [running, setRunning] = useState(false),
    [results, setResults] = useState<SolveResult | null>(null),
    [day, setDay] = useState(1),
    [bstart, setBstart] = useState("12:00"),
    [bend, setBend] = useState("13:00"),
    [imports, setImports] = useState<Selection[] | null>(null),
    [include, setInclude] = useState<Set<string>>(new Set()),
    [error, setError] = useState("");
  const work = useRef<Worker | null>(null),
    file = useRef<HTMLInputElement>(null);
  useEffect(() => () => work.current?.terminate(), []);
  const pref = <K extends keyof Saved["prefs"]>(
    key: K,
    value: Saved["prefs"][K],
  ) => {
    setResults(null);
    update((v) => ({ ...v, prefs: { ...v.prefs, [key]: value } }));
  };
  function generate() {
    setError("");
    setRunning(true);
    setResults(null);
    work.current?.terminate();
    const w = new Worker(new URL("./solver.worker.ts", import.meta.url), {
      type: "module",
    });
    work.current = w;
    w.onmessage = (e) => {
      setRunning(false);
      if (e.data.error)
        setError(t("Search failed. Please try again.", "计算失败，请重试。"));
      else setResults(e.data.result);
      w.terminate();
    };
    w.onerror = () => {
      setRunning(false);
      setError(t("Schedule search is unavailable.", "排课计算暂不可用。"));
      w.terminate();
    };
    w.postMessage({
      courses: plan.map((e) => e.course),
      current: s.plans[s.active],
      prefs: s.prefs,
    });
  }
  async function readFile(f: File) {
    setError("");
    setRunning(true);
    try {
      const found = await (await import("./pdf")).importPdf(f, courses);
      setImports(found);
      setInclude(new Set(found.map((x) => x.code)));
      if (!found.length)
        setError(
          t(
            "No unambiguous WI27 sections were recognized. Search the section IDs manually.",
            "没有识别到唯一匹配的 WI27 班次，可手动搜索班号。",
          ),
        );
    } catch {
      setError(
        t(
          "This PDF could not be read. Use an unencrypted TSS export under 20 MB.",
          "无法读取 PDF，请使用小于 20 MB 的未加密 TSS 导出文件。",
        ),
      );
    } finally {
      setRunning(false);
    }
  }
  function exportIcs() {
    const url = URL.createObjectURL(
      new Blob([makeIcs(plan)], { type: "text/calendar;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "Quarterplan-WI27.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Dialog
      title={
        tab === "generate"
          ? t("Generate schedules", "自动排课")
          : tab === "booking"
            ? t("Booking checklist", "选课清单")
            : t("Plan tools", "课表工具")
      }
      onClose={onClose}
    >
      {tab === "generate" ? (
        <>
          <p className="intro">
            {t(
              "Compare combinations of the courses in this plan.",
              "比较当前课表中各门课的合法班次组合。",
            )}
          </p>
          <div className="form-grid">
            <label>
              {t("Earliest class", "最早上课")}
              <input
                type="time"
                value={clock(s.prefs.early)}
                onChange={(e) => pref("early", parseClock(e.target.value) || 0)}
              />
            </label>
            <label>
              {t("Min. gap (min)", "最少课间（分钟）")}
              <input
                type="number"
                min="0"
                max="120"
                value={s.prefs.minGap}
                onChange={(e) =>
                  pref("minGap", Math.min(120, Math.max(0, +e.target.value)))
                }
              />
            </label>
            <label>
              {t("Walk speed (m/min)", "步速（米/分钟）")}
              <input
                type="number"
                min="20"
                max="160"
                value={s.prefs.speed}
                onChange={(e) =>
                  pref("speed", Math.max(20, Math.min(160, +e.target.value)))
                }
              />
            </label>
            <label>
              {t("Room buffer (min)", "教室缓冲（分钟）")}
              <input
                type="number"
                min="0"
                max="30"
                value={s.prefs.buffer}
                onChange={(e) =>
                  pref("buffer", Math.max(0, Math.min(30, +e.target.value)))
                }
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={s.prefs.stepFree}
              onChange={(e) => pref("stepFree", e.target.checked)}
            />
            {t("Step-free routes", "无台阶路线")}
          </label>
          <h3>{t("Course constraints", "锁定班次或教师")}</h3>
          {plan.map(({ course }) => (
            <div className="constraint-row" key={course.code}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.prefs.locked.includes(course.code)}
                  onChange={(e) =>
                    pref(
                      "locked",
                      e.target.checked
                        ? [...s.prefs.locked, course.code]
                        : s.prefs.locked.filter((v) => v !== course.code),
                    )
                  }
                />
                {course.code}
              </label>
              <select
                aria-label={course.code + " instructor"}
                value={s.prefs.teachers[course.code] || ""}
                onChange={(e) =>
                  pref("teachers", {
                    ...s.prefs.teachers,
                    [course.code]: e.target.value,
                  })
                }
              >
                <option value="">{t("Any instructor", "任何教师")}</option>
                {Array.from(
                  new Set(
                    course.options.map((o) => o.instructor).filter(Boolean),
                  ),
                ).map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </div>
          ))}
          <h3>{t("Blocked time", "不可用时段")}</h3>
          {s.prefs.busy.map((b, i) => (
            <div className="constraint-row" key={i}>
              <span>
                {weekdays[b.day - 1]} · {clock(b.start)}–{clock(b.end)}
              </span>
              <button
                className="icon-btn"
                onClick={() =>
                  pref(
                    "busy",
                    s.prefs.busy.filter((_, j) => j !== i),
                  )
                }
                aria-label={t("Remove time", "删除时段")}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="busy-row">
            <select
              aria-label="Day"
              value={day}
              onChange={(e) => setDay(+e.target.value)}
            >
              {weekdays.map((d, i) => (
                <option value={i + 1} key={d}>
                  {s.lang === "zh" ? "周" + dayZh[i] : d}
                </option>
              ))}
            </select>
            <input
              aria-label="From"
              type="time"
              value={bstart}
              onChange={(e) => setBstart(e.target.value)}
            />
            <input
              aria-label="Until"
              type="time"
              value={bend}
              onChange={(e) => setBend(e.target.value)}
            />
            <button
              className="icon-btn"
              disabled={bend <= bstart}
              onClick={() =>
                pref("busy", [
                  ...s.prefs.busy,
                  { day, start: parseClock(bstart), end: parseClock(bend) },
                ])
              }
              aria-label={t("Add blocked time", "添加不可用时段")}
            >
              <Plus size={16} />
            </button>
          </div>
          <button
            className="primary wide"
            disabled={running || !plan.length}
            onClick={generate}
          >
            <WandSparkles size={16} />
            {running
              ? t("Comparing…", "计算中…")
              : t("Find schedules", "生成课表")}
          </button>
          {results && (
            <div className="solutions">
              {results.plans.length ? (
                <h3>
                  {t("Possible schedules", "可选方案")} · {results.plans.length}
                </h3>
              ) : (
                <p>
                  {t(
                    "No match in this search. Try unlocking a section or relaxing a time limit.",
                    "未找到方案，可以解锁班次或放宽时段限制。",
                  )}{" "}
                  {results.limited
                    ? t("Search limit reached.", "已达搜索上限。")
                    : ""}{" "}
                  {results.reason.join(", ")}
                </p>
              )}
              {results.plans.map((p, i) => (
                <button
                  key={i}
                  onClick={() => {
                    apply(p.picks);
                    onClose();
                  }}
                >
                  <span>
                    <b>
                      {t("Option", "方案")} {i + 1} ·{" "}
                      {i === 0
                        ? t("Fewest campus days", "尽量减少到校天数")
                        : p.walk === 0
                          ? t("No predicted late walks", "无预计迟到的课间")
                          : t("Alternative combination", "备选组合")}
                    </b>
                    <small>
                      {p.days} {t("campus days", "天到校")} · {p.moves}{" "}
                      {t("changes", "处变动")} · {p.walk}{" "}
                      {t("min tight-walk shortfall", "分钟紧张通勤缺口")}
                      {p.unknown > 0 ? " · " + p.unknown + " TBA" : ""}
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          )}
        </>
      ) : tab === "tools" ? (
        <>
          <div className="tool-list">
            <button onClick={exportIcs}>
              <Download />
              {t("Export calendar (.ics)", "导出日历 (.ics)")}
              <ChevronRight />
            </button>
            <button
              onClick={() =>
                copyText(shareUrl(s.plans[s.active]))
                  .then(() => notify(t("Share link copied", "已复制分享链接")))
                  .catch(() => setError(t("Copy unavailable", "无法复制")))
              }
            >
              <Share2 />
              {t("Copy share link", "复制分享链接")}
              <ChevronRight />
            </button>
            <button disabled={running} onClick={() => file.current?.click()}>
              <FileUp />
              {t("Import TSS schedule PDF", "导入 TSS 课表 PDF")}
              <ChevronRight />
            </button>
          </div>
          <small>
            {t(
              "PDF files are read on this device. Shared links contain the term and section choices.",
              "PDF 在本机读取。分享链接仅包含学期与班次。",
            )}
          </small>
          <input
            type="file"
            accept="application/pdf"
            hidden
            ref={file}
            onChange={(e) => {
              if (e.target.files?.[0]) readFile(e.target.files[0]);
            }}
          />
          {imports && imports.length > 0 && (
            <>
              <h3>{t("Review matched sections", "核对匹配班次")}</h3>
              {imports.map((x) => (
                <label className="check" key={x.code}>
                  <input
                    type="checkbox"
                    checked={include.has(x.code)}
                    onChange={(e) => {
                      const n = new Set(include);
                      if (e.target.checked) n.add(x.code);
                      else n.delete(x.code);
                      setInclude(n);
                    }}
                  />
                  {x.code} · {x.id}
                </label>
              ))}
              <button
                className="primary"
                onClick={() => {
                  const merged = new Map(
                    s.plans[s.active].map((x) => [x.code, x]),
                  );
                  imports
                    .filter((x) => include.has(x.code))
                    .forEach((x) => merged.set(x.code, x));
                  apply([...merged.values()]);
                  onClose();
                }}
              >
                {t("Add reviewed sections", "加入已核对班次")}
              </button>
            </>
          )}
          <div className="source-mini">
            <h3>{t("Data sources", "数据来源")}</h3>
            <a
              href="https://classplanner.apps.ucsd.edu/search"
              target="_blank"
              rel="noreferrer"
            >
              UCSD Class Planner ↗
            </a>
            <a
              href="https://github.com/UCSD-Historical-Enrollment-Data/UCSDHistEnrollData"
              target="_blank"
              rel="noreferrer"
            >
              UCSD Historical Enrollment Data ↗
            </a>
            <a
              href="https://github.com/wenhaoquestion/ucsd-classrooms"
              target="_blank"
              rel="noreferrer"
            >
              UCSD Classroom Explorer ↗
            </a>
            <a
              href="https://blink.ucsd.edu/instructors/resources/academic/calendars/2026.html"
              target="_blank"
              rel="noreferrer"
            >
              UCSD Academic Calendar ↗
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="intro">
            {t(
              "Enter the appointments shown in TSS, in San Diego time. Keep one TSS tab open and confirm Book/Save there.",
              "按圣迭戈时间填写 TSS 中的个人预约时间。请只打开一个 TSS 标签，并在其中确认 Book/Save。",
            )}
          </p>
          <div className="form-grid">
            {(["first", "second"] as const).map((k) => (
              <label key={k}>
                {k === "first" ? "First Pass" : "Second Pass"}
                <input
                  type="datetime-local"
                  value={s[k]}
                  onChange={(e) =>
                    update((v) => ({ ...v, [k]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>
          <h3>
            <CalendarClock size={16} /> {t("Booking order", "选课顺序")}
          </h3>
          {plan.map(({ course, option }, i) => (
            <div className="booking-row" key={course.code}>
              <div>
                <b>
                  {i + 1}. {course.code}
                </b>
                <small>
                  {course.units} {t("units", "学分")} · {option.sectionId} ·{" "}
                  {Array.from(new Set(option.meetings.map((m) => m.type))).join(
                    " + ",
                  )}
                </small>
                {course.restrictions && <small>{course.restrictions}</small>}
              </div>
              <button
                className="outline"
                onClick={() => book({ course, option })}
              >
                {trustedBooking(option) === officialTSS && option.sectionId
                  ? t("Copy ID & open TSS", "复制班号并前往 TSS")
                  : t("Open TSS", "前往 TSS")}
                <ArrowUpRight size={14} />
              </button>
            </div>
          ))}
          <a
            href="https://students.ucsd.edu/my-tritonlink/tools/tool-help/booking.html"
            target="_blank"
            rel="noreferrer"
          >
            {t("Official booking and eligibility guide", "官方选课与资格说明")}{" "}
            ↗
          </a>
        </>
      )}
      {error && (
        <p role="alert" className="note error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
