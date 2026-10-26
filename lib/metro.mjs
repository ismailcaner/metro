/**
 * İBB Metro API köprüsü.
 *
 * Tarayıcı doğrudan api.ibb.gov.tr'ye gitmek yerine kendi origin'imizdeki
 * /api/metro/* adresini kullanır. Böylece dış servisin CORS davranışı
 * değişse bile uygulama çalışmaya devam eder.
 *
 * Aynı modül hem yerel sunucuda (server.mjs) hem de Vercel fonksiyonunda
 * (api/metro/[...path].mjs) kullanılır.
 */

const METRO_API_BASE = "https://api.ibb.gov.tr/MetroIstanbul/api/MetroMobile/V2";
const REQUEST_TIMEOUT = 10_000;
const STALE_TTL = 10 * 60_000;
const CACHE_TTL = {
  GetLines: 5 * 60_000,
  GetStations: 5 * 60_000,
  GetServiceStatuses: 60_000,
};
const cache = new Map();

/** Dış servise açılan uç noktalar; path traversal / SSRF'i engeller. */
const ALLOWED_ENDPOINTS = new Set(["GetLines", "GetStations", "GetServiceStatuses"]);

function jsonResponse(status, body) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    text: JSON.stringify(body),
  };
}

function cachedResponse(entry, stale = false) {
  return {
    status: entry.status,
    headers: { ...entry.headers, "x-metro-cache": stale ? "stale" : "hit" },
    text: entry.text,
  };
}

/**
 * @param {URL} url
 * @returns {Promise<{status:number, headers:Record<string,string>, text:string}>}
 */
export async function handleMetroRequest(url) {
  const raw = url.pathname.replace(/^\/api\/metro\/?/, "").replace(/\/+$/, "");

  let endpoint;
  try {
    endpoint = decodeURIComponent(raw);
  } catch {
    return jsonResponse(400, { error: "Geçersiz uç nokta" });
  }

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return jsonResponse(404, { error: "Bilinmeyen metro uç noktası" });
  }

  const hit = cache.get(endpoint);
  if (hit && Date.now() - hit.at < CACHE_TTL[endpoint]) {
    return cachedResponse(hit);
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);

  try {
    const upstream = await fetch(`${METRO_API_BASE}/${endpoint}`, {
      headers: { accept: "application/json" },
      signal: ctl.signal,
    });
    const text = await upstream.text();
    const result = {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      },
      text,
    };
    if (upstream.ok) {
      cache.set(endpoint, { at: Date.now(), ...result });
    } else if (hit && Date.now() - hit.at < STALE_TTL) {
      return cachedResponse(hit, true);
    }
    return result;
  } catch (error) {
    if (hit && Date.now() - hit.at < STALE_TTL) {
      return cachedResponse(hit, true);
    }
    const timedOut = error?.name === "AbortError";
    return jsonResponse(timedOut ? 504 : 502, {
      error: timedOut ? "Metro servisi zaman aşımına uğradı" : "Metro servisine ulaşılamadı",
    });
  } finally {
    clearTimeout(timer);
  }
}
