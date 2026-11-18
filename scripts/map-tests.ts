import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildingDistance,
  classroomUrl,
  estimateTransfer,
} from "../src/routing/index";
import { walkingPath, type RouteGraph } from "../src/routing/graph";

const graph: RouteGraph = JSON.parse(
  readFileSync(
    new URL("../public/data/routes-graph.json", import.meta.url),
    "utf8",
  ),
);
const audit: { pairs: { from: string; to: string; localMeters: number }[] } =
  JSON.parse(
    readFileSync(
      new URL("../public/data/routes-verification.json", import.meta.url),
      "utf8",
    ),
  );
const a = { building: "CENTR", room: "115" },
  b = { building: "EBU3B", room: "1202" };

test("every published reference pair renders a connected path matching the solver's distance", () => {
  const lengths = new Map<string, number>();
  for (const [x, y, cost] of graph.edges) lengths.set(`${x}/${y}`, cost);
  for (const { from, to, localMeters } of audit.pairs) {
    const path = walkingPath(graph, from, to);
    assert.equal(path[0], graph.buildings[from].node);
    assert.equal(path.at(-1), graph.buildings[to].node);
    const total = path
      .slice(1)
      .reduce(
        (sum, v, i) =>
          sum + lengths.get(`${Math.min(v, path[i])}/${Math.max(v, path[i])}`)!,
        0,
      );
    assert.equal(Math.round(total / 10), localMeters);
    assert.equal(buildingDistance(from, to), localMeters);
    assert.equal(buildingDistance(to, from), localMeters);
  }
  assert.ok(audit.pairs.length >= 20);
});

test("the walk estimate responds to pace, buffer, floor changes and gap", () => {
  const usual = estimateTransfer(a, b, 10);
  const slower = estimateTransfer(a, b, 10, { speedMPerMin: 40 });
  assert.ok(slower.maxMinutes! > usual.maxMinutes!);
  assert.equal(
    estimateTransfer(a, b, 10, { bufferMinutes: 5 }).minMinutes!,
    usual.minMinutes! + 3,
  );
  assert.equal(estimateTransfer(a, b, usual.maxMinutes!).status, "comfortable");
  assert.equal(estimateTransfer(a, b, usual.minMinutes!).status, "tight");
  assert.equal(estimateTransfer(a, b, usual.minMinutes! - 1).status, "late");
  assert.equal(estimateTransfer(a, a, 0).minMinutes, 0);
  const first = { ...a, floor: 0 },
    top = { ...a, room: "400", floor: 4 };
  assert.ok(
    estimateTransfer(first, top, 10).maxMinutes! >
      estimateTransfer(first, { ...top, floor: 0 }, 10).maxMinutes!,
  );
});

test("missing paths, remote meeting places and unverified access remain explicit", () => {
  for (const missing of [
    { building: "TBA" },
    { building: "UNMAPPED" },
    { building: "RCLAS" },
    { remote: true },
  ])
    assert.equal(estimateTransfer(a, missing, 10).status, "unknown");
  const withoutSteps = estimateTransfer(a, b, 20, { stepFree: true });
  assert.equal(withoutSteps.status, "unknown");
  assert.equal(withoutSteps.reasonCode, "unverifiedStepFree");
  const path = walkingPath(graph, a.building, b.building, true);
  const permitted = new Set(
    graph.edges.filter((e) => !e[3]).map(([x, y]) => `${x}/${y}`),
  );
  assert.ok(path.length > 1);
  path
    .slice(1)
    .forEach((v, i) =>
      assert.ok(
        permitted.has(`${Math.min(v, path[i])}/${Math.max(v, path[i])}`),
      ),
    );
  assert.equal(classroomUrl({ remote: true }), null);
  const link = new URL(classroomUrl(a, "WI27")!);
  assert.equal(link.hostname, "wenhaoquestion.github.io");
  assert.equal(link.searchParams.get("building"), "CENTR");
  assert.equal(link.searchParams.get("room"), "115");
  assert.equal(link.searchParams.get("term"), "WI27");
});
