export type Point = [number, number];
export type RouteBuilding = {
  name: string;
  node: number;
  anchor: "entrance" | "nearby";
  osm: string;
};
export type RouteGraph = {
  snapshot: string;
  nodes: Point[];
  edges: [number, number, number, number][];
  buildings: Record<string, RouteBuilding>;
  outlines: Point[][];
};
type Edge = { to: number; length: number; avoid: boolean };
const networks = new WeakMap<RouteGraph, Edge[][]>();
let graphPromise: Promise<RouteGraph> | undefined;

export function loadRouteGraph() {
  if (!graphPromise) {
    graphPromise = fetch(`${import.meta.env.BASE_URL}data/routes-graph.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load campus paths");
        const graph: RouteGraph = await response.json();
        if (
          !graph.buildings ||
          !Array.isArray(graph.nodes) ||
          !Array.isArray(graph.edges)
        )
          throw new Error("Invalid campus map");
        return graph;
      })
      .catch((error) => {
        graphPromise = undefined;
        throw error;
      });
  }
  return graphPromise;
}

function network(graph: RouteGraph) {
  const saved = networks.get(graph);
  if (saved) return saved;
  const edges: Edge[][] = graph.nodes.map(() => []);
  for (const [a, b, length, blocked] of graph.edges) {
    edges[a].push({ to: b, length, avoid: !!blocked });
    edges[b].push({ to: a, length, avoid: !!blocked });
  }
  networks.set(graph, edges);
  return edges;
}

/** Binary min heap of [tentative path length, node]. */
class DistanceQueue {
  items: [number, number][] = [];

  push(item: [number, number]) {
    let child = this.items.length;
    this.items.push(item);
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (this.items[parent][0] <= item[0]) break;
      this.items[child] = this.items[parent];
      child = parent;
    }
    this.items[child] = item;
  }

  take() {
    const first = this.items[0],
      last = this.items.pop()!;
    if (!this.items.length) return first;
    let parent = 0;
    while (2 * parent + 1 < this.items.length) {
      let child = 2 * parent + 1;
      if (
        child + 1 < this.items.length &&
        this.items[child + 1][0] < this.items[child][0]
      )
        child++;
      if (last[0] <= this.items[child][0]) break;
      this.items[parent] = this.items[child];
      parent = child;
    }
    this.items[parent] = last;
    return first;
  }
}

export function walkingPath(
  graph: RouteGraph,
  from: string,
  to: string,
  avoidSteps = false,
): number[] {
  const start = graph.buildings[from]?.node,
    end = graph.buildings[to]?.node;
  if (start === undefined || end === undefined) return [];
  const neighbors = network(graph);
  const distance = new Float64Array(graph.nodes.length).fill(Infinity);
  const prev = new Int32Array(graph.nodes.length).fill(-1);
  const queue = new DistanceQueue();
  distance[start] = 0;
  queue.push([0, start]);
  while (queue.items.length) {
    const [cost, node] = queue.take();
    if (cost !== distance[node]) continue;
    if (node === end) break;
    for (const edge of neighbors[node]) {
      const candidate = cost + edge.length;
      if ((avoidSteps && edge.avoid) || candidate >= distance[edge.to])
        continue;
      distance[edge.to] = candidate;
      prev[edge.to] = node;
      queue.push([candidate, edge.to]);
    }
  }
  if (!Number.isFinite(distance[end])) return [];
  const route: number[] = [];
  for (let next = end; next >= 0; next = prev[next]) route.push(next);
  return route.reverse();
}
