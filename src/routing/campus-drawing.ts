import type { Point, RouteGraph } from "./graph";

export const mapWidth = 520;
export const mapHeight = 220;

export function drawCampusMap(
  graph: RouteGraph,
  points: Point[],
  minWidth = 95,
  minHeight = 75,
) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const scale = Math.min(
    (mapWidth - 100) / Math.max(minWidth, right - left),
    (mapHeight - 62) / Math.max(minHeight, bottom - top),
  );
  const project = ([x, y]: Point): Point => [
    Math.round((x - cx) * scale + mapWidth / 2),
    Math.round((y - cy) * scale + mapHeight / 2),
  ];
  const visible = ([x, y]: Point) =>
    x >= -30 && x <= mapWidth + 30 && y >= -30 && y <= mapHeight + 30;
  const projected = graph.nodes.map(project);
  const nearbyPaths: string[] = [];
  for (const [a, b] of graph.edges) {
    if (visible(projected[a]) || visible(projected[b]))
      nearbyPaths.push(`M${projected[a]}L${projected[b]}`);
  }
  const outlines = graph.outlines.flatMap((ring) => {
    const projectedRing = ring.map(project);
    const last = ring.at(-1);
    const closed = last && ring[0][0] === last[0] && ring[0][1] === last[1];
    return projectedRing.some(visible)
      ? [`M${projectedRing.join("L")}${closed ? "Z" : ""}`]
      : [];
  });
  return {
    paths: nearbyPaths.join(""),
    outlines: outlines.join(""),
    points: points.map(project),
  };
}
