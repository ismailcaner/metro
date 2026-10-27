#!/usr/bin/env node
/**
 * İstanbul Ulaşım — yerel üretim sunucusu
 *
 * Vite çıktısını (dist/) sunar ve /api/bus isteklerini İETT servislerine
 * yönlendirir. Geliştirme sırasında Vite ayrı çalışır; npm run dev ikisini
 * birlikte başlatır.
 *
 * Çalıştırma:  npm run build && npm start  →  http://127.0.0.1:4173
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleBusRequest, warmLocalOsmPlaces } from "./lib/iett.mjs";
import { handleMetroRequest } from "./lib/metro.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(ROOT, "dist");
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "127.0.0.1";

// Load the local OSM search index in the background so the first user query is fast.
void warmLocalOsmPlaces().catch((error) => console.warn("Yerel OSM indeksi yüklenemedi:", error.message));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    return send(res, 400, { "content-type": "text/plain; charset=utf-8" }, "Geçersiz istek");
  }

  if (url.pathname === "/api/bus") {
    try {
      const out = await handleBusRequest(url);
      send(res, out.status, { ...out.headers, "cache-control": "no-store" }, JSON.stringify(out.body));
    } catch (e) {
      console.error("API hatası:", e);
      send(
        res,
        500,
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        JSON.stringify({ error: "Sunucu hatası" })
      );
    }
    return;
  }

  if (url.pathname.startsWith("/api/metro/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD" }, JSON.stringify({ error: "Yöntem desteklenmiyor" }));
    }
    try {
      const out = await handleMetroRequest(url);
      send(res, out.status, { ...out.headers, "cache-control": "no-store" }, req.method === "HEAD" ? undefined : out.text);
    } catch (e) {
      console.error("Metro API hatası:", e);
      send(
        res,
        500,
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        JSON.stringify({ error: "Sunucu hatası" })
      );
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }, "Yöntem desteklenmiyor");
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { "content-type": "text/plain; charset=utf-8" }, "Geçersiz yol");
  }
  if (pathname === "/") pathname = "/index.html";

  const filePath = resolve(DIST, `.${pathname}`);
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    return send(res, 403, { "content-type": "text/plain; charset=utf-8" }, "Erişim yok");
  }

  try {
    let target = filePath;
    const info = await stat(target);
    if (info.isDirectory()) target = resolve(target, "index.html");
    const data = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
    const cacheControl = pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    send(
      res,
      200,
      { "content-type": type, "cache-control": cacheControl, "content-length": data.length },
      req.method === "HEAD" ? undefined : data
    );
  } catch {
    send(
      res,
      404,
      { "content-type": "text/plain; charset=utf-8" },
      "Bulunamadı. Üretim sunucusu için önce `npm run build` çalıştırın."
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`İstanbul Ulaşım → http://${HOST}:${PORT}`);
  console.log(`Statik kök: ${DIST}`);
  console.log("Otobüs canlı verisi: /api/bus?type=stop&code=117355");
});
