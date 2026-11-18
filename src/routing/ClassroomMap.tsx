import { useEffect, useMemo, useState } from "react";
import { Building2, Layers3, MapPin } from "lucide-react";
import {
  canShowClassroom,
  listedRoom,
  locationCode,
  routedBuildings,
} from "./index";
import type { RoutingLanguage, TransferLocation } from "./index";
import { drawCampusMap, mapHeight, mapWidth } from "./campus-drawing";
import { loadRouteGraph } from "./graph";
import type { RouteGraph } from "./graph";
import { findRoom, loadIndoorLayout, polygonPath } from "./indoor";
import type { Floor, IndoorLayout } from "./indoor";
import "./classroom.css";

function FloorDrawing({
  floor,
  highlight,
  label,
}: {
  floor: Floor;
  highlight: string | undefined;
  label: string;
}) {
  const drawings = floor.outline.map(polygonPath);
  const rooms = floor.rooms.filter((room) => room.footprint?.outer.length);
  const outlines = floor.outline.length
    ? floor.outline
    : rooms.map((room) => room.footprint!);
  const points = outlines.flatMap((part) => part.outer);
  const left = Math.min(...points.map(([x]) => x));
  const right = Math.max(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const bottom = Math.max(...points.map(([, y]) => y));
  const margin = Math.max(right - left, bottom - top) * 0.08 + 1;
  const selected = highlight
    ? rooms.find((room) => room.id === highlight)
    : undefined;
  const ring = selected?.footprint?.outer;
  const anchor =
    selected?.labelAt ??
    (ring && [
      ring.reduce((sum, [x]) => sum + x, 0) / ring.length,
      ring.reduce((sum, [, y]) => sum + y, 0) / ring.length,
    ]);
  const size = Math.max(right - left, bottom - top) / 27;
  return (
    <svg
      className="qp-classroom-drawing"
      viewBox={`${left - margin} ${top - margin} ${right - left + margin * 2} ${bottom - top + margin * 2}`}
      role="img"
      aria-label={label}
    >
      {drawings.map((d, i) => (
        <path className="qp-floor-outline" d={d} fillRule="evenodd" key={i} />
      ))}
      {rooms.map((room) => (
        <path
          className={
            highlight && room.id === highlight
              ? "qp-room-highlight"
              : "qp-room-outline"
          }
          d={polygonPath(room.footprint!)}
          fillRule="evenodd"
          key={room.id ?? room.label}
        />
      ))}
      {anchor && selected && (
        <text
          className="qp-room-number"
          x={anchor[0]}
          y={anchor[1]}
          fontSize={size}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {selected.scheduleKey || selected.label}
        </text>
      )}
    </svg>
  );
}

export default function ClassroomMap({
  place,
  locale = "en",
  showTitle = true,
}: {
  place: TransferLocation;
  locale?: RoutingLanguage;
  showTitle?: boolean;
}) {
  const zh = locale === "zh";
  const code = locationCode(place);
  const room = listedRoom(place);
  const [tab, setTab] = useState<"campus" | "floor" | null>(null);
  const [floorId, setFloorId] = useState("");
  const [map, setMap] = useState<RouteGraph | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [indoor, setIndoor] = useState<{
    code: string;
    layout: IndoorLayout | null;
    failed?: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  const hasCampusMap = routedBuildings.includes(code);
  const hasClassroom = canShowClassroom(place);
  useEffect(() => {
    let active = true;
    if (hasCampusMap) {
      loadRouteGraph()
        .then((graph) => {
          if (active) setMap(graph);
        })
        .catch(() => {
          if (active) setMapFailed(true);
        });
    }
    if (hasClassroom) {
      loadIndoorLayout(code)
        .then((layout) => {
          if (active) setIndoor({ code, layout });
        })
        .catch(() => {
          if (active) setIndoor({ code, layout: null, failed: true });
        });
    }
    return () => {
      active = false;
    };
  }, [code, hasCampusMap, hasClassroom, retry]);
  const campusBuilding = map?.buildings[code];
  const artwork = useMemo(() => {
    if (!map || !campusBuilding) return null;
    return drawCampusMap(map, [map.nodes[campusBuilding.node]], 240, 160);
  }, [map, campusBuilding]);
  const data = indoor?.code === code ? indoor : undefined;
  const layout = data?.layout;
  const matched = useMemo(
    () => (layout ? findRoom(layout, room) : undefined),
    [layout, room],
  );
  const selection =
    tab ?? (matched || (!hasCampusMap && layout) ? "floor" : "campus");
  const floor =
    layout?.floors.find((level) => level.id === floorId) ??
    matched?.floor ??
    layout?.floors[0];
  const floorHasGeometry =
    floor &&
    (floor.outline.length ||
      floor.rooms.some((entry) => entry.footprint?.outer.length));
  const title = [code, room].filter(Boolean).join(" ");
  const buildingName = campusBuilding?.name ?? layout?.name;
  const loadAgain = () => {
    setIndoor(undefined);
    setMapFailed(false);
    setRetry((attempt) => attempt + 1);
  };

  return (
    <section
      className="qp-classroom"
      aria-label={zh ? `${title} 教室位置` : `Classroom location for ${title}`}
    >
      {(showTitle || buildingName) && (
        <div className="qp-classroom-heading">
          {showTitle && (
            <span className="qp-classroom-pin">
              <MapPin size={22} aria-hidden="true" />
            </span>
          )}
          <div>
            {showTitle && (
              <strong className="qp-classroom-name">{title}</strong>
            )}
            {buildingName && <span>{buildingName}</span>}
          </div>
        </div>
      )}

      <div
        className="qp-classroom-tabs"
        role="group"
        aria-label={zh ? "地图视图" : "Map view"}
      >
        <button
          type="button"
          aria-pressed={selection === "campus"}
          onClick={() => setTab("campus")}
        >
          <Building2 size={16} aria-hidden="true" />{" "}
          {zh ? "校园位置" : "Campus"}
        </button>
        <button
          type="button"
          aria-pressed={selection === "floor"}
          onClick={() => setTab("floor")}
        >
          <Layers3 size={16} aria-hidden="true" />{" "}
          {zh ? "楼层平面图" : "Floor plan"}
        </button>
      </div>

      {selection === "campus" &&
        (artwork ? (
          <>
            <svg
              className="qp-classroom-campus"
              viewBox={`0 0 ${mapWidth} ${mapHeight}`}
              role="img"
              aria-label={
                zh ? `${title} 的校园位置` : `Campus map for ${title}`
              }
            >
              <path className="qp-campus-outline" d={artwork.outlines} />
              <path className="qp-campus-paths" d={artwork.paths} />
              <g
                transform={`translate(${artwork.points[0][0]},${artwork.points[0][1]})`}
              >
                <circle className="qp-campus-marker-ring" r="15" />
                <circle className="qp-campus-marker" r="6" />
                <text className="qp-campus-label" x="18" y="-12">
                  {code}
                </text>
              </g>
              <text className="qp-campus-north" x="502" y="20" textAnchor="end">
                N ↑
              </text>
            </svg>
            <p className="qp-classroom-note">
              {campusBuilding?.anchor === "entrance"
                ? zh
                  ? "标记为已绘制入口。"
                  : "Marker shows a mapped entrance."
                : zh
                  ? "标记为楼旁步道。"
                  : "Marker shows a walkway next to the building."}
              {" · "}
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
              >
                © OpenStreetMap contributors
              </a>
            </p>
          </>
        ) : (
          <div className="qp-classroom-message">
            {mapFailed ? (
              <>
                <p>
                  {zh ? "校园地图暂时无法载入。" : "Campus map could not load."}
                </p>
                <button type="button" onClick={loadAgain}>
                  {zh ? "重试" : "Retry"}
                </button>
              </>
            ) : hasCampusMap ? (
              <p role="status">
                {zh ? "正在载入校园地图…" : "Loading campus map…"}
              </p>
            ) : (
              <p>
                {zh
                  ? "此楼尚未匹配校园步道点。"
                  : "This building has no mapped pedestrian access point yet."}
              </p>
            )}
          </div>
        ))}

      {selection === "floor" &&
        (floor ? (
          <>
            <label className="qp-floor-select">
              {zh ? "楼层" : "Floor"}
              <select
                value={floor.id}
                onChange={(event) => setFloorId(event.target.value)}
              >
                {layout!.floors.map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.label}
                  </option>
                ))}
              </select>
            </label>
            {floorHasGeometry ? (
              <FloorDrawing
                floor={floor}
                highlight={
                  matched?.floor.id === floor.id ? matched.room.id : undefined
                }
                label={
                  zh
                    ? `${title} · ${floor.label} 平面图`
                    : `${title} floor plan · ${floor.label}`
                }
              />
            ) : (
              <p className="qp-classroom-message">
                {zh
                  ? "该楼层目前有房间目录。"
                  : "The source lists rooms for this floor."}
              </p>
            )}
            <p className="qp-classroom-note">
              {matched ? (
                <>
                  {title} · {matched.floor.label}.
                  {matched.room.footprint
                    ? zh
                      ? " 请以现场标识为准。"
                      : " Follow signs at the building."
                    : zh
                      ? " 公开档案仅列出该教室所在楼层。"
                      : " The public archive lists this room by floor only."}
                </>
              ) : zh ? (
                "公开楼层档案中尚未匹配到此教室。"
              ) : (
                "The published plans do not identify this classroom."
              )}
            </p>
            <p className="qp-classroom-note">
              {zh
                ? "楼层数据来自 UCSD Classroom Explorer 的公开档案。"
                : "Floor data from the public UCSD Classroom Explorer archive."}
            </p>
          </>
        ) : (
          <div className="qp-classroom-message">
            {data?.failed ? (
              <>
                <p>
                  {zh
                    ? "公开楼层档案暂时无法载入。"
                    : "The public floor plans could not load."}
                </p>
                <button type="button" onClick={loadAgain}>
                  {zh ? "重试" : "Retry"}
                </button>
              </>
            ) : data ? (
              <p>
                {zh
                  ? "此楼暂无公开平面图。"
                  : "No public floor plan is available for this building."}
              </p>
            ) : (
              <p role="status">
                {zh ? "正在载入楼层平面图…" : "Loading floor plans…"}
              </p>
            )}
          </div>
        ))}
    </section>
  );
}
