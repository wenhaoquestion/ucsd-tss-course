import {
  type Entry,
  type Course,
  type Prefs,
  type Selection,
  type Meeting,
} from "./model";
import {
  mask,
  overlap,
  timed,
  isFinal,
  orderTiles,
  scheduleTiles,
  gaps,
  type Tile,
} from "./calendar";
import { estimateTransfer, locationCode } from "./routing";

export interface SolveInput {
  courses: Course[];
  current: Selection[];
  prefs: Prefs;
}
export interface Solution {
  picks: Selection[];
  days: number;
  gaps: number;
  walk: number;
  moves: number;
  unknown: number;
  unverifiedWalks: number;
}
export interface SolveResult {
  plans: Solution[];
  reason: string[];
  limited: boolean;
  status: "matched" | "infeasible" | "limited" | "empty";
}
type Choice = {
  id: number;
  entry: Entry;
  tiles: Tile[];
  move: number;
  unknown: number;
  days: number;
};
type Group = { course: Course; choices: Choice[] };
type State = {
  picks: Choice[];
  tiles: Tile[];
  bits: number;
  days: number;
  gaps: number;
  walk: number;
  moves: number;
  unknown: number;
  unverifiedWalks: number;
};
const empty: State = {
  picks: [],
  tiles: [],
  bits: 0,
  days: 0,
  gaps: 0,
  walk: 0,
  moves: 0,
  unknown: 0,
  unverifiedWalks: 0,
};
const ranks = [
  (s: State) => s.days * 1000 + s.walk * 10 + s.unverifiedWalks + s.moves,
  (s: State) => s.walk * 100 + s.unverifiedWalks * 10 + s.gaps / 100 + s.moves,
  (s: State) => s.moves * 100 + s.walk + s.unknown + s.unverifiedWalks,
  (s: State) => s.gaps + s.walk * 5 + s.unknown * 10 + s.unverifiedWalks,
];
function countDays(bits: number) {
  let n = 0;
  for (; bits; bits &= bits - 1) n++;
  return n;
}

/** Forward-checking search for a feasibility witness when heuristic optimization
 * dropped all its candidates. A resource limit is explicitly inconclusive. */
function feasible(
  groups: Group[],
  compatible: (a: Choice, b: Choice) => boolean,
) {
  let explored = 0,
    stopped = false;
  const deadline = performance.now() + 180;
  function visit(
    remaining: Choice[][],
    picked: Choice[],
  ): Choice[] | undefined {
    if (!remaining.length) return picked;
    if (
      ++explored > 30000 ||
      ((explored & 63) === 0 && performance.now() > deadline)
    ) {
      stopped = true;
      return;
    }
    let best = 0;
    for (let i = 1; i < remaining.length; i++)
      if (remaining[i].length < remaining[best].length) best = i;
    const others = remaining.filter((_, i) => i !== best);
    for (const choice of remaining[best]) {
      const domains = others.map((domain) =>
        domain.filter((o) => compatible(choice, o)),
      );
      if (domains.some((domain) => !domain.length)) continue;
      const match = visit(domains, [...picked, choice]);
      if (match || stopped) return match;
    }
  }
  const picks = visit(
    groups.map((g) => g.choices),
    [],
  );
  return { picks, stopped };
}

export function solve({ courses, current, prefs }: SolveInput): SolveResult {
  const reasons = new Map<string, number>();
  function reject(reason: string) {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const failures = () =>
    [...reasons]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s]) => s);
  if (!courses.length)
    return { plans: [], reason: [], limited: false, status: "empty" };
  const curr = new Map(current.map((s) => [s.code, s.id])),
    locked = new Set(prefs.locked);
  const busy: Meeting[] = prefs.busy.map((b) => ({
    type: "busy",
    days: [b.day],
    start: b.start,
    end: b.end,
    building: "",
    room: "",
  }));
  const minGap = Math.max(0, prefs.minGap);
  let serial = 0;
  const groups: Group[] = courses
    .map((course) => {
      const choices: Choice[] = [];
      for (const option of course.options) {
        if (locked.has(course.code) && option.id !== curr.get(course.code)) {
          reject(course.code + " · locked");
          continue;
        }
        if (
          prefs.teachers[course.code] &&
          option.instructor !== prefs.teachers[course.code]
        ) {
          reject(course.code + " · instructor");
          continue;
        }
        const ms = option.meetings;
        if (
          ms.some(
            (m) =>
              timed(m) &&
              mask(m) !== 0n &&
              !isFinal(m) &&
              m.start < prefs.early,
          )
        ) {
          reject(course.code + " · early");
          continue;
        }
        if (ms.some((m) => busy.some((b) => overlap(m, b)))) {
          reject(course.code + " · busy");
          continue;
        }
        if (
          ms.some((m, i) => ms.slice(i + 1).some((n) => overlap(m, n, minGap)))
        ) {
          reject(course.code + " · overlap / minimum gap");
          continue;
        }
        const entry = { course, option },
          tiles = scheduleTiles([entry]);
        let days = 0;
        for (const t of tiles)
          if (!isFinal(t.m) && locationCode(t.m) !== "RCLAS" && !t.m.remote)
            days |= 1 << (t.day - 1);
        choices.push({
          id: serial++,
          entry,
          tiles,
          days,
          move: Number(curr.get(course.code) !== option.id),
          unknown: ms.length
            ? ms.filter((m) => !timed(m) || mask(m) === 0n).length
            : 1,
        });
      }
      if (!course.options.length) reject(course.code + " · no packages");
      return { course, choices };
    })
    .sort((a, b) => a.choices.length - b.choices.length);
  if (groups.some((g) => !g.choices.length))
    return {
      plans: [],
      reason: failures(),
      limited: false,
      status: "infeasible",
    };

  // Compatibility is a property of whole booking packages. Travel and idle time
  // require the completed day's chronological neighbors and cannot be added pairwise.
  const pairs = new Map<number, boolean>();
  function compatible(a: Choice, b: Choice) {
    const key = Math.min(a.id, b.id) * serial + Math.max(a.id, b.id);
    const cached = pairs.get(key);
    if (cached !== undefined) return cached;
    const ok = !a.entry.option.meetings.some((m) =>
      b.entry.option.meetings.some((n) => overlap(m, n, minGap)),
    );
    pairs.set(key, ok);
    if (!ok)
      reject(
        a.entry.course.code +
          " / " +
          b.entry.course.code +
          " · overlap / minimum gap",
      );
    return ok;
  }
  const travel = new WeakMap<
    Meeting,
    WeakMap<Meeting, { shortfall: number; unknown: boolean }>
  >();
  function walkBetween(a: Meeting, b: Meeting, minutes: number) {
    let dest = travel.get(a);
    if (!dest) {
      dest = new WeakMap();
      travel.set(a, dest);
    }
    let value = dest.get(b);
    if (!value) {
      const result = estimateTransfer(a, b, minutes, {
        speedMPerMin: prefs.speed,
        bufferMinutes: prefs.buffer,
        stepFree: prefs.stepFree,
      });
      value = {
        shortfall: Math.max(0, (result.maxMinutes ?? 0) - minutes),
        unknown: result.status === "unknown",
      };
      dest.set(b, value);
    }
    return value;
  }
  function add(state: State, choice: Choice): State {
    const tiles = orderTiles([...state.tiles, ...choice.tiles]),
      bits = state.bits | choice.days;
    let idle = 0,
      walk = 0,
      unverifiedWalks = 0;
    for (const g of gaps(tiles, Infinity)) {
      const r = walkBetween(g.from.m, g.to.m, g.minutes);
      idle += g.minutes;
      walk += r.shortfall;
      unverifiedWalks += Number(r.unknown);
    }
    return {
      picks: [...state.picks, choice],
      tiles,
      bits,
      days: countDays(bits),
      gaps: idle,
      walk,
      unverifiedWalks,
      moves: state.moves + choice.move,
      unknown: state.unknown + choice.unknown,
    };
  }

  let states: State[] = [empty],
    limited = false;
  for (const group of groups) {
    let next: State[] = [];
    for (const state of states)
      for (const choice of group.choices) {
        if (state.picks.every((a) => compatible(a, choice)))
          next.push(add(state, choice));
      }
    if (next.length > 128) {
      limited = true;
      const keep = new Set<State>();
      for (const rank of ranks) {
        next.sort((a, b) => rank(a) - rank(b));
        for (const state of next.slice(0, 32)) keep.add(state);
      }
      next = [...keep];
    }
    states = next;
    if (!states.length) break;
  }
  if (!states.length) {
    if (!limited)
      return {
        plans: [],
        reason: failures(),
        limited: false,
        status: "infeasible",
      };
    const rescue = feasible(groups, compatible);
    if (!rescue.picks)
      return {
        plans: [],
        reason: rescue.stopped ? [] : failures(),
        limited: rescue.stopped,
        status: rescue.stopped ? "limited" : "infeasible",
      };
    states = [rescue.picks.reduce(add, empty)];
  }
  const selected = new Set<State>();
  for (const rank of ranks)
    selected.add(states.reduce((a, b) => (rank(a) <= rank(b) ? a : b)));
  for (const state of states.sort((a, b) => ranks[0](a) - ranks[0](b))) {
    if (selected.size >= 5) break;
    selected.add(state);
  }
  const plans = [...selected].map(
    ({ picks, days, gaps, walk, moves, unknown, unverifiedWalks }) => ({
      picks: picks.map(({ entry }) => ({
        code: entry.course.code,
        id: entry.option.id,
      })),
      days,
      gaps,
      walk,
      moves,
      unknown,
      unverifiedWalks,
    }),
  );
  return { plans, reason: [], limited, status: "matched" };
}
