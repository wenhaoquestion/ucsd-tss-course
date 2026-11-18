import { useEffect, useMemo, useState } from "react";
import {
  classroomUrl,
  describeTransfer,
  estimateTransfer,
  locationCode,
  routedBuildings,
} from "./index";
import type {
  RoutingLanguage,
  RoutingOptions,
  TransferLocation,
} from "./index";
import { loadRouteGraph, walkingPath } from "./graph";
import type { Point, RouteGraph } from "./graph";
import "./route.css";

export type RouteMapProps = {
  from: TransferLocation;
  to: TransferLocation;
  gapMinutes: number;
  options?: RoutingOptions;
  term?: string;
  lang?: RoutingLanguage;
};
const width = 520,
  height = 220;

function drawMap(graph: RouteGraph, path: number[]) {
  if (!path.length) return null;
  const points = path.map((i) => graph.nodes[i]);
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const scale = Math.min(
    (width - 100) / Math.max(95, Math.max(...xs) - Math.min(...xs)),
    (height - 62) / Math.max(75, Math.max(...ys) - Math.min(...ys)),
  );
  const project = ([x, y]: Point): Point => [
    Math.round((x - cx) * scale + width / 2),
    Math.round((y - cy) * scale + height / 2),
  ];
  const visible = (p: Point) =>
    p[0] >= -30 && p[0] <= width + 30 && p[1] >= -30 && p[1] <= height + 30;
  const projected = graph.nodes.map(project);
  const nearbyPaths: string[] = [];
  for (const [a, b] of graph.edges)
    if (visible(projected[a]) || visible(projected[b]))
      nearbyPaths.push(`M${projected[a]}L${projected[b]}`);
  const outlines = graph.outlines.flatMap((ring) => {
    const ps = ring.map(project);
    return ps.some(visible)
      ? [
          `M${ps.join("L")}${ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? "Z" : ""}`,
        ]
      : [];
  });
  return {
    paths: nearbyPaths.join(""),
    outlines: outlines.join(""),
    route: points.map(project).join(" "),
    start: project(points[0]),
    end: project(points[points.length - 1]),
  };
}

export function RouteMap({
  from,
  to,
  gapMinutes,
  options,
  term,
  lang = "en",
}: RouteMapProps) {
  const zh = lang === "zh";
  const start = locationCode(from),
    end = locationCode(to);
  const result = estimateTransfer(from, to, gapMinutes, options);
  const canMap =
    routedBuildings.includes(start) && routedBuildings.includes(end);
  const [graph, setGraph] = useState<RouteGraph | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!canMap) return;
    let active = true;
    setFailed(false);
    loadRouteGraph()
      .then((data) => {
        if (active) setGraph(data);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [canMap, attempt]);
  const artwork = useMemo(() => {
    if (!graph || !canMap) return null;
    return drawMap(graph, walkingPath(graph, start, end, options?.stepFree));
  }, [graph, start, end, canMap, options?.stepFree]);
  const labels = zh
    ? {
        comfortable: "时间充足",
        tight: "时间紧张",
        late: "预计赶不上",
        unknown: "待核实",
      }
    : {
        comfortable: "Time to spare",
        tight: "Tight connection",
        late: "Likely late",
        unknown: "Unverified",
      };
  const roomLink = (place: TransferLocation) => {
    const url = classroomUrl(place, term);
    const label =
      [place.building, place.room].filter(Boolean).join(" ") || "TBA";
    return url ? (
      <a href={url} target="_blank" rel="noreferrer">
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  };
  return (
    <section
      className="qp-route"
      aria-label={zh ? "两课之间的路线" : "Class-to-class route"}
    >
      <p className="qp-route-metrics">
        <span>{zh ? "预计步行" : "Estimated walk"}</span>
        {result.minMinutes !== null && result.maxMinutes !== null ? (
          <>
            <strong>
              {result.minMinutes}
              {result.maxMinutes !== result.minMinutes
                ? `–${result.maxMinutes}`
                : ""}{" "}
              {zh ? "分钟" : "min"}
            </strong>
            {result.distanceMeters !== null && result.distanceMeters > 0 && (
              <small>· {result.distanceMeters} m</small>
            )}
          </>
        ) : (
          <strong>{zh ? "待核实" : "Unverified"}</strong>
        )}
      </p>
      {canMap && artwork && (
        <svg
          className="qp-route-map"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={
            zh
              ? `${start} 到 ${end} 的校园步道图`
              : `Campus walking route from ${start} to ${end}`
          }
        >
          <path
            d={artwork.outlines}
            fill="#e1e3db"
            stroke="#c7c9c1"
            strokeWidth="1"
          />
          <path
            d={artwork.paths}
            fill="none"
            stroke="#bcc1b6"
            strokeWidth="1.45"
          />
          <polyline
            points={artwork.route}
            fill="none"
            stroke="#fff"
            strokeWidth="7"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <polyline
            points={artwork.route}
            fill="none"
            stroke="#d63f26"
            strokeWidth="4"
            strokeDasharray="7 5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {[artwork.start, ...(start === end ? [] : [artwork.end])].map(
            ([x, y], i) => (
              <g key={i} transform={`translate(${x},${y})`}>
                <circle r="6.5" fill="#20231f" stroke="white" strokeWidth="2" />
                <text
                  x={x > width / 2 ? -10 : 10}
                  y="-9"
                  textAnchor={x > width / 2 ? "end" : "start"}
                  fontSize="14"
                  fontFamily="system-ui,sans-serif"
                  fontWeight="700"
                  fill="#20231f"
                  stroke="#fafaf6"
                  strokeWidth="3.5"
                  paintOrder="stroke"
                >
                  {i === 0 ? start : end}
                </text>
              </g>
            ),
          )}
          <text x="505" y="18" textAnchor="end" fontSize="11" fill="#61665d">
            N ↑
          </text>
        </svg>
      )}
      {canMap && !graph && !failed && (
        <p role="status">
          {zh ? "正在载入校园路网…" : "Loading campus paths…"}
        </p>
      )}
      {canMap && failed && (
        <p role="status">
          {zh ? "路线图加载失败。" : "Map could not be loaded."}{" "}
          <button type="button" onClick={() => setAttempt((v) => v + 1)}>
            {zh ? "重试" : "Retry"}
          </button>
        </p>
      )}
      <div className="qp-route-caption">
        <span className={`qp-route-state qp-route-${result.status}`}>
          {labels[result.status]}
          {(result.status === "late" || result.status === "tight") &&
            result.maxMinutes !== null &&
            ` · ${zh ? "最多迟到 " : "up to "}${Math.max(0, result.maxMinutes - gapMinutes)} ${zh ? "分钟" : "min late"}`}
        </span>
        <span className="qp-route-room-links">
          {roomLink(from)} <span aria-hidden="true">→</span> {roomLink(to)}
        </span>
      </div>
      {!canMap && <p>{describeTransfer(result, lang)}</p>}
      {artwork && (
        <a
          className="qp-route-credit"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap contributors
        </a>
      )}
      <details className="qp-route-details">
        <summary>{zh ? "路线详情" : "Route details"}</summary>
        {canMap && <p>{describeTransfer(result, lang)}</p>}
        {canMap && start !== end && (
          <p>
            {zh
              ? "用时含步速、楼内预留及个人缓冲。施工和实时入口开放情况待核实。"
              : "Times include your pace, indoor allowances and buffer. Construction and entrance availability are unverified."}
          </p>
        )}
        {artwork && graph && (
          <small>
            {[start, ...(start === end ? [] : [end])].map((code, i) => {
              const b = graph.buildings[code];
              return (
                <span key={code}>
                  {i > 0 ? " · " : ""}
                  {code}{" "}
                  {b.anchor === "entrance"
                    ? zh
                      ? "已标入口"
                      : "mapped entrance"
                    : zh
                      ? "楼旁步道"
                      : "near-building path"}
                </span>
              );
            })}
          </small>
        )}
        <footer>
          <a
            href="https://campusmap.ucsd.edu/"
            target="_blank"
            rel="noreferrer"
          >
            {zh ? "UCSD 官方地图 ↗" : "UCSD campus map ↗"}
          </a>
          {" · "}
          <a
            href={`${import.meta.env.BASE_URL}data/routes-sources.txt`}
            target="_blank"
            rel="noreferrer"
          >
            {zh ? "数据与精度" : "Data & accuracy"}
          </a>
        </footer>
      </details>
    </section>
  );
}
