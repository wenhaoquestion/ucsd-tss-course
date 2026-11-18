import {
  firstDay,
  lastDay,
  clock,
  place,
  tz,
  type Meeting,
  type Entry,
} from "./model";

// https://blink.ucsd.edu/instructors/resources/academic/calendars/2026.html
const DAY = 86400000;
const origin = Date.parse(firstDay + "T00:00:00Z");
const quarterEnd = "2027-03-20";
const holidays = new Set(["2027-01-18", "2027-02-15"]);
const dayInfo = Array.from(
  {
    length:
      Math.round((Date.parse(quarterEnd + "T00:00:00Z") - origin) / DAY) + 1,
  },
  (_, i) => {
    const date = new Date(origin + i * DAY);
    return {
      iso: date.toISOString().slice(0, 10),
      day: date.getUTCDay() || 7,
      week: Math.floor(i / 7) + 1,
      bit: 1n << BigInt(i),
    };
  },
);
const byDate = new Map(dayInfo.map((d) => [d.iso, d]));
const weekdayMasks = Array.from({ length: 8 }, (_, n) =>
  dayInfo.reduce((bits, d) => (d.day === n ? bits | d.bit : bits), 0n),
);
const weekMasks = Array.from({ length: 13 }, (_, n) =>
  dayInfo.reduce((bits, d) => (d.week === n ? bits | d.bit : bits), 0n),
);
const cache = new WeakMap<Meeting, { dates: string[]; mask: bigint }>();
export const isFinal = (m: Meeting) =>
  /^(FI|FE|FINAL|EXAM|FINAL EXAM(?:INATION)?)$/i.test(m.type.trim());
export const timed = (
  m: Meeting,
): m is Meeting & { start: number; end: number } =>
  Number.isInteger(m.start) &&
  Number.isInteger(m.end) &&
  m.start !== null &&
  m.end !== null &&
  m.start >= 0 &&
  m.end <= 1440 &&
  m.end > m.start;

/** The explicit calendar date of a one-off meeting. No weekday-only exam date is inferred. */
export function singleMeetingDate(m: Meeting): string | null {
  const day = m.date || (m.startDate === m.endDate ? m.startDate : "");
  return day && byDate.has(day) ? day : null;
}

function occurrences(m: Meeting) {
  const hit = cache.get(m);
  if (hit) return hit;
  const single = singleMeetingDate(m),
    selected: string[] = [];
  let bits = 0n;
  if (single) {
    selected.push(single);
    bits = byDate.get(single)!.bit;
  } else if (!m.date && (!isFinal(m) || (m.startDate && m.endDate))) {
    const start = m.startDate || firstDay,
      end = m.endDate || (m.type === "busy" ? quarterEnd : lastDay);
    const weekdays = new Set(m.days),
      weeks = m.weeks?.length ? new Set(m.weeks) : null;
    for (const d of dayInfo) {
      if (
        d.iso < start ||
        d.iso > end ||
        !weekdays.has(d.day) ||
        (weeks && !weeks.has(d.week))
      )
        continue;
      if (m.type !== "busy" && holidays.has(d.iso)) continue;
      selected.push(d.iso);
      bits |= d.bit;
    }
  }
  const result = { dates: selected, mask: bits };
  cache.set(m, result);
  return result;
}
export const dates = (m: Meeting) => occurrences(m).dates;
export const mask = (m: Meeting) => occurrences(m).mask;
export function occursOnDate(m: Meeting, date: string) {
  return !!(mask(m) & (byDate.get(date)?.bit ?? 0n));
}
export function sameMeeting(a: Meeting, b: Meeting) {
  if (
    !a.sectionId ||
    a.sectionId !== b.sectionId ||
    a.type !== b.type ||
    a.start !== b.start ||
    a.end !== b.end
  )
    return false;
  if (
    (a.building && b.building && a.building !== b.building) ||
    (a.room && b.room && a.room !== b.room)
  )
    return false;
  const aMask = mask(a);
  return aMask !== 0n && aMask === mask(b);
}
export function overlap(a: Meeting, b: Meeting, gap = 0) {
  return (
    timed(a) &&
    timed(b) &&
    a.start < b.end + gap &&
    b.start < a.end + gap &&
    (mask(a) & mask(b)) !== 0n &&
    !sameMeeting(a, b)
  );
}

export interface Tile {
  entry: Entry;
  m: Meeting;
  day: number;
  occurrences?: bigint;
}
export interface Gap {
  from: Tile;
  to: Tile;
  day: number;
  minutes: number;
  occurrences?: bigint;
}
type View = "typical" | "week" | "finals" | "all";
function tilesFor(plan: Entry[], view: View, week = 0) {
  const tiles: Tile[] = [];
  for (const entry of plan)
    for (const m of entry.option.meetings) {
      if (!timed(m)) continue;
      if (view === "typical" && (singleMeetingDate(m) || isFinal(m))) continue;
      if (view === "finals" && !isFinal(m)) continue;
      const selected =
        mask(m) & (view === "week" ? (weekMasks[week] ?? 0n) : -1n);
      if (!selected) continue;
      for (let day = 1; day <= 7; day++) {
        const days = selected & weekdayMasks[day];
        if (days !== 0n) tiles.push({ entry, m, day, occurrences: days });
      }
    }
  return orderTiles(tiles);
}
export function orderTiles(tiles: Tile[]): Tile[] {
  const seen = new Map<string, Meeting[]>();
  return tiles
    .sort(
      (a, b) => a.day - b.day || a.m.start! - b.m.start! || a.m.end! - b.m.end!,
    )
    .filter((t) => {
      if (!t.m.sectionId) return true;
      const key = t.day + "|" + t.m.sectionId,
        shared = seen.get(key);
      if (shared?.some((m) => sameMeeting(m, t.m))) return false;
      if (shared) shared.push(t.m);
      else seen.set(key, [t.m]);
      return true;
    });
}
export function weekTiles(plan: Entry[], finals = false, week = 0): Tile[] {
  return tilesFor(
    plan,
    finals ? "finals" : week > 0 ? "week" : "typical",
    week,
  );
}
/** Used by the solver. Includes one-off meetings, labs, final exams and recurring classes. */
export const scheduleTiles = (plan: Entry[]) => tilesFor(plan, "all");
export function gaps(sortedTiles: Tile[], maxMinutes = 120): Gap[] {
  const result: Gap[] = [];
  for (let i = 0; i < sortedTiles.length; i++) {
    const from = sortedTiles[i];
    let remaining = from.occurrences ?? mask(from.m) & weekdayMasks[from.day];
    for (
      let j = i + 1;
      j < sortedTiles.length &&
      sortedTiles[j].day === from.day &&
      remaining !== 0n;
      j++
    ) {
      const to = sortedTiles[j];
      const minutes = to.m.start! - from.m.end!;
      if (minutes > maxMinutes) break;
      const common =
        remaining & (to.occurrences ?? mask(to.m) & weekdayMasks[to.day]);
      if (common === 0n || sameMeeting(from.m, to.m)) continue;
      // An intervening meeting only consumes the dates on which it actually occurs.
      remaining &= ~common;
      if (minutes >= 0)
        result.push({ from, to, day: from.day, minutes, occurrences: common });
    }
  }
  return result;
}

function escapeIcs(s: string) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
const textEncoder = new TextEncoder();
function foldLine(s: string) {
  if (textEncoder.encode(s).length <= 75) return s;
  const chunks: string[] = [];
  let chunk = "",
    bytes = 0;
  for (const character of s) {
    const size = textEncoder.encode(character).length;
    if (bytes + size > 75) {
      chunks.push(chunk);
      chunk = " ";
      bytes = 1;
    }
    chunk += character;
    bytes += size;
  }
  return [...chunks, chunk].join("\r\n");
}
const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: tz,
  timeZoneName: "longOffset",
});
const offsets = new Map<number, number>();
function zoneOffset(t: number) {
  const hour = Math.floor(t / 3600000),
    saved = offsets.get(hour);
  if (saved !== undefined) return saved;
  const name = offsetFormatter
    .formatToParts(t)
    .find((p) => p.type === "timeZoneName")!.value;
  const [, sign, hh, mm] = /^GMT([+-])(\d\d):(\d\d)$/.exec(name)!;
  const offset =
    (Number(hh) * 60 + Number(mm)) * (sign === "+" ? 1 : -1) * 60000;
  offsets.set(hour, offset);
  return offset;
}
const stamp = (time: number) =>
  new Date(time)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
function pacificStamp(date: string, minutes: number) {
  const naive = Date.parse(date + "T00:00:00Z") + minutes * 60000;
  const first = naive - zoneOffset(naive),
    second = naive - zoneOffset(first);
  // RFC 5545 interprets a nonexistent local time using the offset before the transition.
  return stamp(second + zoneOffset(second) === naive ? second : first);
}
export function makeIcs(plan: Entry[]) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Quarterplan//UCSD Planner//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-TIMEZONE:" + tz,
  ];
  const now = stamp(Date.now()),
    seen = new Map<string, Meeting[]>();
  for (const { course, option } of plan)
    option.meetings.forEach((m, i) => {
      if (!timed(m)) return;
      if (m.sectionId) {
        const shared = seen.get(m.sectionId);
        if (shared?.some((s) => sameMeeting(m, s))) return;
        if (shared) shared.push(m);
        else seen.set(m.sectionId, [m]);
      }
      for (const d of dates(m)) {
        const uid =
          [course.code, option.id, i, d]
            .map((x) => encodeURIComponent(String(x)))
            .join("/") + "@quarterplan";
        lines.push(
          "BEGIN:VEVENT",
          "UID:" + uid,
          "DTSTAMP:" + now,
          "DTSTART:" + pacificStamp(d, m.start),
          "DTEND:" + pacificStamp(d, m.end),
          "SUMMARY:" + escapeIcs(course.code + " " + m.type),
          "LOCATION:" + escapeIcs(place(m)),
          "END:VEVENT",
        );
      }
    });
  return [...lines, "END:VCALENDAR", ""].map(foldLine).join("\r\n");
}
export function optionTimes(o: { meetings: Meeting[] }) {
  return o.meetings
    .filter((m) => !isFinal(m) && timed(m))
    .map((m) => m.days.join("") + " " + clock(m.start!) + "–" + clock(m.end!))
    .join(" / ");
}
