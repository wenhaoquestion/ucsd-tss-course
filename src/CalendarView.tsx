import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  CalendarDays,
  Footprints,
  Layers2,
} from "lucide-react";
import {
  type Entry,
  type T,
  type Lang,
  weekdays,
  dayZh,
  shortTime,
  place,
} from "./model";
import { weekTiles, gaps, type Gap, mask } from "./calendar";
import { estimateTransfer } from "./routing";
export const colors = ["blue", "sand", "sage", "lavender", "rose", "stone"];
interface Props {
  plan: Entry[];
  lang: Lang;
  t: T;
  onCourse: (code: string) => void;
  onGap: (gap: Gap) => void;
  focus: string;
  speed: number;
  buffer: number;
  stepFree: boolean;
  onSearch: () => void;
}
export function CalendarView({
  plan,
  t,
  lang,
  onCourse,
  onGap,
  focus,
  speed,
  buffer,
  stepFree,
  onSearch,
}: Props) {
  const [week, setWeek] = useState("all"),
    [chosenDay, setPhoneDay] = useState<number | null>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const tiles = weekTiles(
      plan,
      week === "finals",
      /^\d+$/.test(week) ? Number(week) : 0,
    ),
    transfers = gaps(tiles);
  const days = Math.max(5, ...tiles.map((k) => k.day)),
    first = Math.min(9, ...tiles.map((k) => Math.floor(k.m.start! / 60))),
    last = Math.max(16, ...tiles.map((k) => Math.ceil(k.m.end! / 60)));
  const hours = Array.from({ length: last - first + 1 }, (_, i) => i + first);
  const today = new Date().toLocaleDateString("sv-SE", {timeZone:"America/Los_Angeles"});
  const scheduledDay = today >= "2027-01-04" && today <= "2027-03-20"
    ? new Date(today+"T12:00:00Z").getUTCDay() || 7 : tiles[0]?.day || 1;
  const phoneDay = Math.min(days, chosenDay ?? scheduledDay);
  const firstStart = tiles.find(tile => tile.day === phoneDay)?.m.start;
  useEffect(() => {
    if (!window.matchMedia("(max-width:620px)").matches || !scrollArea.current) return;
    const line = scrollArea.current.querySelector(".hour-axis span");
    scrollArea.current.scrollTop = firstStart == null ? 0 : Math.max(0, (Math.floor(firstStart / 60) - first) * (line?.getBoundingClientRect().height || 49));
  }, [phoneDay, firstStart, first, week]);
  const dayLabel = (i: number) =>
    lang === "zh" ? "周" + dayZh[i - 1] : weekdays[i - 1];
  const unknown = plan.filter((p) =>
    p.option.meetings.some(
      (m) => m.start === null || (!m.days.length && !m.date),
    ),
  );
  return (
    <section className="calendar-pane">
      <div className="calendar-head">
        <div>
          <h1>{t("Weekly calendar", "每周课表")}</h1>
        </div>
        <label className="select-shell week-select">
          <Layers2 size={14} />
          <select
            aria-label={t("Calendar week", "显示周次")}
            value={week}
            onChange={(e) => setWeek(e.target.value)}
          >
            <option value="all">{t("Typical week", "常规周")}</option>
            {Array.from({ length: 10 }, (_, i) => (
              <option key={i} value={i + 1}>
                {t("Week ", "第 ")}
                {i + 1}
                {lang === "zh" ? " 周" : ""}
              </option>
            ))}
            <option value="finals">{t("Finals", "期末周")}</option>
          </select>
          <ChevronDown size={12} />
        </label>
      </div>
      <div className="phone-days">
        {Array.from({ length: days }, (_, i) => (
          <button
            className={i + 1 === phoneDay ? "on" : ""}
            key={i}
            onClick={() => setPhoneDay(i + 1)}
          >
            {dayLabel(i + 1)}
          </button>
        ))}
      </div>
      {firstStart == null && plan.length > 0 && <p className="phone-day-empty">{t("No meetings on this day.","当天没有已知授课时段。")}</p>}
      <div ref={scrollArea} className="calendar-scroll">
        <div
          className="calendar-grid"
          style={
            {
              "--days": days,
              "--hours": last - first + 1,
            } as React.CSSProperties
          }
        >
          <div className="axis-label">PT</div>
          {Array.from({ length: days }, (_, i) => (
            <div
              key={i}
              className={"day-heading " + (phoneDay === i + 1 ? "current" : "")}
            >
              {dayLabel(i + 1)}
            </div>
          ))}
          <div className="hour-axis">
            {hours.map((h) => (
              <span key={h}>
                {lang === "zh"
                  ? h + ":00"
                  : (h % 12 || 12) + " " + (h >= 12 ? "PM" : "AM")}
              </span>
            ))}
          </div>
          {Array.from({ length: days }, (_, i) => {
            const d = i + 1,
              items = tiles.filter((k) => k.day === d);
            return (
              <div
                className={"day-column " + (d === phoneDay ? "current" : "")}
                key={i}
              >
                {items.map((tile, n) => {
                  const { m, entry } = tile;
                  const color = colors[plan.indexOf(entry) % colors.length];
                  const overlapping = items.filter(
                    (v) =>
                      v.m.start! < m.end! &&
                      v.m.end! > m.start! &&
                      (mask(v.m) & mask(m)) !== 0n,
                  );
                  const index = Math.max(0, overlapping.indexOf(tile)),
                    count = Math.max(1, overlapping.length);
                  return (
                    <button
                      key={n}
                      className={
                        "event " +
                        color +
                        (focus === entry.course.code ? " active" : "") +
                        (m.end! - m.start! < 45 ? " short" : "")
                      }
                      style={{
                        top:
                          ((m.start! / 60 - first) / hours.length) * 100 + "%",
                        height:
                          "calc(" +
                          ((m.end! - m.start!) / (hours.length * 60)) * 100 +
                          "% - 3px)",
                        left: "calc(" + (index / count) * 100 + "% + 3px)",
                        width: "calc(" + 100 / count + "% - 6px)",
                      }}
                      onClick={() => onCourse(entry.course.code)}
                      title={
                        entry.course.code + " · " + m.type + " · " + place(m)
                      }
                    >
                      <b>{entry.course.code}</b>
                      <span>
                        {shortTime(m.start!)}–{shortTime(m.end!)}
                      </span>
                      <small>{place(m)}</small>
                    </button>
                  );
                })}
                {transfers
                  .filter(
                    (g) => g.day === d && g.minutes <= 25 && g.minutes >= 0,
                  )
                  .map((g, n) => {
                    const r = estimateTransfer(g.from.m, g.to.m, g.minutes, {
                      speedMPerMin: speed,
                      bufferMinutes: buffer,
                      stepFree,
                    });
                    return (
                      <button
                        key={"gap" + n}
                        className={
                          "walk-chip " +
                          (r.status === "late" || r.status === "tight"
                            ? "risky"
                            : "")
                        }
                        style={{
                          top:
                            "calc(" +
                            ((g.from.m.end! / 60 - first) / hours.length) *
                              100 +
                            "% - 3px)",
                        }}
                        aria-label={
                          t("Inspect walk", "查看路线") +
                          " " +
                          place(g.from.m) +
                          " → " +
                          place(g.to.m)
                        }
                        onClick={() => onGap(g)}
                      >
                        <Footprints size={10} />
                        <span>{g.minutes} min</span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
      {!plan.length && (
        <div className="calendar-empty">
          <CalendarDays size={28} />
          <strong>{t("Start with a course", "从一门课开始")}</strong>
          <button className="quiet" onClick={onSearch}>
            {t("Search courses", "搜索课程")} <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="calendar-foot">
        <div className="legend">
          {plan.map((e, i) => (
            <span key={e.course.code}>
              <i className={colors[i % colors.length]} />
              {e.course.code}
            </span>
          ))}
        </div>
        <span>{t("Pacific time", "太平洋时间")}</span>
      </div>
      {unknown.length > 0 && (
        <div className="note">
          {t("Meeting time pending", "有时段待定")} ·{" "}
          {unknown.map((e) => e.course.code).join(", ")}
        </div>
      )}
    </section>
  );
}
