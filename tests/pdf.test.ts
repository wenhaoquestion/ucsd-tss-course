import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { matchScheduleRows, pdfRows } from "../src/pdf";
import type { Course } from "../src/model";

const { courses } = JSON.parse(
  readFileSync(new URL("../public/data/starter.json", import.meta.url), "utf8"),
) as { courses: Course[] };
const math = { code: "MATH 20C", id: "WI27:163118" };
const cse = { code: "CSE 12", id: "WI27:165078" };
const parse = (...rows: string[]) =>
  matchScheduleRows(["Winter Quarter 2027", ...rows], courses);

test("layout reconstructs PDF table rows using the baseline and horizontal position", () => {
  const make = (str: string, x: number, y: number) => ({
    str,
    transform: [1, 0, 0, 1, x, y],
  });
  const rows = pdfRows([
    make("(P-001-001)", 160, 69),
    make("Winter Quarter 2027", 10, 110),
    make("CSE-012", 10, 70),
    make("MATH-020C (P-001-001)", 10, 50),
  ]);
  assert.deepEqual(matchScheduleRows(rows, courses), [cse, math]);
});

test("TSS print row, case, padded course number and duplicated table header", () => {
  assert.deepEqual(
    parse("MATH - 020C  ( P - 001 - 001 )  BOOKED", "Math-020C (P-001-001)"),
    [math],
  );
  assert.deepEqual(parse("CSE–012 (P-001-001) MATH–020C (P-001-001)"), [
    cse,
    math,
  ]);
  assert.deepEqual(
    matchScheduleRows(
      ["2026/2027 Winter Quarter", "CSE-012 (P-001-001)"],
      courses,
    ),
    [cse],
  );
});

test("unique package or SAP event is always bound to its own course row", () => {
  assert.deepEqual(parse("CSE-012 Package ID: 165078"), [cse]);
  assert.deepEqual(parse("CSE 12 E 00009858"), [cse]);
  assert.deepEqual(parse("CSE 12 Event ID: 9858"), [cse]);
  assert.deepEqual(parse("MATH 20C 001-001-DI"), [math]);
  assert.deepEqual(parse("MATH 20C Package ID: 165078"), []);
  assert.deepEqual(parse("CSE 12 PID 165078", "MATH 20C"), []);
  assert.deepEqual(parse("Course: CSE 12", "Package ID: 165078"), []);
  assert.deepEqual(parse("CSE 12 XYZ-101 (P-001-001)"), []);
  assert.deepEqual(parse("CSE 12"), []);
});

test("common lectures, conflicting rows, wrong quarters and missing term require review outside the importer", () => {
  assert.deepEqual(parse("MATH 20C E 00009196"), []);
  assert.deepEqual(parse("MATH 20C E 00009196", "MATH 20C E 00009199"), [math]);
  assert.deepEqual(parse("MATH 20C (P-001-001)", "MATH 20C (P-001-002)"), []);
  assert.deepEqual(parse("CSE 12 (P-001-001) DROPPED"), []);
  assert.deepEqual(parse("MATH 20C (P-001-001) Package ID: 163119"), []);
  assert.deepEqual(
    matchScheduleRows(["Winter 2026", "CSE 12 Package ID: 165078"], courses),
    [],
  );
  assert.deepEqual(
    matchScheduleRows(
      ["Winter 2027", "Fall 2026", "CSE 12 (P-001-001)"],
      courses,
    ),
    [],
  );
  assert.deepEqual(matchScheduleRows(["CSE 12 (P-001-001)"], courses), []);
  assert.deepEqual(matchScheduleRows(["CSE 12 Package ID: 165078"], courses), [
    cse,
  ]);
});
