import { apiBase, readJson, type Seat } from "./data";
import { localAsset, type Point } from "./model";

type Counts = Pick<Seat, "available" | "capacity" | "waitlist">;
type Snapshot = { observedAt: string; seats: Record<string, Counts> };
type Shard = { seats: string; history: string };
type Manifest = {
  term: string;
  observedAt: string;
  shards: Record<string, Shard>;
};
type Sources = {
  published: string;
  service: string;
  bundled: string;
  read?: typeof readJson;
};
const defaultPublished =
  "https://raw.githubusercontent.com/wenhaoquestion/ucsd-tss-course/public-data/WI27/";
const keyFor = (id: string) => id.match(/(\d{2})$/)?.[1] || "other";
const isTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const sourceRank = { api: 3, published: 2, bundled: 1 } as const;

function validCounts(v: Counts | undefined): v is Counts {
  return (
    !!v &&
    [v.available, v.capacity, v.waitlist].every(
      (n) => n === null || (typeof n === "number" && Number.isFinite(n)),
    )
  );
}
function newer(a: Seat, b: Seat | undefined) {
  if (!isTime(a.observedAt)) return false;
  if (!b || !isTime(b.observedAt)) return true;
  const delta = Date.parse(a.observedAt) - Date.parse(b.observedAt);
  return (
    delta > 0 || (delta === 0 && sourceRank[a.source!] >= sourceRank[b.source!])
  );
}

export function createObservationReader(sources: Sources) {
  const read = sources.read || readJson;
  const published = sources.published.replace(/\/?$/, "/");
  let lastManifest: Manifest | undefined;
  let nextManifestRead = 0;
  let loadingManifest: Promise<Manifest | undefined> | undefined;
  let bundled: Promise<Snapshot> | undefined;
  const chunks = new Map<string, Promise<unknown>>();
  const serviceRequests = new Map<string, Promise<unknown>>();
  const known = new Map<string, Seat>();

  function seed() {
    return (bundled ||= read<Snapshot>(sources.bundled)
      .then((snapshot) => {
        if (!isTime(snapshot?.observedAt) || !snapshot.seats)
          throw Error("Invalid bundled seats");
        return snapshot;
      })
      .catch((error) => {
        bundled = undefined;
        throw error;
      }));
  }
  function manifest(): Promise<Manifest | undefined> {
    if (loadingManifest) return loadingManifest;
    if (Date.now() < nextManifestRead) return Promise.resolve(lastManifest);
    loadingManifest = read<Manifest>(published + "manifest.json")
      .then((m) => {
        if (
          m?.term !== "WI27" ||
          !isTime(m.observedAt) ||
          !m.shards ||
          typeof m.shards !== "object"
        )
          throw Error("Invalid manifest");
        if (
          !lastManifest ||
          Date.parse(m.observedAt) >= Date.parse(lastManifest.observedAt)
        )
          lastManifest = m;
        nextManifestRead = Date.now() + 110000;
        return lastManifest;
      })
      .catch(() => {
        nextManifestRead = Date.now() + 15000;
        return lastManifest;
      })
      .finally(() => {
        loadingManifest = undefined;
      });
    return loadingManifest;
  }
  function shard<T>(kind: keyof Shard, key: string, m: Manifest): Promise<T> {
    const name = m.shards[key]?.[kind];
    if (
      !name ||
      !new RegExp("^" + kind + "/" + key + "\\.[a-f0-9]{24}\\.json$").test(name)
    ) {
      return Promise.reject(Error("Missing or invalid " + kind + " shard"));
    }
    let item = chunks.get(name);
    if (!item) {
      if (chunks.size >= 250) chunks.delete(chunks.keys().next().value!);
      item = read<T>(published + name).catch((error) => {
        chunks.delete(name);
        throw error;
      });
      chunks.set(name, item);
    }
    return item as Promise<T>;
  }
  function fromAPI<T>(path: string): Promise<T> {
    let request = serviceRequests.get(path);
    if (!request) {
      request = read<T>(sources.service + path).finally(() => {
        serviceRequests.delete(path);
      });
      serviceRequests.set(path, request);
    }
    return request as Promise<T>;
  }
  function remember(
    id: string,
    counts: Counts | undefined,
    at: string | null,
    source: NonNullable<Seat["source"]>,
    sourceAt: string | null = null,
  ) {
    if (!validCounts(counts) || !isTime(at)) return;
    const obs: Seat = {
      available: counts.available,
      capacity: counts.capacity,
      waitlist: counts.waitlist,
      observedAt: at,
      sourceAt,
      source,
    };
    if (newer(obs, known.get(id))) known.set(id, obs);
  }

  async function latestSeats(
    rawIDs: string[],
  ): Promise<{ seats: Record<string, Seat> }> {
    const ids = [...new Set(rawIDs.filter(Boolean))].sort();
    if (!ids.length) return { seats: {} };
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const key = keyFor(id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(id);
    }
    const jobs: Promise<unknown>[] = [
      seed().then((s) => {
        for (const id of ids)
          remember(id, s.seats[id], s.observedAt, "bundled");
      }),
      manifest().then(async (m) => {
        if (!m) return;
        await Promise.allSettled(
          [...groups].map(async ([key, group]) => {
            const file = await shard<{ seats: Record<string, Counts> }>(
              "seats",
              key,
              m,
            );
            for (const id of group)
              remember(id, file.seats[id], m.observedAt, "published");
          }),
        );
      }),
    ];
    if (sources.service) {
      for (let start = 0; start < ids.length; start += 200) {
        const batch = ids.slice(start, start + 200);
        jobs.push(
          fromAPI<{ seats: Record<string, Seat> }>(
            "/api/seats?term=WI27&ids=" + encodeURIComponent(batch.join(",")),
          ).then((r) => {
            for (const id of batch) {
              const seat = r.seats[id];
              if (seat)
                remember(
                  id,
                  seat,
                  seat.observedAt,
                  "api",
                  isTime(seat.sourceAt) ? seat.sourceAt : null,
                );
            }
          }),
        );
      }
    }
    // Each source and shard can fail independently. A missing section keeps its
    // last dated observation. A newer explicit null supersedes an old number.
    await Promise.allSettled(jobs);
    return {
      seats: Object.fromEntries(
        ids.filter((id) => known.has(id)).map((id) => [id, known.get(id)!]),
      ),
    };
  }
  async function recentHistory(id: string): Promise<Point[]> {
    if (!id) return [];
    const readings: Promise<Point[]>[] = [
      seed().then((snapshot) => {
        const counts = snapshot.seats[id];
        return validCounts(counts)
          ? [{ at: snapshot.observedAt, ...counts }]
          : [];
      }),
      manifest().then(async (m) => {
        if (!m) return [];
        const file = await shard<{ sections: Record<string, Point[]> }>(
          "history",
          keyFor(id),
          m,
        );
        return file.sections[id] || [];
      }),
    ];
    if (sources.service)
      readings.push(
        fromAPI<{ points: Point[] }>(
          "/api/history?term=WI27&section=" + encodeURIComponent(id),
        ).then((r) => r.points),
      );
    const points = new Map<number, Point>();
    for (const result of await Promise.allSettled(readings)) {
      if (result.status !== "fulfilled" || !Array.isArray(result.value))
        continue;
      for (const p of result.value)
        if (validCounts(p) && isTime(p.at)) points.set(Date.parse(p.at), p);
    }
    return [...points.values()]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .filter((p, i, rows) => {
        const prior = rows[i - 1];
        return (
          !prior ||
          p.available !== prior.available ||
          p.capacity !== prior.capacity ||
          p.waitlist !== prior.waitlist
        );
      });
  }
  return { latestSeats, recentHistory };
}

let reader: ReturnType<typeof createObservationReader> | undefined;
function sharedReader() {
  return (reader ||= createObservationReader({
    published: import.meta.env.VITE_OBSERVATIONS_URL || defaultPublished,
    service: apiBase,
    bundled: localAsset("data/seats.json"),
  }));
}
export const latestSeats = (ids: string[]) => sharedReader().latestSeats(ids);
export const recentHistory = (id: string) => sharedReader().recentHistory(id);
