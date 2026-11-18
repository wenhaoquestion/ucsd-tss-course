export type Lang = "en" | "zh";
export type T = (english: string, chinese: string) => string;
export interface Meeting {
  type: string;
  days: number[];
  start: number | null;
  end: number | null;
  building: string;
  room: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  weeks?: number[];
  remote?: boolean;
  sectionId?: string;
}
export interface Option {
  id: string;
  label: string;
  instructor: string;
  sectionId: string;
  sectionIds?: string[];
  packageCode?: string;
  waitlistOnly?: boolean;
  meetings: Meeting[];
  available: number | null;
  capacity: number | null;
  waitlist: number | null;
  tssUrl?: string;
}
export interface Course {
  code: string;
  title: string;
  units: string;
  instructors: string[];
  options: Option[];
  description?: string;
  restrictions?: string;
}
export interface Catalog {
  term: string;
  source: string;
  observedAt: string | null;
  courses: Course[];
}
export interface Selection {
  code: string;
  id: string;
}
export interface Entry {
  course: Course;
  option: Option;
}
export interface Grade {
  instructor: string;
  term: string;
  actual: number | null;
  expected: number | null;
  hours: number | null;
  responses: number | null;
  recommend: number | null;
}
export interface Point {
  at: string;
  available: number | null;
  capacity: number | null;
  waitlist: number | null;
}
export interface Series {
  term: string;
  section: string | null;
  firstPass?: string;
  points: Point[];
}
export interface Busy {
  day: number;
  start: number;
  end: number;
}
export interface Prefs {
  early: number;
  minGap: number;
  speed: number;
  buffer: number;
  stepFree: boolean;
  busy: Busy[];
  locked: string[];
  teachers: Record<string, string>;
}
export const defaults: Prefs = {
  early: 0,
  minGap: 0,
  speed: 80,
  buffer: 2,
  stepFree: false,
  busy: [],
  locked: [],
  teachers: {},
};
export const tz = "America/Los_Angeles";
export const firstDay = "2027-01-04";
export const lastDay = "2027-03-12";
export const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const dayZh = ["一", "二", "三", "四", "五", "六", "日"];
export function norm(s: string) {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
export const clock = (m: number) =>
  String(Math.floor(m / 60)).padStart(2, "0") +
  ":" +
  String(m % 60).padStart(2, "0");
export const parseClock = (s: string) =>
  Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const shortTime = (m: number) =>
  String(Math.floor(m / 60) % 12 || 12) + ":" + String(m % 60).padStart(2, "0");
export const place = (m: Meeting) =>
  [m.building, m.room].filter(Boolean).join(" ") ||
  (m.remote ? "RCLAS" : "TBA");
export function entries(p: Selection[], by: Map<string, Course>): Entry[] {
  return p.flatMap((s) => {
    const course = by.get(s.code),
      option = course?.options.find((o) => o.id === s.id);
    return course && option ? [{ course, option }] : [];
  });
}
export function trustedBooking(o: Option) {
  try {
    const u = new URL(o.tssUrl || "");
    if (
      u.protocol === "https:" &&
      ["sis.ucsd.edu", "tss.ucsd.edu"].includes(u.hostname) &&
      !u.username &&
      !u.password
    )
      return u.href;
  } catch {}
  return "https://sis.ucsd.edu/";
}
export function localAsset(path: string) {
  return new URL(import.meta.env.BASE_URL + path, document.baseURI).href;
}
