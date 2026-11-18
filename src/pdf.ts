import type { Course, Option, Selection } from "./model";

type ImportOption = Option & { packageCode?: string; sectionIds?: string[] };
type TextRun = { str: string; transform: number[] };

export function pdfRows(items: TextRun[]): string[] {
  const lines: { y: number; runs: TextRun[] }[] = [];
  const ordered = items
    .filter((i) => i.str.trim())
    .sort((a, b) => b.transform[5] - a.transform[5]);
  for (const run of ordered) {
    const y = run.transform[5];
    const last = lines.at(-1);
    if (last && Math.abs(last.y - y) <= 2) last.runs.push(run);
    else lines.push({ y, runs: [run] });
  }
  return lines.map((line) =>
    line.runs
      .sort((a, b) => a.transform[4] - b.transform[4])
      .map((r) => r.str)
      .join(" "),
  );
}

function normalizedCourse(text: string) {
  return text
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/^([A-Z]+)0+(?=\d)/, "$1");
}

function documentTerm(rows: string[]) {
  const text = rows.join(" ").toUpperCase();
  const terms = new Set<string>();
  for (const m of text.matchAll(/\b(WI|FA|SP|SU)(\d{2})\b/g))
    terms.add(m[1] + m[2]);
  const seasons: Record<string, string> = {
    WINTER: "WI",
    SPRING: "SP",
    FALL: "FA",
    SUMMER: "SU",
  };
  for (const m of text.matchAll(
    /\b(WINTER|SPRING|FALL|SUMMER)(?:\s+(?:QUARTER|SESSION|TERM))?\s*[, -]?\s*20(\d{2})\b/g,
  )) {
    terms.add(seasons[m[1]] + m[2]);
  }
  for (const m of text.matchAll(
    /\b20(\d{2})(?:\s*[/–-]\s*(?:20)?(\d{2}))?\s+(WINTER|SPRING|FALL|SUMMER)(?:\s+QUARTER)?\b/g,
  )) {
    const year = m[3] === "FALL" ? m[1] : m[2] || m[1];
    terms.add(seasons[m[3]] + year);
  }
  return terms;
}

function printedCode(option: ImportOption, printed: string) {
  if (option.packageCode) return option.packageCode === printed;
  // A single explicit non-000 component family identifies a printed P-group.
  // Shared lecture-only groups and mixed discussion/lab numbers are ambiguous.
  const components = new Set(
    Array.from(option.label.matchAll(/\b(\d{3})-(\d{3})-[A-Z]+\b/g))
      .filter((m) => m[2] !== "000")
      .map((m) => "P-" + m[1] + "-" + m[2]),
  );
  return components.size === 1 && components.has(printed);
}

function eventId(value: string) {
  const match = /^E\s*0*(\d+)$/i.exec(value.trim());
  return match?.[1];
}

function identifiers(text: string) {
  const values = text.toUpperCase().replace(/\s*-\s*/g, "-");
  const printed = Array.from(
    values.matchAll(/\(\s*([A-Z]-\d{3}-\d{3})\s*\)/g),
    (m) => m[1],
  );
  const packages = Array.from(
    values.matchAll(
      /\b(?:EVENT\s*PACKAGE|PACKAGE|PKG)\s*(?:ID|NUMBER|NO\.?|#)?\s*[:#]?\s*(\d{5,9})\b/g,
    ),
    (m) => m[1],
  );
  const events = Array.from(
    values.matchAll(
      /\bE\s+0*(\d{3,9})\b|\bEVENT\s+ID\s*[:#]?\s*0*(\d{3,9})\b/g,
    ),
    (m) => String(Number(m[1] ?? m[2])),
  );
  const components = Array.from(
    values.matchAll(/\b\d{3}-\d{3}-[A-Z]{2,3}\b/g),
    (m) => m[0],
  );
  return { printed, packages, events, components };
}

export function matchScheduleRows(
  rows: string[],
  courses: Course[],
): Selection[] {
  const terms = documentTerm(rows);
  if (terms.size && (terms.size !== 1 || !terms.has("WI27"))) return [];
  const byCode = new Map(courses.map((c) => [normalizedCourse(c.code), c]));
  const matches = new Map<string, Set<string>>();
  const blocked = new Set<string>();
  for (const raw of rows) {
    const row = raw
      .normalize("NFKC")
      .toUpperCase()
      .replace(/[‐‑‒–—]/g, "-");
    const names = Array.from(
      row.matchAll(/\b([A-Z]{2,8})\s*[- ]\s*(\d{1,4}[A-Z]{0,3})\b/g),
    )
      .filter(
        (m) =>
          !["ID", "NO", "NUMBER", "SECTION", "EVENT", "PACKAGE"].includes(m[1]),
      )
      .map((m) => ({
        at: m.index!,
        end: m.index! + m[0].length,
        course: byCode.get(normalizedCourse(m[0])),
      }));
    for (let i = 0; i < names.length; i++) {
      const { course, end } = names[i];
      if (!course) continue;
      const fragment = row.slice(end, names[i + 1]?.at);
      if (
        /\b(?:DROPPED|WITHDRAWN|CANCELLED|CANCELED|UNBOOKED|NOT ENROLLED)\b/.test(
          fragment,
        )
      )
        continue;
      const ids = identifiers(fragment);
      const count =
        ids.printed.length +
        ids.packages.length +
        ids.events.length +
        ids.components.length;
      if (!count || (!terms.size && !ids.packages.length && !ids.events.length))
        continue;
      const possible = course.options.filter((o: ImportOption) => {
        const events = [
          o.sectionId,
          ...(o.sectionIds || []),
          ...o.meetings.map((m) => m.sectionId || ""),
        ].map(eventId);
        const sectionCodes = o.label.split(/\s*\+\s*/);
        return (
          ids.printed.every((p) => printedCode(o, p)) &&
          ids.packages.every((id) => o.id === "WI27:" + id) &&
          ids.events.every((id) => events.includes(id)) &&
          ids.components.every((id) => sectionCodes.includes(id))
        );
      });
      const candidates = new Set(possible.map((o) => o.id));
      if (!candidates.size) {
        blocked.add(course.code);
        continue;
      }
      const previous = matches.get(course.code);
      matches.set(
        course.code,
        previous
          ? new Set([...previous].filter((id) => candidates.has(id)))
          : candidates,
      );
    }
  }
  return Array.from(matches).flatMap(([code, ids]) =>
    !blocked.has(code) && ids.size === 1 ? [{ code, id: [...ids][0] }] : [],
  );
}

export async function importPdf(
  file: File,
  courses: Course[],
): Promise<Selection[]> {
  if (file.size > 20 * 1024 * 1024) throw Error("PDF too large");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = (
    await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ).default;
  const doc = await pdfjs.getDocument({
    data: await file.arrayBuffer(),
    useSystemFonts: false,
  }).promise;
  try {
    if (doc.numPages > 80) throw Error("PDF exceeds 80 pages");
    const rows: string[] = [];
    for (let index = 1; index <= doc.numPages; index++) {
      const page = await doc.getPage(index);
      const text = await page.getTextContent();
      rows.push(
        ...pdfRows(
          text.items.filter(
            (item): item is Extract<typeof item, TextRun> => "str" in item,
          ),
        ),
      );
      page.cleanup();
    }
    return matchScheduleRows(rows, courses);
  } finally {
    await doc.destroy();
  }
}
