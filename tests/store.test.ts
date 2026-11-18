import assert from "node:assert/strict";
import test from "node:test";
import { initial, restoreSaved, type Saved } from "../src/store";

const sample: Saved["plans"][0] = [
  { code: "CSE 12", id: "WI27:165078" },
  { code: "MATH 20C", id: "WI27:163118" },
  { code: "PSYC 1", id: "WI27:163966" },
];

test("a new workspace has two empty personal plans", () => {
  const state = initial();
  assert.deepEqual(state.plans, [[], []]);
  assert.equal(state.active, 0);
  assert.equal("example" in state, false);
});

test("restoring removes only the marked automatic example from Plan A", () => {
  const personal = [{ code: "CHEM 6A", id: "WI27:169999" }];
  const state: Saved = {
    ...initial(),
    active: 1,
    lang: "zh",
    plans: [sample, personal],
    first: "2026-11-18T20:30",
    watches: [{ sectionId: "E 00000100", code: "CSE 12", threshold: 1 }],
  };
  const legacy = { ...state, example: true };
  assert.deepEqual(restoreSaved(legacy), { ...state, plans: [[], personal] });
  assert.deepEqual(legacy.plans, [sample, personal]);
});

test("restoring retains personal selections including an identical manually saved plan", () => {
  const state: Saved = { ...initial(), plans: [sample, []] };
  assert.deepEqual(restoreSaved({ ...state, example: false }), state);
  assert.deepEqual(restoreSaved(state), state);
  const edited: Saved = { ...state, plans: [sample.slice(1), []] };
  assert.deepEqual(restoreSaved({ ...edited, example: true }), edited);
});
