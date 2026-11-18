import type { Prefs, Selection, Lang } from "./model";
import { defaults } from "./model";
export interface Watch {
  sectionId: string;
  code: string;
  threshold: number;
  remote?: { id: string; token: string };
  previous?: number | null;
  at?: string;
}
export interface Saved {
  version: 1;
  plans: [Selection[], Selection[]];
  active: 0 | 1;
  lang: Lang;
  prefs: Prefs;
  watches: Watch[];
  first: string;
  second: string;
  example: boolean;
}
export function initial(): Saved {
  return {
    version: 1,
    plans: [[], []],
    active: 0,
    lang: navigator.language.startsWith("zh") ? "zh" : "en",
    prefs: { ...defaults },
    watches: [],
    first: "",
    second: "",
    example: true,
  };
}
let opened: Promise<IDBDatabase> | undefined;
function db() {
  return (opened ??= new Promise((res, rej) => {
    const r = indexedDB.open("quarterplan", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("app");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function valid(x: unknown): x is Saved {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as Saved).version === 1 &&
    Array.isArray((x as Saved).plans) &&
    (x as Saved).plans.length === 2
  );
}
export async function readSaved() {
  try {
    const d = await db(),
      v = await new Promise<unknown>((r, j) => {
        const req = d.transaction("app").objectStore("app").get("state");
        req.onsuccess = () => r(req.result);
        req.onerror = () => j(req.error);
      });
    if (valid(v)) return v;
  } catch {}
  try {
    const v = JSON.parse(localStorage.getItem("quarterplan-state") || "null");
    return valid(v) ? v : null;
  } catch {
    return null;
  }
}
export async function writeSaved(v: Saved) {
  try {
    const d = await db();
    await new Promise<void>((r, j) => {
      const tx = d.transaction("app", "readwrite");
      tx.objectStore("app").put(v, "state");
      tx.oncomplete = () => r();
      tx.onerror = () => j(tx.error);
    });
  } catch {
    localStorage.setItem("quarterplan-state", JSON.stringify(v));
  }
}
export function shareUrl(plan: Selection[]) {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("term", "WI27");
  u.searchParams.set("plan", JSON.stringify(plan.map((s) => [s.code, s.id])));
  return u.href;
}
export function readShare(): Selection[] | null {
  const q = new URLSearchParams(location.search);
  if (q.get("term") !== "WI27" || !q.has("plan")) return null;
  try {
    const rows = JSON.parse(q.get("plan")!);
    return Array.isArray(rows)
      ? rows
          .slice(0, 25)
          .filter(
            (s: unknown) =>
              Array.isArray(s) &&
              s.length === 2 &&
              s.every((a) => typeof a === "string" && a.length < 100),
          )
          .map(([code, id]: string[]) => ({ code, id }))
      : null;
  } catch {
    return null;
  }
}
