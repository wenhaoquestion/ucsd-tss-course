import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  dates,
  occursOnDate,
  singleMeetingDate,
  weekTiles,
  scheduleTiles,
  gaps,
  overlap,
  makeIcs,
} from "../src/calendar";
import { solve } from "../src/solver";
import {
  defaults,
  type Catalog,
  type Course,
  type Entry,
  type Meeting,
  type Option,
  type Prefs,
} from "../src/model";
import { estimateTransfer } from "../src/routing";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    type: "LE",
    days: [1],
    start: 540,
    end: 590,
    building: "CENTR",
    room: "115",
    ...overrides,
  };
}
function option(
  id: string,
  meetings: Meeting[],
  instructor = "Instructor",
): Option {
  return {
    id,
    label: id,
    instructor,
    sectionId: id,
    meetings,
    available: 1,
    capacity: 30,
    waitlist: 0,
  };
}
function course(code: string, options: Option[]): Course {
  return { code, title: code, units: "4", instructors: [], options };
}
function entry(code: string, meetings: Meeting[]): Entry {
  const o = option(code + "-1", meetings);
  return { course: course(code, [o]), option: o };
}
function find(courses: Course[], prefs: Partial<Prefs> = {}) {
  return solve({ courses, current: [], prefs: { ...defaults, ...prefs } });
}

test("WI27 weekdays, holidays, alternation and single-date exceptions follow the actual term", () => {
  const mondays = dates(meeting());
  assert.equal(mondays[0], "2027-01-04");
  assert.equal(mondays.at(-1), "2027-03-08");
  assert.equal(mondays.length, 8);
  assert.ok(!mondays.includes("2027-01-18") && !mondays.includes("2027-02-15"));
  const alternating = meeting({ days: [2], weeks: [1, 3, 5, 7, 9] });
  assert.deepEqual(dates(alternating), [
    "2027-01-05",
    "2027-01-19",
    "2027-02-02",
    "2027-02-16",
    "2027-03-02",
  ]);
  assert.ok(
    !overlap(alternating, meeting({ days: [2], weeks: [2, 4, 6, 8, 10] })),
  );
  const special = meeting({ days: [], date: "2027-01-30" }),
    earlyFinal = meeting({ type: "FI", date: "2027-03-12" }),
    marchFinal = meeting({ type: "FI", date: "2027-03-16" });
  const e = entry("X", [special, earlyFinal, marchFinal, alternating]);
  assert.equal(singleMeetingDate(special), "2027-01-30");
  assert.equal(
    singleMeetingDate(
      meeting({ startDate: "2027-02-12", endDate: "2027-02-12" }),
    ),
    "2027-02-12",
  );
  assert.equal(singleMeetingDate(meeting({ date: "2027-02-30" })), null);
  assert.ok(occursOnDate(special, "2027-01-30"));
  assert.ok(!occursOnDate(special, "2027-01-29"));
  assert.deepEqual(
    weekTiles([e]).map((t) => t.m),
    [alternating],
  );
  assert.deepEqual(
    weekTiles([e], false, 4).map((t) => [t.day, t.m]),
    [[6, special]],
  );
  assert.deepEqual(
    weekTiles([e], false, 10).map((t) => t.m),
    [earlyFinal],
  );
  assert.equal(weekTiles([e], true).length, 2);
  assert.deepEqual(dates(meeting({ type: "FI" })), []);
  assert.deepEqual(dates(meeting({ date: "2027-02-30" })), []);
});

test("attendance, time blocks and spacing account for final-exam dates and online meetings", () => {
  const finalsDate = "2027-03-16",
    first = entry("A", [
      meeting({ type: "FI", date: finalsDate, start: 480, end: 660 }),
    ]);
  const sameTime = entry("B", [
    meeting({ type: "FI", date: finalsDate, start: 650, end: 720 }),
  ]);
  assert.equal(find([first.course, sameTime.course]).status, "infeasible");
  const different = entry("C", [
    meeting({ type: "FI", date: "2027-03-17", start: 650, end: 720 }),
  ]);
  assert.equal(find([first.course, different.course]).status, "matched");
  assert.equal(
    find([first.course], { busy: [{ day: 2, start: 500, end: 540 }] }).status,
    "infeasible",
  );
  const online = entry("R", [meeting({ building: "RCLAS", remote: true })]);
  assert.equal(
    find([online.course], { busy: [{ day: 1, start: 540, end: 600 }] }).status,
    "infeasible",
  );
  assert.equal(find([online.course]).plans[0].days, 0);
  const after = entry("N", [meeting({ start: 600, end: 650 })]);
  assert.equal(
    find([online.course, after.course], { minGap: 10 }).status,
    "matched",
  );
  assert.equal(
    find([online.course, after.course], { minGap: 11 }).status,
    "infeasible",
  );
  const within = entry("P", [
    meeting(),
    meeting({ type: "DI", start: 600, end: 650 }),
  ]);
  assert.equal(find([within.course], { minGap: 11 }).status, "infeasible");
  assert.equal(find([online.course], { early: 541 }).status, "infeasible");
});

test("shared components appear once; chosen groups are whole, legal packages", () => {
  const shared = meeting({ sectionId: "E 1234" });
  const first = entry("A", [shared]);
  const other = entry("B", [{ ...shared }, meeting({ type: "DI", days: [2] })]);
  const differentRoom = meeting({ ...shared, room: "220" });
  assert.equal(overlap(shared, differentRoom), true);
  assert.equal(overlap(shared, other.option.meetings[0]), false);
  assert.equal(find([first.course, other.course]).status, "matched");
  assert.equal(weekTiles([first, other]).length, 2);
  const one = option(
    "A01",
    [meeting(), meeting({ type: "LA", days: [3] })],
    "X",
  );
  const two = option(
    "B01",
    [meeting({ days: [2] }), meeting({ type: "LA", days: [4] })],
    "Y",
  );
  const bundled = course("LAB", [one, two]);
  const impossible = find([bundled], {
    busy: [
      { day: 1, start: 540, end: 600 },
      { day: 4, start: 540, end: 600 },
    ],
  });
  assert.equal(impossible.status, "infeasible");
  const wanted = solve({
    courses: [bundled],
    current: [{ code: "LAB", id: "B01" }],
    prefs: { ...defaults, locked: ["LAB"], teachers: { LAB: "Y" } },
  });
  assert.deepEqual(wanted.plans[0].picks, [{ code: "LAB", id: "B01" }]);
});

test("walking scores derive from actual, chronological neighbors including two meetings of one course", () => {
  const a = entry("A", [meeting({ start: 540, end: 590, building: "GH" })]);
  const b = entry("B", [meeting({ start: 600, end: 650, building: "CENTR" })]);
  const c = entry("C", [meeting({ start: 660, end: 710, building: "FAH" })]);
  const pairs = gaps(scheduleTiles([a, b, c]));
  assert.deepEqual(
    pairs.map((x) => [x.from.entry.course.code, x.to.entry.course.code]),
    [
      ["A", "B"],
      ["B", "C"],
    ],
  );
  const expected = pairs.reduce(
    (v, g) =>
      v +
      Math.max(
        0,
        estimateTransfer(g.from.m, g.to.m, g.minutes).maxMinutes! - g.minutes,
      ),
    0,
  );
  const result = find([a.course, b.course, c.course]).plans[0];
  assert.equal(result.gaps, 20);
  assert.equal(result.walk, expected);
  const two = entry("BOTH", [a.option.meetings[0], b.option.meetings[0]]);
  assert.equal(gaps(weekTiles([two])).length, 1);
  const x = entry("X", [
    meeting({ days: [1, 3], startDate: "2027-01-04", endDate: "2027-01-06" }),
  ]);
  const y = entry("Y", [
    meeting({
      days: [1, 3],
      start: 600,
      end: 650,
      startDate: "2027-01-06",
      endDate: "2027-01-11",
    }),
  ]);
  assert.deepEqual(
    gaps(weekTiles([x, y])).map((g) => g.day),
    [3],
  );
  const interposed = entry("B", [
    meeting({ days: [1], weeks: [2], start: 600, end: 650, building: "CENTR" }),
  ]);
  const actual = gaps(scheduleTiles([a, interposed, c])).map(
    (g) => g.from.entry.course.code + "→" + g.to.entry.course.code,
  );
  assert.deepEqual(actual, ["A→B", "A→C", "B→C"]);
});

test("calendar export emits real Pacific instants, suppresses shared events and keeps Unicode lines valid", () => {
  const early = meeting({
    date: "2027-03-13",
    type: "FI",
    start: 480,
    end: 660,
    sectionId: "E 52",
  });
  const late = meeting({
    date: "2027-03-15",
    type: "FI",
    start: 480,
    end: 660,
  });
  const a = entry("中文课名".repeat(16) + ",X;Y", [early, late]),
    b = entry("other", [{ ...early }]);
  const text = makeIcs([a, b]);
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(text, /DTSTART:20270313T160000Z/);
  assert.match(text, /DTSTART:20270315T150000Z/);
  assert.match(text, /DTEND:20270315T180000Z/);
  assert.match(text.replace(/\r\n /g, ""), /\\,X\\;Y/);
  assert.ok(
    text.split("\r\n").every((line) => Buffer.byteLength(line, "utf8") <= 75),
  );
});

test("when beam search loses a feasible option, forward checking returns a full witness", () => {
  const a = course(
    "A",
    Array.from({ length: 16 }, (_, i) =>
      option("A" + i, [
        meeting({ start: i === 15 ? 600 : 480, end: i === 15 ? 650 : 530 }),
      ]),
    ),
  );
  const b = course(
    "B",
    Array.from({ length: 16 }, (_, i) =>
      option("B" + i, [meeting({ start: 540, end: 585 })]),
    ),
  );
  const c = course(
    "C",
    Array.from({ length: 17 }, (_, i) =>
      option("C" + i, [meeting({ start: 480, end: 530 })]),
    ),
  );
  const result = find([a, b, c]);
  assert.equal(result.status, "matched");
  assert.ok(result.limited);
  assert.ok(
    result.plans.every(
      (p) =>
        p.picks.length === 3 &&
        p.picks.find((x) => x.code === "A")?.id === "A15",
    ),
  );
});

test("six courses with ten multi-meeting packages each solve locally within one second", (t) => {
  const groups = Array.from({ length: 6 }, (_, c) =>
    course(
      "PERF " + c,
      Array.from({ length: 10 }, (_, o) =>
        option("pkg" + o, [
          meeting({
            type: "LE",
            days: [1, 3, 5],
            start: 420 + c * 100 + o,
            end: 465 + c * 100 + o,
          }),
          meeting({
            type: "DI",
            days: [2, 4],
            start: 420 + c * 100 + o,
            end: 455 + c * 100 + o,
          }),
          meeting({
            type: "FI",
            date: "2027-03-16",
            start: 420 + c * 100,
            end: 465 + c * 100,
          }),
        ]),
      ),
    ),
  );
  const start = performance.now(),
    result = find(groups),
    elapsed = performance.now() - start;
  t.diagnostic("6 × 10 booking packages: " + elapsed.toFixed(1) + "ms");
  assert.equal(result.status, "matched");
  assert.equal(result.plans.length, 5);
  assert.ok(result.plans.every((plan) => plan.picks.length === 6));
  assert.ok(elapsed < 1000, "Expected <1000ms, measured " + elapsed.toFixed(1));
});

test("bundled WI27 finals and midquarter one-off sessions retain their actual calendar dates", () => {
  const catalog: Catalog = JSON.parse(
    readFileSync(
      new URL("../public/data/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const all = catalog.courses.flatMap((c) =>
    c.options.flatMap((o) => o.meetings),
  );
  const final = all.find((m) => m.type === "FI" && m.date === "2027-03-16")!;
  const once = all.find(
    (m) => m.date === "2027-01-29" && !["FI", "FE"].includes(m.type),
  )!;
  assert.ok(final && once);
  assert.deepEqual(dates(final), ["2027-03-16"]);
  assert.deepEqual(dates(once), ["2027-01-29"]);
});
