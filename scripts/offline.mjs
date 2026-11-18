import { readdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadEnv } from "vite";

const env = loadEnv("production", process.cwd(), "VITE_");
const published =
  process.env.VITE_OBSERVATIONS_URL ||
  env.VITE_OBSERVATIONS_URL ||
  "https://raw.githubusercontent.com/wenhaoquestion/ucsd-tss-course/public-data/WI27/";
const assets = (await readdir("dist/assets"))
  .filter((f) => /^(?:index-|RouteMap-|solver\.worker-).*\.(?:js|css)$/.test(f))
  .sort()
  .map((f) => "assets/" + f);
const files = [
  "./index.html",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.webmanifest",
  "./data/starter.json",
  "./data/catalog.json",
  "./data/seats.json",
  "./data/routes-graph.json",
  ...assets,
];
const template = await readFile("scripts/offline-template.js", "utf8");
const hash = createHash("sha256").update(template).update(published);
for (const file of files)
  hash.update(file).update(await readFile("dist/" + file));
const version = hash.digest("hex").slice(0, 12);
const code = template
  .replace("__VERSION__", version)
  .replace('"__PRECACHE__"', JSON.stringify(files))
  .replace('"__OBSERVATIONS__"', JSON.stringify(published));
await writeFile("dist/sw.js", code);
