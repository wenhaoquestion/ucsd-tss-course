import type { Catalog, Entry, Selection } from "./model";
import { isFinal, overlap, timed, mask } from "./calendar";
import { estimateTransfer } from "./routing";
const clash = (a: Entry, b: Entry) =>
  a.option.meetings.some((x) => b.option.meetings.some((y) => overlap(x, y)));
export function seedPlan(cat: Catalog): Selection[] {
  const example = [
    { code: "CSE 12", id: "WI27:165078" },
    { code: "MATH 20C", id: "WI27:163118" },
    { code: "PSYC 1", id: "WI27:163966" },
  ];
  if (
    example.every((p) =>
      cat.courses
        .find((c) => c.code === p.code)
        ?.options.some((o) => o.id === p.id),
    )
  )
    return example;
  const want = [
    "CSE 12",
    "MATH 18",
    "COGS 1",
    "CSE 100",
    "BILD 1",
    "MATH 20C",
    "CHEM 6A",
    "PSYC 1",
    "CSE 11",
  ];
  const cs = want
    .map((c) => cat.courses.find((x) => x.code === c))
    .filter((x) => x !== undefined);
  const candidates = cs
    .flatMap((course) =>
      course.options.slice(0, 12).map((option) => ({ course, option })),
    )
    .filter((e) => e.option.meetings.some((m) => timed(m) && !isFinal(m)));
  let best: Entry[] = [];
  let score = -Infinity;
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i],
        b = candidates[j];
      if (a.course === b.course || clash(a, b)) continue;
      let val = -10;
      for (const x of a.option.meetings)
        for (const y of b.option.meetings) {
          if (
            !timed(x) ||
            !timed(y) ||
            isFinal(x) ||
            isFinal(y) ||
            !(mask(x) & mask(y))
          )
            continue;
          const [l, r] = x.end <= y.start ? [x, y] : [y, x],
            gap = r.start - l.end;
          if (gap < 5 || gap > 25) continue;
          const route = estimateTransfer(l, r, gap);
          if (route.maxMinutes !== null && l.building !== r.building)
            val = Math.max(
              val,
              100 -
                Math.abs(gap - 10) +
                (route.status === "tight" || route.status === "late" ? 20 : 0),
            );
        }
      val -= i / 1000 + j / 10000;
      if (val > score) {
        score = val;
        best = [a, b];
      }
    }
  if (!best.length && candidates.length) best = [candidates[0]];
  const third = candidates.find(
    (e) =>
      best.every((x) => e.course.code !== x.course.code && !clash(e, x)) &&
      e.option.meetings.every((m) => !timed(m) || isFinal(m) || m.end <= 1080),
  );
  if (third) best.push(third);
  return best.map((e) => ({ code: e.course.code, id: e.option.id }));
}
