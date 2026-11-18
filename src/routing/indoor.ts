import type { Point } from "./graph";

type Polygon = { outer: Point[]; holes?: Point[][] };
type Room = {
  id?: string;
  label: string;
  scheduleKey?: string | null;
  footprint?: Polygon;
  labelAt?: Point;
};
export type Floor = {
  id: string;
  label: string;
  shortLabel: string;
  outline: Polygon[];
  rooms: Room[];
  unplaced?: Room[];
};
export type IndoorLayout = {
  building: string;
  name: string;
  floors: Floor[];
  scheduleAliases?: { scheduleKey: string; room: string }[];
};
const publicLayouts =
  "https://wenhaoquestion.github.io/ucsd-classrooms/indoor/layouts/";
const requests = new Map<string, Promise<IndoorLayout | null>>();
let index: Promise<Set<string>> | undefined;

function publicJson(path: string) {
  return fetch(publicLayouts + path, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(8000),
  }).then((res) => {
    if (!res.ok) throw new Error("Unable to load public floor plans");
    return res.json();
  });
}

function buildingIndex() {
  index ??= publicJson("index.json")
    .then((data) => {
      if (data.schemaVersion !== 1 || !Array.isArray(data.buildings))
        throw new Error("Invalid floor-plan index");
      return new Set<string>(data.buildings);
    })
    .catch((error) => {
      index = undefined;
      throw error;
    });
  return index;
}

export function loadIndoorLayout(code: string) {
  if (!/^[A-Z0-9-]{1,12}$/.test(code)) return Promise.resolve(null);
  const cached = requests.get(code);
  if (cached) return cached;
  const request = buildingIndex()
    .then(async (buildings): Promise<IndoorLayout | null> => {
      if (!buildings.has(code)) return null;
      const data = await publicJson(code + ".json");
      if (
        data.schemaVersion !== 1 ||
        data.building !== code ||
        !["facilities-plan", "source-traced"].includes(data.geometryStatus) ||
        !Array.isArray(data.floors) ||
        data.sources?.some(
          (source: { access?: string; localFile?: string }) =>
            source.access === "authenticated" || source.localFile,
        )
      )
        return null;
      return data;
    })
    .catch((error) => {
      requests.delete(code);
      throw error;
    });
  requests.set(code, request);
  return request;
}

export function findRoom(
  layout: IndoorLayout,
  number: string,
): { floor: Floor; room: Room } | undefined {
  const normalized = (value: string) =>
    value.trim().toUpperCase().replace(/\s+/g, "");
  const key = normalized(number);
  if (!key) return undefined;
  const alias = layout.scheduleAliases?.find(
    (entry) => normalized(entry.scheduleKey) === key,
  );
  const candidates = layout.floors.flatMap((floor) =>
    [...floor.rooms, ...(floor.unplaced ?? [])].map((room) => ({
      floor,
      room,
    })),
  );
  if (alias) {
    const explicit = candidates.find(({ room }) => room.id === alias.room);
    if (explicit) return explicit;
  }
  const explicit = candidates.filter(
    ({ room }) => room.scheduleKey && normalized(room.scheduleKey) === key,
  );
  const matches = explicit.length
    ? explicit
    : candidates.filter(({ room }) => normalized(room.label) === key);
  const first = matches[0];
  if (matches.length < 2) return first;
  if (matches.every(({ floor }) => floor.id === first.floor.id))
    return { floor: first.floor, room: { label: first.room.label } };
  return undefined;
}

export function polygonPath(polygon: Polygon) {
  return [polygon.outer, ...(polygon.holes ?? [])]
    .map(
      (ring) =>
        `M${ring.map((p) => p.map((v) => Number(v.toFixed(2))).join(",")).join("L")}Z`,
    )
    .join("");
}
