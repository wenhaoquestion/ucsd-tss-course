import table from "./distances.json";

export type TransferLocation = {
  building?: string | null;
  room?: string | null;
  remote?: boolean;
  /** Explicit floor from a source or the student, with ground level represented as zero. */
  floor?: number | null;
};
export type RoutingOptions = {
  speedMPerMin?: number;
  bufferMinutes?: number;
  stepFree?: boolean;
};
export type TransferReason =
  | "sameRoom"
  | "sameBuilding"
  | "path"
  | "unverifiedStepFree"
  | "remote"
  | "unspecified"
  | "unmapped"
  | "disconnected";
export type TransferEstimate = {
  status: "comfortable" | "tight" | "late" | "unknown";
  coverage: "room" | "building" | "unknown" | "remote";
  minMinutes: number | null;
  maxMinutes: number | null;
  distanceMeters: number | null;
  reason: string;
  reasonCode: TransferReason;
};
export type RoutingLanguage = "en" | "zh";

export const routeSnapshot = table.snapshot;
export const routedBuildings: readonly string[] = table.codes;
const buildingIndices = new Map(table.codes.map((code, i) => [code, i]));
const remote =
  /^(RCLAS|REMOTE|ONLINE|WEB|VIRTUAL|ZOOM|ONLINE ASYNCHRONOUS|ONLINE SYNCHRONOUS)$/;
const unknown =
  /^(|TBA|TBD|TBC|ARR|ARRANGED|UNKNOWN|N\/A|NONE|-|—|TO BE ANNOUNCED|TO BE ARRANGED)$/;
const fullBuildingNames = new Map([
  ["MCTF - MARINE CONSERVATION AND TECHNOLOGY", "MCTF"],
  ["MEDICAL EDUCATION AND TELEMEDICINE CENTER", "MET"],
  ["SCIENCE AND ENGINEERING RESEARCH FACILITY", "SERF"],
  ["WARREN STUDENT ACTIVITY CENTER", "WSAC"],
]);

export function locationCode(location: TransferLocation) {
  if (location.remote) return "RCLAS";
  const code = (location.building ?? "").trim().toUpperCase();
  if (code === "EXTENDED STUDIES AND PUBLIC PROGRAMS") {
    // The public floor archive places these WI27 rooms in two different wings.
    const room = listedRoom(location);
    if (/^12[345]$/.test(room)) return "UNEXG";
    if (/^12[67]$/.test(room)) return "UNEXN";
  }
  return fullBuildingNames.get(code) ?? code;
}

const reasonText: Record<TransferReason, [string, string]> = {
  sameRoom: ["Both meetings use the same listed room.", "两节课在同一间教室。"],
  sameBuilding: [
    "Same building. The range allows for movement inside.",
    "两节课在同一栋楼，时间范围含楼内移动预留。",
  ],
  path: [
    "Mapped outdoor walk with an allowance for entering and leaving buildings.",
    "已匹配校园步道，另计出入楼预留时间。",
  ],
  unverifiedStepFree: [
    "Step-free access is unverified. Door widths, lifts and current closures can affect this trip.",
    "无台阶通行待核实，门宽、电梯和临时封闭均可能影响这段路。",
  ],
  remote: [
    "Online meeting. Choose where you will attend to estimate a walk.",
    "线上课程，请指定上网地点后估算步行。",
  ],
  unspecified: [
    "A meeting location is still to be announced.",
    "至少一节课的地点待定。",
  ],
  unmapped: [
    "A building has no matched pedestrian access point in this map.",
    "至少一栋楼尚未匹配到校园步道。",
  ],
  disconnected: [
    "No connected route for this walking profile.",
    "当前步行模式下没有已连通的路径。",
  ],
};

export function describeTransfer(
  result: TransferEstimate,
  lang: RoutingLanguage = "en",
) {
  return reasonText[result.reasonCode][lang === "zh" ? 1 : 0];
}

export function canShowClassroom(location: TransferLocation) {
  const code = locationCode(location);
  return !unknown.test(code) && !remote.test(code);
}

export function listedRoom(location: TransferLocation) {
  const room = (location.room ?? "").trim();
  return unknown.test(room.toUpperCase()) ? "" : room;
}

export function buildingDistance(
  a: string,
  b: string,
  stepFree = false,
): number | null {
  const start = buildingIndices.get(a.trim().toUpperCase());
  const end = buildingIndices.get(b.trim().toUpperCase());
  if (start === undefined || end === undefined) return null;
  if (start === end) return 0;
  const hi = Math.max(start, end);
  const index = (hi * (hi - 1)) / 2 + Math.min(start, end);
  const meters = (stepFree ? table.avoidSteps : table.walk)[index];
  return meters >= 0 ? meters : null;
}

function unavailable(
  code: TransferReason,
  coverage: TransferEstimate["coverage"] = "unknown",
): TransferEstimate {
  return {
    status: "unknown",
    coverage,
    distanceMeters: null,
    minMinutes: null,
    maxMinutes: null,
    reasonCode: code,
    reason: reasonText[code][0],
  };
}

function bounded(
  value: number | undefined,
  fallback: number,
  low: number,
  high: number,
) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(low, Math.min(high, value))
    : fallback;
}

export function estimateTransfer(
  from: TransferLocation,
  to: TransferLocation,
  gapMinutes: number,
  options: RoutingOptions = {},
): TransferEstimate {
  const a = locationCode(from),
    b = locationCode(to);
  if (remote.test(a) || remote.test(b)) return unavailable("remote", "remote");
  if (unknown.test(a) || unknown.test(b)) return unavailable("unspecified");
  const fromRoom = (from.room ?? "").trim().toUpperCase(),
    toRoom = (to.room ?? "").trim().toUpperCase();
  const sameRoom = a === b && !unknown.test(fromRoom) && fromRoom === toRoom;
  const sameBuilding = a === b;
  const meters = sameBuilding ? 0 : buildingDistance(a, b, options.stepFree);
  if (meters === null)
    return unavailable(
      buildingIndices.has(a) && buildingIndices.has(b)
        ? "disconnected"
        : "unmapped",
    );
  const speed = bounded(options.speedMPerMin, 80, 10, 200);
  const buffer = bounded(options.bufferMinutes, 2, 0, 60);
  // Indoor ranges are planning allowances. Unverified room numbers convey no floor data.
  const hasFloor = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n);
  const bothFloors = hasFloor(from.floor) && hasFloor(to.floor);
  const floors =
    sameBuilding && bothFloors
      ? Math.abs(from.floor! - to.floor!)
      : (hasFloor(from.floor) ? Math.abs(from.floor) : 0) +
        (hasFloor(to.floor) ? Math.abs(to.floor) : 0);
  const indoorMin = sameBuilding ? 1 : 2;
  const indoorMax = sameBuilding ? (bothFloors ? 3 : 5) : 6;
  const minMinutes = sameRoom
    ? 0
    : Math.ceil(meters / speed + indoorMin + floors * 0.5 + buffer);
  const maxMinutes = sameRoom
    ? 0
    : Math.ceil(meters / speed + indoorMax + floors * 1.5 + buffer);
  let code: TransferReason = sameRoom
    ? "sameRoom"
    : sameBuilding
      ? "sameBuilding"
      : "path";
  if (options.stepFree && !sameRoom) code = "unverifiedStepFree";
  let status: TransferEstimate["status"] = "unknown";
  if (Number.isFinite(gapMinutes) && code !== "unverifiedStepFree") {
    status =
      gapMinutes >= maxMinutes
        ? "comfortable"
        : gapMinutes < minMinutes
          ? "late"
          : "tight";
  }
  return {
    status,
    coverage: sameRoom ? "room" : "building",
    minMinutes,
    maxMinutes,
    distanceMeters: meters,
    reasonCode: code,
    reason: reasonText[code][0],
  };
}
