import { localAsset, type Grade, type Series, type Catalog } from "./model";

const cache = new Map<string, Promise<unknown>>();
export const apiBase = (import.meta.env?.VITE_API_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");
export class APIError extends Error {
  constructor(readonly status: number) {
    super("HTTP " + status);
  }
}

// Abort the body read as well as the initial request. A caller's abort signal
// still works when a timeout is in effect. Older Safari versions support
// AbortController even when AbortSignal.timeout/any are unavailable.
async function fetchJSON<T>(
  url: string,
  init: RequestInit,
  timeout: number,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new APIError(response.status);
    if (response.status === 204 || response.status === 205)
      return undefined as T;
    if (
      response.headers.get("Content-Type")?.toLowerCase().includes("text/html")
    ) {
      throw new Error("Expected JSON, received an HTML page");
    }
    // raw.githubusercontent.com serves JSON as text/plain.
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

export function readJson<T>(url: string): Promise<T> {
  return fetchJSON<T>(url, {}, 10000);
}

export function dataset<T>(path: string): Promise<T> {
  const url = localAsset("data/" + path);
  let request = cache.get(url);
  if (!request) {
    request = readJson(url).catch((error) => {
      cache.delete(url);
      throw error;
    });
    cache.set(url, request);
  }
  return request as Promise<T>;
}

export function loadCatalog(starter = false) {
  return dataset<Catalog>(starter ? "starter.json" : "catalog.json");
}
export function loadGrades(code: string) {
  return dataset<Record<string, Grade[]>>(
    "grades/" + encodeURIComponent(code.split(" ")[0]) + ".json",
  ).then((v) => v[code] || []);
}
export function loadHistory(code: string) {
  return dataset<Record<string, Series[]>>(
    "history/" + encodeURIComponent(code.split(" ")[0]) + ".json",
  ).then((v) => v[code] || []);
}

export function requestAPI<T>(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!base) return Promise.reject(new Error("No shared service configured"));
  return fetchJSON<T>(base + path, init, 8000);
}
export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return requestAPI<T>(apiBase, path, init);
}
export async function removeRemoteWatch(remote: { id: string; token: string }) {
  try {
    await api<void>("/api/watch/" + encodeURIComponent(remote.id), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + remote.token },
    });
  } catch (error) {
    // A browser endpoint or its 120-day watch may already have expired.
    if (!(error instanceof APIError && error.status === 404)) throw error;
  }
}

export interface Seat {
  available: number | null;
  capacity: number | null;
  waitlist: number | null;
  observedAt: string | null;
  sourceAt?: string | null;
  source?: "api" | "published" | "bundled";
}
export function seats(ids: string[]) {
  return api<{ seats: Record<string, Seat> }>(
    "/api/seats?term=WI27&ids=" + encodeURIComponent(ids.join(",")),
  );
}

async function workerReady() {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration?.active) return registration;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("No active service worker")),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function enablePush(
  sectionId: string,
  threshold: number,
  locale: string,
) {
  if (
    !apiBase ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  )
    throw Error("unsupported");
  // Request permission on the original click. Safari requires user activation.
  if (
    Notification.permission !== "granted" &&
    (await Notification.requestPermission()) !== "granted"
  )
    throw Error("permission");
  const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
  if (!publicKey) throw Error("unconfigured");
  const reg = await workerReady();
  const key = Uint8Array.from(
    atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  const subscription =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  return api<{ id: string; token: string }>("/api/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      term: "WI27",
      sectionId,
      threshold,
      subscription: subscription.toJSON(),
      locale,
    }),
  });
}
