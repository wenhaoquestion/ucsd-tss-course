import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  Footprints,
  Globe2,
  GraduationCap,
  Layers,
  MapPin,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  type Catalog,
  type Course,
  type Entry,
  type Lang,
  type Selection,
  type T,
  entries,
  norm,
  place,
  clock,
  trustedBooking,
  officialTSS,
  weekdays,
  dayZh,
} from "./model";
import { weekTiles, gaps, isFinal, timed, overlap, type Gap } from "./calendar";
import {
  canShowClassroom,
  estimateTransfer,
  listedRoom,
  locationCode,
  type TransferLocation,
} from "./routing";
import {
  loadCatalog,
  apiBase,
  enablePush,
  removeRemoteWatch,
  type Seat,
} from "./data";
import {
  initial,
  readSaved,
  writeSaved,
  readShare,
  type Saved,
  type Watch,
} from "./store";
import { CalendarView, colors } from "./CalendarView";
import { Insights } from "./Insights";
import { Dialog, ToolPanel, copyText } from "./ToolPanel";
import { latestSeats } from "./observations";
const RouteMap = lazy(() =>
  import("./routing/RouteMap").then((m) => ({ default: m.RouteMap })),
);
const ClassroomMap = lazy(() => import("./routing/ClassroomMap"));
type Mode =
  "generate" | "tools" | "booking" | "search" | "watch" | "alternatives" | null;
const unitsOf = (c: Course) => Number.parseFloat(c.units) || 0;
function when(stamp: string | null | undefined, lang: Lang) {
  if (!stamp) return "—";
  const d = new Date(stamp);
  return Number.isNaN(+d)
    ? "—"
    : d.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      }) + " PT";
}
function bestGap(plan: Entry[], prefs: Saved["prefs"]) {
  const list = gaps(weekTiles(plan)).filter(
    (g) => g.from.m.building !== g.to.m.building,
  );
  return (
    list
      .map((g) => ({
        g,
        r: estimateTransfer(g.from.m, g.to.m, g.minutes, {
          speedMPerMin: prefs.speed,
          bufferMinutes: prefs.buffer,
          stepFree: prefs.stepFree,
        }),
      }))
      .filter((x) => x.r.distanceMeters !== null)
      .sort(
        (a, b) =>
          Number(b.r.status !== "comfortable") -
            Number(a.r.status !== "comfortable") ||
          Math.abs(a.g.minutes - 10) - Math.abs(b.g.minutes - 10),
      )[0]?.g ?? null
  );
}
function compareChange(
  plan: Entry[],
  entry: Entry,
  option: Entry["option"],
  prefs: Saved["prefs"],
) {
  const others = plan.filter((e) => e.course.code !== entry.course.code),
    conflict = others.find((e) =>
      e.option.meetings.some((a) => option.meetings.some((b) => overlap(a, b))),
    );
  const walks = gaps(weekTiles([...others, { course: entry.course, option }]))
    .filter(
      (g) =>
        g.from.entry.course.code === entry.course.code ||
        g.to.entry.course.code === entry.course.code,
    )
    .map((g) =>
      estimateTransfer(g.from.m, g.to.m, g.minutes, {
        speedMPerMin: prefs.speed,
        bufferMinutes: prefs.buffer,
        stepFree: prefs.stepFree,
      }),
    );
  return {
    conflict: conflict?.course.code,
    risky: walks.filter((v) => v.status === "tight" || v.status === "late")
      .length,
    unknown: walks.filter((v) => v.status === "unknown").length,
  };
}
function App() {
  const [s, setS] = useState<Saved>(initial),
    [ready, setReady] = useState(false),
    [cat, setCat] = useState<Catalog | null>(null),
    [full, setFull] = useState(false),
    [problem, setProblem] = useState(false),
    [searchError, setSearchError] = useState(false);
  const [view, setView] = useState<"planner" | "watchlist">("planner"),
    [mode, setMode] = useState<Mode>(null),
    [inspect, setInspect] = useState<"route" | "course">("route"),
    [code, setCode] = useState(""),
    [override, setOverride] = useState<Gap | null>(null),
    [q, setQ] = useState(""),
    [notice, setNotice] = useState(""),
    [threshold, setThreshold] = useState(1),
    [pushPending, setPushPending] = useState(false),
    [pushMessage, setPushMessage] = useState(""),
    [live, setLive] = useState<Record<string, Seat>>({}),
    [picked, setPicked] = useState<Course | null>(null),
    [room, setRoom] = useState<TransferLocation | null>(null),
    [optId, setOptId] = useState(""),
    [sectionQuery, setSectionQuery] = useState<string | null>(() =>
      new URLSearchParams(location.search).get("section"),
    );
  const [dataTry, setDataTry] = useState(0),
    [sharedPlan, setSharedPlan] = useState<Selection[] | null>(null);
  const stateRef = useRef(s);
  const tssTab = useRef<Window | null>(null);
  stateRef.current = s;
  const t: T = (en, zh) => (s.lang === "zh" ? zh : en);
  useEffect(() => {
    document.documentElement.lang = s.lang === "zh" ? "zh-CN" : "en";
  }, [s.lang]);
  useEffect(() => {
    let active = true;
    async function boot() {
      const previous = await readSaved(),
        shared = readShare();
      let seed: Catalog;
      try {
        seed = await loadCatalog(true);
      } catch {
        try {
          seed = await loadCatalog();
        } catch {
          if (active) setProblem(true);
          return;
        }
      }
      if (!active) return;
      const st = previous || initial();
      if (shared) {
        if (st.plans[st.active].length) {
          setSharedPlan(shared);
        } else {
          st.plans = [...st.plans] as Saved["plans"];
          st.plans[st.active] = shared;
        }
        const u = new URL(location.href);
        u.searchParams.delete("plan");
        history.replaceState(null, "", u);
      }
      setS(st);
      setCat(seed);
      setReady(true);
      setProblem(false);
      try {
        const all = await loadCatalog();
        if (active) {
          setCat(all);
          setFull(true);
          setSearchError(false);
        }
      } catch {
        if (active) setSearchError(true);
      }
    }
    boot();
    return () => {
      active = false;
    };
  }, [dataTry]);
  useEffect(() => {
    if (ready)
      writeSaved(s).catch(() =>
        setNotice(t("Device storage is unavailable", "无法写入设备存储")),
      );
  }, [s, ready]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const by = useMemo(
      () => new Map((cat?.courses || []).map((c) => [c.code, c])),
      [cat],
    ),
    plan = useMemo(
      () => entries(s.plans[s.active], by),
      [s.plans, s.active, by],
    ),
    index = useMemo(
      () =>
        (cat?.courses || []).map((c) => ({
          c,
          key: norm(c.code),
          hay: norm(c.title + " " + c.instructors.join(" ")),
          ids: new Set(
            c.options
              .flatMap((o) => [
                o.sectionId,
                o.id,
                o.id.split(":").at(-1),
                o.packageCode,
                ...o.meetings.map((m) => m.sectionId),
              ])
              .filter((s): s is string => !!s)
              .flatMap((id) => [
                norm(id),
                norm(id).replace(/^[a-z]+0*/, ""),
                norm(id).replace(/^[a-z]+/, ""),
              ]),
          ),
        })),
      [cat],
    );
  const selected = plan.find((e) => e.course.code === code) || plan[0];
  const autoGap = useMemo(() => bestGap(plan, s.prefs), [plan, s.prefs]),
    gap =
      override &&
      plan.some(
        (e) =>
          e.option.id === override.from.entry.option.id &&
          e.course.code === override.from.entry.course.code,
      ) &&
      plan.some(
        (e) =>
          e.option.id === override.to.entry.option.id &&
          e.course.code === override.to.entry.course.code,
      )
        ? override
        : autoGap;
  const route = inspect === "route" && gap ? gap : null;
  const entry = route?.to.entry || selected;
  const candidates = useMemo(() => {
    const key = norm(q);
    if (!key) return index.slice(0, 55).map((i) => i.c);
    return index
      .map((i) => ({
        i,
        rank:
          i.key === key
            ? 0
            : i.key.startsWith(key)
              ? 1
              : i.ids.has(key)
                ? 2
                : i.hay.includes(key)
                  ? 3
                  : 9,
      }))
      .filter((r) => r.rank < 9)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 55)
      .map((v) => v.i.c);
  }, [q, index]);
  useEffect(() => {
    if (!sectionQuery || !full) return;
    const c = cat?.courses.find((c) =>
      c.options.some((o) => o.sectionId === sectionQuery),
    );
    if (c) {
      setPicked(c);
      setOptId(c.options.find((o) => o.sectionId === sectionQuery)!.id);
      setMode("search");
    }
    setSectionQuery(null);
  }, [sectionQuery, full, cat]);
  const keys = Array.from(
    new Set(
      [
        ...s.watches.map((w) => w.sectionId),
        ...plan.flatMap((e) => e.option.sectionIds ?? [e.option.sectionId]),
        ...(picked?.options.flatMap((o) => o.sectionIds ?? [o.sectionId]) ||
          []),
      ].filter(Boolean),
    ),
  )
    .sort()
    .join(",");
  useEffect(() => {
    if (!ready || !keys) return;
    let mounted = true;
    let loading = false;
    async function refresh() {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const updated = await latestSeats(keys.split(","));
        if (!mounted || !updated.seats) return;
        const hits: Record<string, Seat> = {};
        for (const key of keys.split(","))
          if (updated.seats[key]) hits[key] = updated.seats[key];
        setLive(hits);
        const alerts: string[] = [];
        let change = false;
        const watches = stateRef.current.watches.map((w) => {
          const seat = hits[w.sectionId];
          if (
            !seat ||
            seat.available === null ||
            !seat.observedAt ||
            (w.at && Date.parse(seat.observedAt) <= Date.parse(w.at))
          )
            return w;
          change = true;
          if (
            w.previous != null &&
            w.previous < w.threshold &&
            seat.available >= w.threshold &&
            Date.now() - Date.parse(seat.observedAt) < 3 * 3600000
          )
            alerts.push(w.code);
          return { ...w, previous: seat.available, at: seat.observedAt };
        });
        if (change)
          setS((v) => ({
            ...v,
            watches: v.watches.map(
              (w) =>
                watches.find(
                  (x) =>
                    x.sectionId === w.sectionId && x.threshold === w.threshold,
                ) || w,
            ),
          }));
        if (alerts.length)
          setNotice(
            alerts.join(", ") +
              (stateRef.current.lang === "zh"
                ? " 有新余位"
                : " · new seat availability"),
          );
      } catch {
        /* The dated offline snapshot remains available. */
      } finally {
        loading = false;
      }
    }
    refresh();
    const timer = setInterval(refresh, 120000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [keys, ready]);
  useEffect(() => {
    if (!ready) return;
    const shown = new Set<string>();
    const check = () => {
      const now = new Date(),
        parts = new Intl.DateTimeFormat("sv-SE", {
          timeZone: "America/Los_Angeles",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .format(now)
          .replace(" ", "T");
      for (const [label, when] of [
        ["First Pass", stateRef.current.first],
        ["Second Pass", stateRef.current.second],
      ])
        if (when && when === parts && !shown.has(when)) {
          shown.add(when);
          setNotice(
            label +
              (stateRef.current.lang === "zh" ? " 现在开始" : " opens now"),
          );
          setMode("booking");
        }
    };
    check();
    const timer = setInterval(check, 15000);
    return () => clearInterval(timer);
  }, [ready]);
  function apply(p: Selection[]) {
    setS((prev) => {
      const plans = [...prev.plans] as Saved["plans"];
      plans[prev.active] = p;
      return { ...prev, plans };
    });
    setOverride(null);
  }
  function choose(c: string) {
    setCode(c);
    setInspect("course");
    setView("planner");
    if (window.innerWidth <= 830)
      requestAnimationFrame(() =>
        document
          .querySelector(".inspector")
          ?.scrollIntoView({ block: "start" }),
      );
  }
  function selectOption(c: Course, id: string) {
    const p = s.plans[s.active].slice(),
      idx = p.findIndex((e) => e.code === c.code);
    if (idx < 0) p.push({ code: c.code, id });
    else p[idx] = { code: c.code, id };
    apply(p);
    choose(c.code);
    setMode(null);
    setPicked(null);
  }
  function search(c?: Course) {
    setQ("");
    setPicked(c || null);
    setOptId(
      c?.options.find((o) =>
        plan.some((e) => e.course === c && e.option.id === o.id),
      )?.id ||
        c?.options[0]?.id ||
        "",
    );
    setMode("search");
  }
  function openTSS(url = officialTSS) {
    if (tssTab.current && !tssTab.current.closed) {
      try {
        tssTab.current.location.href = url;
        tssTab.current.focus();
        return true;
      } catch {
        tssTab.current = null;
      }
    }
    const tab = window.open(url, "QuarterplanTSS");
    if (!tab) {
      setNotice(t("Allow pop-ups to open TSS.", "请允许弹出窗口以打开 TSS。"));
      return false;
    }
    tab.opener = null;
    tssTab.current = tab;
    return true;
  }
  function book(e: Entry) {
    const url = trustedBooking(e.option);
    const id = url === officialTSS ? e.option.sectionId : "";
    const copy = id ? copyText(id) : undefined;
    const opened = openTSS(url);
    if (copy)
      copy
        .then(() =>
          setNotice(
            t(
              opened
                ? "Section ID copied. Paste it in TSS."
                : "Section ID copied. Allow pop-ups to open TSS.",
              opened
                ? "已复制班号，可粘贴到 TSS。"
                : "已复制班号。请允许弹出窗口以打开 TSS。",
            ),
          ),
        )
        .catch(() => setNotice("Section ID " + id));
  }
  const found = entry
    ? s.watches.find((w) => w.sectionId === entry.option.sectionId)
    : undefined;
  async function removeWatch(w: Watch) {
    try {
      if (w.remote) await removeRemoteWatch(w.remote);
      setS((v) => ({
        ...v,
        watches: v.watches.filter((x) => x.sectionId !== w.sectionId),
      }));
      setMode(null);
    } catch {
      setNotice(t("Removal failed. Try again.", "移除失败，请重试。"));
    }
  }
  async function addWatch(remote: boolean) {
    if (!entry?.option.sectionId) return;
    setPushPending(true);
    setPushMessage("");
    try {
      const x = entry.option,
        remoteWatch = remote
          ? await enablePush(x.sectionId, threshold, s.lang)
          : undefined;
      const w: Watch = {
        sectionId: x.sectionId,
        code: entry.course.code,
        threshold,
        previous: live[x.sectionId]?.available ?? null,
        at: live[x.sectionId]?.observedAt || undefined,
        remote: remoteWatch,
      };
      setS((v) => ({
        ...v,
        watches: [...v.watches.filter((a) => a.sectionId !== x.sectionId), w],
      }));
      setMode(null);
      setNotice(t("Added to watchlist", "已加入关注列表"));
    } catch {
      setPushMessage(
        t(
          "Push could not be enabled. Check browser permission or use the on-page watch.",
          "无法开启推送，请检查浏览器权限，或选择页面内提醒。",
        ),
      );
    } finally {
      setPushPending(false);
    }
  }
  const altRows = useMemo(
    () =>
      !entry || mode !== "alternatives"
        ? []
        : entry.course.options
            .filter((o) => o.id !== entry.option.id)
            .map((o) => ({ o, ...compareChange(plan, entry, o, s.prefs) }))
            .sort(
              (a, b) =>
                Number(!!a.conflict) - Number(!!b.conflict) ||
                a.risky - b.risky ||
                a.unknown - b.unknown ||
                Number(b.o.available !== null && b.o.available > 0) -
                  Number(a.o.available !== null && a.o.available > 0),
            ),
    [mode, entry, plan, s.prefs],
  );
  const optionSeats = (o: Entry["option"]) => {
    const ids = o.sectionIds || [o.sectionId];
    if (!ids.every((id) => live[id])) return o.available;
    const counts = ids.map((id) => live[id].available);
    return counts.some((n) => n === null)
      ? null
      : Math.min(...(counts as number[]));
  };
  const previewRooms = Array.from(
    new Map(
      (picked?.options.find((option) => option.id === optId)?.meetings || [])
        .filter(canShowClassroom)
        .map((meeting) => [place(meeting), meeting] as const),
    ),
  );
  const total = plan.reduce((a, e) => a + unitsOf(e.course), 0);
  return (
    <div className="app">
      <header className="topbar">
        <a
          className="wordmark"
          href="./"
          onClick={(e) => {
            e.preventDefault();
            setView("planner");
          }}
          aria-label="Quarterplan"
        >
          <span className="brand-icon" aria-hidden="true" />
          <b>Quarterplan</b>
        </a>
        <nav>
          <button
            className={view === "planner" ? "active" : ""}
            onClick={() => setView("planner")}
          >
            {t("Planner", "排课")}
          </button>
          <button
            className={view === "watchlist" ? "active" : ""}
            onClick={() => setView("watchlist")}
          >
            {t("Watchlist", "关注")}
            {s.watches.length > 0 && <em>{s.watches.length}</em>}
          </button>
        </nav>
        <button
          className="lang"
          title={t("Switch to Chinese", "Switch to English")}
          onClick={() =>
            setS((v) => ({ ...v, lang: v.lang === "en" ? "zh" : "en" }))
          }
        >
          <Globe2 size={15} />
          {s.lang === "zh" ? "EN" : "中文"}
        </button>
      </header>
      <div className="toolbar">
        <div className="plan-title">
          <h1>{t("Your course plan", "我的课表")}</h1>
          <span className="term">{t("Winter 2027", "2027 冬季")}</span>
        </div>
        <div className="select-shell plan-select">
          <Layers size={15} />
          <select
            aria-label={t("Active plan", "当前课表")}
            value={s.active}
            onChange={(e) => {
              const active = Number(e.target.value) as 0 | 1;
              setS((v) => ({ ...v, active }));
              setCode("");
              setOverride(null);
            }}
          >
            <option value={0}>Plan A</option>
            <option value={1}>Plan B</option>
          </select>
          <ChevronDown size={13} />
        </div>
        <div className="toolbar-right">
          <button
            className="booking-btn"
            aria-label={t("Booking checklist", "选课清单")}
            onClick={() => setMode("booking")}
          >
            <CalendarClock size={15} />
            <span>{t("Booking checklist", "选课清单")}</span>
          </button>
          <button
            className="outline tools"
            aria-label={t("Plan tools", "课表工具")}
            onClick={() => setMode("tools")}
          >
            <Ellipsis size={18} />
            <span>{t("Plan tools", "课表工具")}</span>
          </button>
        </div>
      </div>
      {problem ? (
        <div className="loading">
          <h2>{t("Course data unavailable", "课程数据暂不可用")}</h2>
          <button className="outline" onClick={() => setDataTry((x) => x + 1)}>
            {t("Retry", "重试")}
          </button>
        </div>
      ) : !cat ? (
        <div className="loading">
          {t("Loading Winter 2027…", "正在加载 2027 冬季课程…")}
        </div>
      ) : view === "watchlist" ? (
        <main className="watch-page">
          <div className="title-line">
            <h1>{t("Watchlist", "关注列表")}</h1>
            <Bell size={24} />
          </div>
          {s.watches.length === 0 ? (
            <>
              <p>
                {t(
                  "Follow a section to see seat changes here.",
                  "关注班次后，在这里查看余位变化。",
                )}
              </p>
              <button
                className="outline"
                onClick={() => {
                  setView("planner");
                  search();
                }}
              >
                <Search size={15} />
                {t("Find a course", "寻找课程")}
              </button>
            </>
          ) : (
            s.watches.map((w) => {
              const course = by.get(w.code);
              const option = course?.options.find(
                (o) => o.sectionId === w.sectionId,
              );
              return (
                <div className="watch-row" key={w.sectionId}>
                  <button
                    onClick={() => {
                      if (course && option) {
                        search(course);
                        setOptId(option.id);
                      }
                    }}
                    disabled={!option}
                  >
                    <b>{w.code}</b>
                    <small>
                      {w.sectionId} · {t("Alert at", "提醒阈值")} {w.threshold}{" "}
                      ·{" "}
                      {w.remote
                        ? t("Browser push", "浏览器推送")
                        : t("While open", "页面内提醒")}
                    </small>
                  </button>
                  <span>
                    {(live[w.sectionId]
                      ? live[w.sectionId].available
                      : w.previous) ?? "—"}{" "}
                    {t("open", "余位")}
                  </span>
                  {course && option && (
                    <button
                      className="outline watch-tss"
                      onClick={() => book({ course, option })}
                    >
                      <span>
                        {trustedBooking(option) === officialTSS
                          ? t("Copy ID & open TSS", "复制班号并前往 TSS")
                          : t("Open TSS", "前往 TSS")}
                      </span>
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    onClick={() => removeWatch(w)}
                    aria-label={t("Unfollow", "取消关注")}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })
          )}
        </main>
      ) : (
        <main className={"workspace" + (plan.length ? "" : " is-empty")}>
          <aside className="courses-pane">
            <div className="side-title">
              <h2>{t("Courses", "课程")}</h2>
              {plan.length > 0 && <span className="count">{plan.length}</span>}
            </div>
            <button className="search-button" onClick={() => search()}>
              <Search size={15} />
              {t("Search courses", "搜索课程")}
              <Plus size={14} />
            </button>
            <div className="course-list">
              {!plan.length && (
                <div className="sidebar-empty">
                  <BookOpen size={20} aria-hidden="true" />
                  <strong>{t("No courses yet", "尚未添加课程")}</strong>
                  <p>
                    {t(
                      "Search by course, instructor, or section ID.",
                      "可按课程、教师或班号搜索。",
                    )}
                  </p>
                </div>
              )}
              {plan.map((e, i) => (
                <button
                  key={e.course.code}
                  className={
                    "course-row " +
                    (entry?.course.code === e.course.code ? "chosen" : "")
                  }
                  onClick={() => choose(e.course.code)}
                >
                  <span
                    className={"course-mark " + colors[i % colors.length]}
                  />
                  <span>
                    <b>{e.course.code}</b>
                    <small>{e.course.title}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
            <div className="sidebar-bottom">
              <div className="plan-summary">
                <span>{t("Planned units", "计划学分")}</span>
                <b>{total}</b>
              </div>
              <button
                className="outline wide"
                disabled={!plan.length}
                aria-label={t("Generate schedules", "自动排课")}
                onClick={() => setMode("generate")}
              >
                <SlidersHorizontal size={14} />
                {t("Generate schedules", "自动排课")}
              </button>
            </div>
          </aside>
          <CalendarView
            plan={plan}
            t={t}
            lang={s.lang}
            focus={inspect === "course" ? code : ""}
            onCourse={choose}
            onGap={(g) => {
              setOverride(g);
              setInspect("route");
              setCode(g.to.entry.course.code);
            }}
            speed={s.prefs.speed}
            buffer={s.prefs.buffer}
            stepFree={s.prefs.stepFree}
            onSearch={() => search()}
            onImport={() => setMode("tools")}
          />
          <aside className="inspector">
            {entry ? (
              <>
                <div className="inspector-body">
                  {route ? (
                    <>
                      <div className="side-title">
                        <h2>{t("Between classes", "课间通勤")}</h2>
                        <Footprints size={19} />
                      </div>
                      <div className="route-title">
                        <span>{route.from.m.building || "TBA"}</span>
                        <ArrowRight size={24} />
                        <span>{route.to.m.building || "TBA"}</span>
                      </div>
                      <div className="route-sub">
                        {route.from.entry.course.code} <span>→</span>{" "}
                        {route.to.entry.course.code} ·{" "}
                        {s.lang === "zh"
                          ? "周" + dayZh[route.day - 1]
                          : weekdays[route.day - 1]}
                      </div>
                      <h3 className="transfer-time">
                        {route.minutes} {t("min between classes", "分钟课间")}
                      </h3>
                      <Suspense fallback={<div className="map-skeleton" />}>
                        <RouteMap
                          from={route.from.m}
                          to={route.to.m}
                          gapMinutes={route.minutes}
                          options={{
                            speedMPerMin: s.prefs.speed,
                            bufferMinutes: s.prefs.buffer,
                            stepFree: s.prefs.stepFree,
                          }}
                          lang={s.lang}
                          onShowClassroom={setRoom}
                        />
                      </Suspense>
                    </>
                  ) : (
                    <>
                      <div className="side-title">
                        <h2>{t("Course details", "课程详情")}</h2>
                        <BookOpen size={18} />
                      </div>
                      <h2 className="course-code">{entry.course.code}</h2>
                      <p className="course-fullname">{entry.course.title}</p>
                      <div className="instructor">
                        <GraduationCap size={16} />
                        {entry.option.instructor || "TBA"}
                      </div>
                      <button
                        className="option-button"
                        onClick={() => search(entry.course)}
                      >
                        <span>{entry.option.label || entry.option.id}</span>
                        <ChevronDown size={14} />
                      </button>
                      <div className="meeting-list">
                        {entry.option.meetings.map((m, i) => {
                          const hasLocation = canShowClassroom(m);
                          return (
                            <div key={i}>
                              <b>{m.type}</b>
                              <span>
                                {m.date ||
                                  m.days
                                    .map((d) =>
                                      s.lang === "zh"
                                        ? dayZh[d - 1]
                                        : weekdays[d - 1],
                                    )
                                    .join(" ")}{" "}
                                {timed(m)
                                  ? clock(m.start) + "–" + clock(m.end)
                                  : "TBA"}
                                <small>
                                  {hasLocation ? (
                                    <button
                                      className="meeting-map"
                                      onClick={() => setRoom(m)}
                                    >
                                      <MapPin size={12} />
                                      {place(m)}
                                      <ChevronRight size={12} />
                                    </button>
                                  ) : (
                                    place(m)
                                  )}
                                </small>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                  <div className="seat-line">
                    <span>
                      <i
                        className={
                          (optionSeats(entry.option) ?? 0) > 0
                            ? "availability open"
                            : "availability"
                        }
                      />
                      {optionSeats(entry.option) ?? "—"}{" "}
                      {t("seats open", "个余位")}
                    </span>
                    <button
                      className={"icon-btn " + (found ? "on" : "")}
                      aria-label={t("Watch section", "关注班次")}
                      title={t("Watch section", "关注班次")}
                      onClick={() => {
                        setPushMessage("");
                        setThreshold(found?.threshold || 1);
                        setMode("watch");
                      }}
                    >
                      <Bell size={15} />
                    </button>
                  </div>
                  <small
                    className="observed"
                    title={t(
                      "Latest source count time is unavailable. Times below refer to observations.",
                      "上游逐班清点时间未知，此处为读取时间。",
                    )}
                  >
                    {t("Last read", "最近读取")} ·{" "}
                    {when(
                      live[entry.option.sectionId]?.observedAt ||
                        cat.observedAt,
                      s.lang,
                    )}
                  </small>
                  <div className="seat-details">
                    <span>
                      {t("Capacity", "容量")}{" "}
                      {live[entry.option.sectionId]
                        ? (live[entry.option.sectionId].capacity ?? "—")
                        : (entry.option.capacity ?? "—")}
                    </span>
                    <span>
                      {t("Waitlist", "候补")}{" "}
                      {live[entry.option.sectionId]
                        ? (live[entry.option.sectionId].waitlist ?? "—")
                        : (entry.option.waitlist ?? "—")}
                    </span>
                    {entry.option.waitlistOnly && (
                      <b>{t("Waitlist only", "仅候补")}</b>
                    )}
                  </div>
                  <Insights entry={entry} t={t} />
                  <button
                    className="text-action alternate"
                    onClick={() => setMode("alternatives")}
                  >
                    <ArrowDownUp size={15} />
                    {t("Compare alternatives", "比较备选班次")}
                    <ChevronRight size={14} />
                  </button>
                </div>
                <div className="enroll-actions">
                  <button className="primary" onClick={() => book(entry)}>
                    {trustedBooking(entry.option) === officialTSS &&
                    entry.option.sectionId
                      ? t("Copy ID & open TSS", "复制班号并前往 TSS")
                      : t("Open TSS", "前往 TSS")}
                    <ArrowUpRight size={15} />
                  </button>
                  <button
                    className="outline"
                    onClick={() =>
                      copyText(entry.option.sectionId || entry.option.id)
                        .then(() =>
                          setNotice(t("Section ID copied", "已复制班号")),
                        )
                        .catch(() => setNotice(entry.option.sectionId))
                    }
                  >
                    <Copy size={13} />
                    {t("Copy ID", "复制班号")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="side-title">
                  <h2>{t("Course details", "课程详情")}</h2>
                </div>
                <div className="empty-inspector">
                  <span className="empty-icon">
                    <MapPin size={24} aria-hidden="true" />
                  </span>
                  <p>
                    {t(
                      "Select a course to see meeting times, rooms and grades.",
                      "选择课程后可查看上课时间、教室和历史给分。",
                    )}
                  </p>
                </div>
                <div className="blank-enrollment">
                  <h3>{t("TSS enrollment", "TSS 选课")}</h3>
                  <button className="outline wide" onClick={() => openTSS()}>
                    {t("Open TSS", "前往 TSS")} <ArrowUpRight size={15} />
                  </button>
                </div>
              </>
            )}
          </aside>
        </main>
      )}
      <footer className="app-footer">
        <span>
          <i className="status-dot" />
          {t("Saved on this device", "保存在本机")}
        </span>
        <span>
          {t("Independent student planner", "独立学生排课工具")}
          <i />
          UC San Diego
        </span>
      </footer>
      {room && (
        <Dialog
          title={[locationCode(room), listedRoom(room)]
            .filter(Boolean)
            .join(" ")}
          onClose={() => setRoom(null)}
          className="classroom-dialog"
        >
          <Suspense
            fallback={
              <div className="map-skeleton" role="status">
                {t("Loading classroom…", "正在加载教室…")}
              </div>
            }
          >
            <ClassroomMap place={room} locale={s.lang} showTitle={false} />
          </Suspense>
        </Dialog>
      )}
      {mode === "search" && (
        <Dialog
          title={picked ? picked.code : t("Find courses", "查找课程")}
          onClose={() => setMode(null)}
        >
          {picked ? (
            <>
              <button className="text-action" onClick={() => setPicked(null)}>
                <ArrowLeft size={14} />
                {t("All courses", "返回课程")}
              </button>
              <h3 className="detail-title">{picked.title}</h3>
              <p className="intro">
                {picked.units} {t("units", "学分")} · {picked.options.length}{" "}
                {t("section combinations", "个班次组合")}
              </p>
              {picked.description && (
                <p className="note">{picked.description}</p>
              )}
              {picked.restrictions && (
                <p className="note">{picked.restrictions}</p>
              )}
              <div className="option-list">
                {picked.options.map((o) => (
                  <label
                    key={o.id}
                    className={"package " + (optId === o.id ? "checked" : "")}
                  >
                    <input
                      type="radio"
                      name="package"
                      checked={optId === o.id}
                      onChange={() => setOptId(o.id)}
                    />
                    <span>
                      <b>
                        {o.packageCode || o.label || o.id} ·{" "}
                        {o.instructor || "TBA"}
                      </b>
                      <small>
                        {o.meetings
                          .filter((m) => !isFinal(m))
                          .map(
                            (m) =>
                              m.type +
                              " " +
                              m.days.map((d) => weekdays[d - 1]).join("/") +
                              " " +
                              (m.start !== null ? clock(m.start) : "TBA") +
                              " " +
                              place(m),
                          )
                          .join(" · ")}
                      </small>
                      <small>
                        #{o.sectionId || "—"} ·{" "}
                        {o.waitlistOnly
                          ? t("Waitlist only · ", "仅候补 · ")
                          : ""}
                        {optionSeats(o) ?? "—"} {t("open", "余位")}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              {previewRooms.length > 0 && (
                <div
                  className="preview-rooms"
                  aria-label={t("Classroom locations", "上课地点")}
                >
                  {previewRooms.map(([name, meeting]) => (
                    <button
                      key={name}
                      className="outline"
                      onClick={() => setRoom(meeting)}
                    >
                      <MapPin size={13} /> {name}
                    </button>
                  ))}
                </div>
              )}
              <div className="modal-actions">
                {plan.some((e) => e.course.code === picked.code) && (
                  <button
                    className="outline"
                    onClick={() => {
                      apply(
                        s.plans[s.active].filter((x) => x.code !== picked.code),
                      );
                      setMode(null);
                    }}
                  >
                    <Trash2 size={14} />
                    {t("Remove", "移除")}
                  </button>
                )}
                <button
                  className="primary"
                  disabled={!optId}
                  onClick={() => selectOption(picked, optId)}
                >
                  <Check size={15} />
                  {t("Use this section", "使用此班次")}
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="search-field">
                <Search size={18} />
                <input
                  autoFocus
                  placeholder={t(
                    "Course, instructor or section ID",
                    "课程、教师或班号",
                  )}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </label>
              <small>
                {full
                  ? index.length.toLocaleString() +
                    " " +
                    t("courses in Winter 2027", "门冬季课程")
                  : searchError
                    ? t(
                        "Full catalog unavailable. Showing offline selection.",
                        "完整目录暂不可用，仅显示离线课程。",
                      )
                    : t("Loading full catalog…", "正在加载完整目录…")}
              </small>
              {searchError && (
                <button
                  className="text-action"
                  onClick={() => setDataTry((n) => n + 1)}
                >
                  {t("Retry", "重试")}
                </button>
              )}
              <div className="search-results">
                {candidates.map((c) => (
                  <button
                    key={c.code}
                    onClick={() => {
                      setPicked(c);
                      setOptId(
                        plan.find((e) => e.course.code === c.code)?.option.id ||
                          c.options[0]?.id ||
                          "",
                      );
                    }}
                  >
                    <span>
                      <b>{c.code}</b>
                      <small>{c.title}</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
                {candidates.length === 0 && (
                  <p>{t("No matching courses.", "没有匹配的课程。")}</p>
                )}
              </div>
            </>
          )}
        </Dialog>
      )}
      {mode === "watch" && entry && (
        <Dialog
          title={t("Seat alert", "余位提醒")}
          onClose={() => setMode(null)}
        >
          <h3>
            {entry.course.code} · {entry.option.sectionId}
          </h3>
          <label className="stack">
            {t("Notify when open seats reach", "余位达到以下数量时提醒")}
            <input
              type="number"
              min="1"
              max="999"
              value={threshold}
              onChange={(e) =>
                setThreshold(Math.min(999, Math.max(1, +e.target.value)))
              }
            />
          </label>
          <p className="note">
            {t(
              "Keep your waitlist position. Confirm availability in TSS before making a change.",
              "请保留候补顺位，在 TSS 核对最新余位后再操作。",
            )}
          </p>
          {found ? (
            <button className="outline" onClick={() => removeWatch(found)}>
              {t("Remove alert", "取消关注")}
            </button>
          ) : (
            <div className="modal-actions">
              <button
                className="outline"
                disabled={pushPending}
                onClick={() => addWatch(false)}
              >
                {t("Watch while open", "页面内提醒")}
              </button>
              {apiBase && (
                <button
                  className="primary"
                  disabled={pushPending}
                  onClick={() => addWatch(true)}
                >
                  {t("Enable browser push", "开启浏览器推送")}
                </button>
              )}
            </div>
          )}
          {!apiBase && (
            <p className="note">
              {t(
                "This Pages site checks for new snapshots while open. Background push requires a connected notification service.",
                "此 Pages 站点在打开时检查新快照。后台推送需要连接通知服务。",
              )}
            </p>
          )}
          {pushMessage && <p role="alert">{pushMessage}</p>}
        </Dialog>
      )}
      {mode === "alternatives" && entry && (
        <Dialog
          title={t("Compare alternatives", "比较备选班次")}
          onClose={() => setMode(null)}
        >
          <p className="intro">
            {entry.course.code} ·{" "}
            {t("Changes to your current plan", "相对于当前课表的变化")}
          </p>
          <div className="option-list">
            {altRows.length ? (
              altRows.map(({ o, conflict, risky, unknown }) => (
                <button
                  className="alt-row"
                  key={o.id}
                  onClick={() => selectOption(entry.course, o.id)}
                >
                  <b>
                    {o.label} · {o.instructor}
                  </b>
                  <small>
                    {o.meetings
                      .filter((m) => !isFinal(m))
                      .map(
                        (m) =>
                          m.type +
                          " " +
                          m.days.map((d) => weekdays[d - 1]).join("/") +
                          " " +
                          (m.start === null ? "TBA" : clock(m.start)) +
                          " " +
                          place(m),
                      )
                      .join(" · ")}
                  </small>
                  <small>
                    {conflict
                      ? t("Overlaps ", "时间冲突 ") + conflict
                      : risky + " " + t("tight walks", "处紧张通勤")}{" "}
                    · {unknown} {t("unknown walks", "处待确认通勤")} ·{" "}
                    {o.available ?? "—"} {t("open", "余位")}
                  </small>
                </button>
              ))
            ) : (
              <p>
                {t(
                  "No other published package for this course.",
                  "该课程无其他已发布班次组合。",
                )}
              </p>
            )}
          </div>
        </Dialog>
      )}
      {(mode === "generate" || mode === "tools" || mode === "booking") && (
        <ToolPanel
          t={t}
          s={s}
          update={setS}
          tab={mode}
          plan={plan}
          courses={cat?.courses || []}
          onClose={() => setMode(null)}
          apply={apply}
          notify={setNotice}
          book={book}
        />
      )}
      {sharedPlan && (
        <Dialog
          title={t("Open shared schedule", "打开共享课表")}
          onClose={() => setSharedPlan(null)}
        >
          <p className="intro">
            {t("This link contains", "此链接包含")} {sharedPlan.length}{" "}
            {t(
              "courses. Choose which plan to replace.",
              "门课。请选择要写入的方案。",
            )}
          </p>
          <div className="modal-actions">
            {([0, 1] as const).map((index) => (
              <button
                className="outline"
                key={index}
                onClick={() => {
                  setS((prev) => {
                    const plans = [...prev.plans] as Saved["plans"];
                    plans[index] = sharedPlan;
                    return { ...prev, plans, active: index };
                  });
                  setSharedPlan(null);
                }}
              >
                Plan {index ? "B" : "A"} · {s.plans[index].length}{" "}
                {t("courses", "门课")}
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {notice && (
        <div role="status" className="toast">
          <Check size={15} />
          {notice}
          <button aria-label="Close" onClick={() => setNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
export default App;
