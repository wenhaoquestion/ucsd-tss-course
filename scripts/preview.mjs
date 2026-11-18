import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
const root = path.resolve("dist");
const prefix = "/ucsd-tss-course/";
const types = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".html": "text/html",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
};
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(302, { Location: prefix });
        res.end();
        return;
      }
      const relative =
        decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile())
        throw Error();
      res.setHeader(
        "Content-Type",
        types[path.extname(file)] || "application/octet-stream",
      );
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(Number(process.env.PORT || 4175), "127.0.0.1");
