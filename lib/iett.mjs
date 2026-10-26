import { readFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);
const LOCAL_OSM_INDEX_URL = new URL("../data/osm/turkey-places.json.gz", import.meta.url);
let localOsmPlacesPromise;

/**
 * İETT köprüsü — tarayıcıdan doğrudan çağrılamayan İETT servislerini
 * (CORS başlığı yok) sunucu tarafında çağırır, HTML/XML'i JSON'a çevirir.
 *
 * Aynı modül hem yerel geliştirme sunucusunda (server.mjs) hem de Vercel
 * fonksiyonunda (api/bus.mjs) kullanılır.
 */

const STOP_BOARD_URL = "https://iett.istanbul/tr/RouteStation/GetStationInfo";
const ANNOUNCEMENT_URL = "https://iett.istanbul/tr/Announcement";
const SOAP_URL = "https://api.ibb.gov.tr/iett/ibb/ibb.asmx";
const SOAP_ACTION = "DurakDetay_GYY";
const VEHICLE_URL = "https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx";
const VEHICLE_ACTION = "GetHatOtoKonum_json";
const SCHEDULE_URL = "https://api.ibb.gov.tr/iett/UlasimAnaVeri/PlanlananSeferSaati.asmx";
const SCHEDULE_ACTION = "GetPlanlananSeferSaati_json";
const JOURNEY_SEARCH_URL = "https://nasilgiderim.iett.gov.tr/search";
const JOURNEY_ROUTER_URL = "https://nasilgiderim.iett.gov.tr/router";
const REQUEST_TIMEOUT = 9000;
const STOP_TTL = 20_000;
const ANNOUNCEMENT_TTL = 5 * 60_000;
const ANNOUNCEMENT_DETAIL_TTL = 60 * 60_000;
const LINE_TTL = 60 * 60_000;
const VEHICLE_TTL = 30_000;
const SCHEDULE_TTL = 30 * 60_000;
const JOURNEY_SEARCH_TTL = 5 * 60_000;
const JOURNEY_ROUTE_TTL = 60_000;
const JOURNEY_MAX_ROUTES = 16;
const STALE_TTL = 10 * 60_000;
const ANNOUNCEMENT_PAGES = 4;

const cache = new Map();

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n) => ({
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    }[n.toLowerCase()]));
}

const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, " ");
const textOf = (s) => clean(stripTags(decodeEntities(s)));

async function request(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withCache(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return { ...hit.value, cached: true };
  try {
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (hit && Date.now() - hit.at < STALE_TTL) return { ...hit.value, stale: true };
    throw e;
  }
}

/* ---------------- durak canlı varış panosu ---------------- */
function parseStopBoard(html) {
  const announcements = [];
  const announcementBlock = html.match(/<div class=['"]duyuru-scroll['"]>([\s\S]*?)<\/div>/i)?.[1] || "";
  for (const m of announcementBlock.matchAll(/<p>\s*<b>([\s\S]*?)<\/b>\s*:\s*([\s\S]*?)<\/p>/gi)) {
    const line = textOf(m[1]);
    const text = textOf(m[2]);
    if (line && text) announcements.push({ line, text });
  }

  const arrivals = [];
  for (const chunk of html.split('<div class="line-item">').slice(1)) {
    const span = chunk.match(/<span>([\s\S]*?)<\/span>/i);
    const p = chunk.match(/<p>([\s\S]*?)<\/p>/i);
    if (!span || !p) continue;
    const b = p[1].match(/<b>([\s\S]*?)<\/b>/i);
    if (!b) continue;

    const line = textOf(span[1]);
    if (!line) continue;

    const destination = textOf(p[1].split(/<b>/i)[0]);
    const etaText = textOf(b[1]);
    const clock = etaText.match(/\((\d{1,2}:\d{2})\)/)?.[1] || null;
    const minuteMatch = etaText.match(/(\d+)\s*dk/i);
    const minutes = minuteMatch ? Number(minuteMatch[1]) : null;
    const notStarted = /\bB\b/.test(etaText.replace(/\([^)]*\)/g, ""));

    arrivals.push({
      line,
      destination,
      clock,
      minutes,
      status: minutes != null ? "live" : notStarted ? "B" : "unknown",
      note: minutes == null ? etaText : null,
    });
  }

  arrivals.sort((a, b) => {
    const am = a.minutes == null ? Number.POSITIVE_INFINITY : a.minutes;
    const bm = b.minutes == null ? Number.POSITIVE_INFINITY : b.minutes;
    return am - bm || a.line.localeCompare(b.line, "tr", { numeric: true });
  });

  return { announcements, arrivals };
}

async function fetchStopBoard(code) {
  if (!/^\d{4,7}$/.test(code)) throw Object.assign(new Error("Geçersiz durak kodu"), { status: 400 });

  return withCache(`stop:${code}`, STOP_TTL, async () => {
    const url = `${STOP_BOARD_URL}?dcode=${encodeURIComponent(code)}&langid=1`;
    const res = await request(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "tr-TR,tr;q=0.9,en;q=0.5",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`İETT durak panosu → HTTP ${res.status}`);
    const html = await res.text();
    const parsed = parseStopBoard(html);
    return {
      code,
      ...parsed,
      notes:
        "Varış süreleri İETT'nin tahmini verisidir; trafik durumuna göre değişebilir. " +
        "B işaretli saatler henüz sefere başlamamış veya sinyal sorunu olan araçları gösterir.",
      fetchedAt: new Date().toISOString(),
    };
  });
}

/* ---------------- İETT duyuruları ---------------- */
function parseAnnouncementList(html) {
  const items = [];
  for (const m of html.matchAll(/<a class="mini-news-row" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const block = m[2];
    const date = textOf(block.match(/<div class="date">([\s\S]*?)<\/div>/i)?.[1]);
    const title = textOf(block.match(/<div class="info">([\s\S]*?)<\/div>/i)?.[1]);
    if (!title) continue;
    let url;
    try {
      url = new URL(decodeEntities(href), "https://iett.istanbul").href;
    } catch {
      continue;
    }
    const id = href.match(/\/Detail\/(\d+)/i)?.[1] || url;
    items.push({ id, title, date, url });
  }
  return items;
}

async function fetchAnnouncementPage(page) {
  const res = await request(ANNOUNCEMENT_URL, {
    method: "POST",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "accept-language": "tr-TR,tr;q=0.9,en;q=0.5",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    },
    body: new URLSearchParams({ Page: String(page), lngid: "1" }).toString(),
  });
  if (!res.ok) throw new Error(`İETT duyuruları → HTTP ${res.status}`);
  return parseAnnouncementList(await res.text());
}

async function fetchAnnouncements() {
  return withCache("announcements", ANNOUNCEMENT_TTL, async () => {
    const pages = await Promise.allSettled(
      Array.from({ length: ANNOUNCEMENT_PAGES }, (_, page) => fetchAnnouncementPage(page))
    );
    const seen = new Set();
    const announcements = [];
    for (const result of pages) {
      if (result.status !== "fulfilled") continue;
      for (const item of result.value) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        announcements.push(item);
      }
    }
    if (!announcements.length) throw new Error("İETT duyuru listesi boş");
    return { announcements, fetchedAt: new Date().toISOString() };
  });
}

function htmlToText(html) {
  const text = decodeEntities(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n\n")
      .replace(/<[^>]*>/g, "")
  );
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseAnnouncementDetail(html) {
  const title =
    textOf(html.match(/<h1 class="breadcrumb-title">([\s\S]*?)<\/h1>/i)?.[1]) ||
    textOf(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
  const date = textOf(html.match(/<div class="news-detail-date">[\s\S]*?<time>([\s\S]*?)<\/time>/i)?.[1]);
  const entry =
    html.match(/<div class="news-detail-entry">([\s\S]*?)<\/div>\s*<div class="share-content">/i)?.[1] ||
    html.match(/<div class="news-detail-entry">([\s\S]*?)<\/div>/i)?.[1];
  return { title, date, content: htmlToText(entry) };
}

async function fetchAnnouncementDetail(id) {
  if (!/^\d+$/.test(id)) throw Object.assign(new Error("Geçersiz duyuru kimliği"), { status: 400 });

  return withCache(`announcement:${id}`, ANNOUNCEMENT_DETAIL_TTL, async () => {
    const url = `https://iett.istanbul/Announcement/Detail/${encodeURIComponent(id)}`;
    const res = await request(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "tr-TR,tr;q=0.9,en;q=0.5",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`İETT duyuru detayı → HTTP ${res.status}`);
    const parsed = parseAnnouncementDetail(await res.text());
    if (!parsed.content) throw new Error("Duyuru metni bulunamadı");
    return { id, ...parsed, url, fetchedAt: new Date().toISOString() };
  });
}

/* ---------------- hat durakları ---------------- */
function xmlTag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return m ? textOf(m[1]) : "";
}

function parseLineStops(xml, code) {
  const byDirection = new Map();
  for (const m of xml.matchAll(/<Table>([\s\S]*?)<\/Table>/gi)) {
    const block = m[1];
    const stopCode = xmlTag(block, "DURAKKODU");
    if (!stopCode) continue;
    const direction = xmlTag(block, "YON") || "?";
    const order = Number(xmlTag(block, "SIRANO")) || 0;
    const stop = {
      code: Number(stopCode),
      name: xmlTag(block, "DURAKADI"),
      lat: Number(xmlTag(block, "YKOORDINATI")) || null,
      lng: Number(xmlTag(block, "XKOORDINATI")) || null,
      order,
    };
    if (!byDirection.has(direction)) byDirection.set(direction, []);
    byDirection.get(direction).push(stop);
  }

  const directions = [...byDirection.entries()]
    .map(([direction, stops]) => {
      const seen = new Set();
      const unique = stops
        .sort((a, b) => a.order - b.order)
        .filter((s) => {
          const key = `${s.code}:${s.order}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      const from = unique[0]?.name || direction;
      const to = unique[unique.length - 1]?.name || direction;
      return { code: direction, from, to, stops: unique };
    })
    .filter((d) => d.stops.length)
    .sort((a, b) => a.from.localeCompare(b.from, "tr") || a.code.localeCompare(b.code));

  const stopCount = new Set(directions.flatMap((d) => d.stops.map((s) => s.code))).size;
  return { code, stopCount, directions, fetchedAt: new Date().toISOString() };
}

async function fetchLineStops(code) {
  if (!/^[0-9A-Za-zÇĞİÖŞÜçğıöşü]{1,12}$/.test(code)) {
    throw Object.assign(new Error("Geçersiz hat kodu"), { status: 400 });
  }

  return withCache(`line:${code}`, LINE_TTL, async () => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <DurakDetay_GYY xmlns="http://tempuri.org/">
      <hat_kodu>${code.replace(/[<>&"']/g, "")}</hat_kodu>
    </DurakDetay_GYY>
  </soap:Body>
</soap:Envelope>`;

    const res = await request(SOAP_URL, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        SOAPAction: `"http://tempuri.org/${SOAP_ACTION}"`,
        "user-agent": "siradaki-metro/1.0",
      },
      body,
    });
    const xml = await res.text();
    if (!res.ok || !xml.includes("<DurakDetay_GYYResult>")) {
      throw new Error(`İETT hat servisi → HTTP ${res.status}`);
    }
    return parseLineStops(xml, code);
  });
}

/* ---------------- hat araç konumları ---------------- */
function parseLineVehicles(xml, code) {
  const result = xml.match(/<GetHatOtoKonum_jsonResult>([\s\S]*?)<\/GetHatOtoKonum_jsonResult>/i)?.[1];
  if (result == null) throw new Error("İETT araç konumu yanıtı okunamadı");
  let raw;
  try {
    raw = JSON.parse(decodeEntities(result));
  } catch {
    throw new Error("İETT araç konumu JSON biçimi geçersiz");
  }
  if (!Array.isArray(raw)) raw = [];

  const vehicles = raw
    .map((v) => {
      const lat = Number(v.enlem ?? v.Enlem);
      const lng = Number(v.boylam ?? v.Boylam);
      return {
        door: String(v.kapino ?? v.KapiNo ?? "").trim(),
        plate: String(v.plaka ?? v.Plaka ?? "").trim(),
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        speed: Number(v.hiz ?? v.Hiz) || 0,
        line: String(v.hatkodu ?? v.HatKodu ?? code).trim(),
        route: String(v.guzergahkodu ?? v.GuzergahKodu ?? "").trim(),
        lineName: String(v.hatad ?? v.HatAd ?? "").trim(),
        direction: String(v.yon ?? v.Yon ?? "").trim(),
        updatedAt: String(v.son_konum_zamani ?? v.SonKonumZamani ?? "").trim(),
        nearestStop: String(v.yakinDurakKodu ?? v.YakinDurakKodu ?? "").trim(),
      };
    })
    .filter((v) => v.line || v.nearestStop || v.lat != null);

  return { code, vehicles, fetchedAt: new Date().toISOString() };
}

async function fetchLineVehicles(code) {
  if (!/^[0-9A-Za-zÇĞİÖŞÜçğıöşü]{1,12}$/.test(code)) {
    throw Object.assign(new Error("Geçersiz hat kodu"), { status: 400 });
  }

  return withCache(`vehicles:${code}`, VEHICLE_TTL, async () => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetHatOtoKonum_json xmlns="http://tempuri.org/">
      <HatKodu>${code.replace(/[<>&"']/g, "")}</HatKodu>
    </GetHatOtoKonum_json>
  </soap:Body>
</soap:Envelope>`;

    const res = await request(VEHICLE_URL, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        SOAPAction: `"http://tempuri.org/${VEHICLE_ACTION}"`,
        "user-agent": "siradaki-metro/1.0",
      },
      body,
    });
    const xml = await res.text();
    if (!res.ok || !xml.includes("<GetHatOtoKonum_jsonResult>")) {
      throw new Error(`İETT araç konumu servisi → HTTP ${res.status}`);
    }
    return parseLineVehicles(xml, code);
  });
}

/* ---------------- planlanan hat sefer saatleri ---------------- */
function parseLineSchedule(xml, code) {
  const result = xml.match(/<GetPlanlananSeferSaati_jsonResult>([\s\S]*?)<\/GetPlanlananSeferSaati_jsonResult>/i)?.[1];
  if (result == null) throw new Error("İETT sefer saati yanıtı okunamadı");
  let raw;
  try {
    raw = JSON.parse(decodeEntities(result));
  } catch {
    throw new Error("İETT sefer saati JSON biçimi geçersiz");
  }
  if (!Array.isArray(raw)) raw = [];

  const days = { I: {}, C: {}, P: {} };
  const times = { I: { G: new Set(), D: new Set() }, C: { G: new Set(), D: new Set() }, P: { G: new Set(), D: new Set() } };
  let name = "";

  for (const item of raw) {
    if (!name) name = clean(item.HATADI || "");
    const day = String(item.SGUNTIPI || "").toUpperCase();
    const dir = String(item.SYON || "").toUpperCase();
    const time = clean(item.DT);
    if (!times[day]?.[dir] || !/^\d{1,2}:\d{2}$/.test(time)) continue;
    times[day][dir].add(time.padStart(5, "0"));
  }

  for (const day of ["I", "C", "P"]) {
    for (const dir of ["G", "D"]) {
      const list = [...times[day][dir]].sort();
      if (!list.length) continue;
      if (!days[day][dir]) days[day][dir] = { times: list, count: list.length, first: list[0], last: list[list.length - 1] };
    }
  }

  return { code, name: name || code, days, fetchedAt: new Date().toISOString() };
}

async function fetchLineSchedule(code) {
  if (!/^[0-9A-Za-zÇĞİÖŞÜçğıöşü]{1,12}$/.test(code)) {
    throw Object.assign(new Error("Geçersiz hat kodu"), { status: 400 });
  }

  return withCache(`schedule:${code}`, SCHEDULE_TTL, async () => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetPlanlananSeferSaati_json xmlns="http://tempuri.org/">
      <HatKodu>${code.replace(/[<>&"']/g, "")}</HatKodu>
    </GetPlanlananSeferSaati_json>
  </soap:Body>
</soap:Envelope>`;

    const res = await request(SCHEDULE_URL, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        SOAPAction: `"http://tempuri.org/${SCHEDULE_ACTION}"`,
        "user-agent": "siradaki-metro/1.0",
      },
      body,
    });
    const xml = await res.text();
    if (!res.ok || !xml.includes("<GetPlanlananSeferSaati_jsonResult>")) {
      throw new Error(`İETT sefer saati servisi → HTTP ${res.status}`);
    }
    return parseLineSchedule(xml, code);
  });
}

/* ---------------- yolculuk planlama ---------------- */
const JOURNEY_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "tr-TR,tr;q=0.9,en;q=0.5",
  "cache-control": "no-cache",
  referer: "https://nasilgiderim.iett.gov.tr/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
};

function parseJourneyPoint(value, label) {
  const parts = String(value || "").split(",").map((part) => Number(part.trim()));
  if (
    parts.length !== 2 ||
    !Number.isFinite(parts[0]) ||
    !Number.isFinite(parts[1]) ||
    parts[0] < -90 ||
    parts[0] > 90 ||
    parts[1] < -180 ||
    parts[1] > 180
  ) {
    throw Object.assign(new Error(`Geçersiz ${label} konumu`), { status: 400 });
  }
  return { lat: parts[0], lng: parts[1] };
}

function istanbulDateTime(date = new Date()) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    date: `${parts.day}-${parts.month}-${parts.year}`,
    time: `${parts.hour}:${parts.minute}`,
    timezone: "Europe/Istanbul",
  };
}

function journeyTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function journeyMinutes(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(1, Math.round((end - start) / 60000));
}

async function requestJourneyJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await request(url, { headers: JOURNEY_HEADERS }, 6000);
      if (!res.ok) throw new Error(`İETT yolculuk servisi → HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 180));
    }
  }
  throw lastError;
}

function normalizeJourneyPlace(item, kind) {
  const point = Array.isArray(item?.point) ? item.point : [];
  const lat = Number(point[0]);
  const lng = Number(point[1]);
  const name = clean(item?.stopName || item?.name || item?.poiName);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const id = clean(item?.stopId || item?.id) || `${kind}:${name}:${lat}:${lng}`;
  return {
    id,
    name,
    district: clean(item?.district || item?.ilce || item?.districtName),
    point: [lat, lng],
    type: clean(item?.routeType) || (kind === "place" ? "poi" : "stop"),
    kind,
  };
}

function parseJourneySearch(data, query = "") {
  const seen = new Set();
  const places = [];
  const add = (items, kind, limit) => {
    let added = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (added >= limit) break;
      const place = normalizeJourneyPlace(item, kind);
      if (!place) continue;
      const key = `${place.kind}:${place.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(place);
      added += 1;
    }
  };
  add(data?.stops, "stop", 8);
  add(data?.pois, "place", 6);
  return {
    query: clean(query),
    places,
    stops: places.filter((place) => place.kind === "stop"),
    pois: places.filter((place) => place.kind === "place"),
  };
}

async function fetchJourneyPlaces(query) {
  const value = clean(query);
  if (value.length < 2) throw Object.assign(new Error("Arama için en az 2 harf girin"), { status: 400 });
  if (value.length > 80) throw Object.assign(new Error("Arama metni çok uzun"), { status: 400 });

  return withCache(`journey-search:${value.toLocaleLowerCase("tr")}`, JOURNEY_SEARCH_TTL, async () => {
    const url = new URL(JOURNEY_SEARCH_URL);
    url.searchParams.set("query", value);
    const data = await requestJourneyJson(url);
    return { ...parseJourneySearch(data, value), fetchedAt: new Date().toISOString() };
  });
}

function normalizeOsmSearch(value) {
  return clean(value).toLocaleLowerCase("tr")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/\bsk\b/g, "sokak").replace(/\bcd\b/g, "caddesi")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

async function loadLocalOsmPlaces() {
  if (!localOsmPlacesPromise) {
    localOsmPlacesPromise = readFile(LOCAL_OSM_INDEX_URL)
      .then((compressed) => gunzipAsync(compressed))
      .then((json) => JSON.parse(json.toString("utf8")).map((entry) => ({
        ...entry,
        _normalizedName: normalizeOsmSearch(entry.name),
        _searchable: ` ${normalizeOsmSearch([entry.name, ...(entry.aliases || []), entry.address, entry.shortAddress, entry.category].filter(Boolean).join(" "))} `,
      })))
      .catch((error) => {
        localOsmPlacesPromise = null;
        throw Object.assign(new Error("Yerel OpenStreetMap arama indeksi bulunamadı. tools/build-osm-place-index.mjs komutunu çalıştırın."), { status: 503, cause: error });
      });
  }
  return localOsmPlacesPromise;
}

export async function warmLocalOsmPlaces() {
  await loadLocalOsmPlaces();
}

async function fetchLocalOsmPlacePredictions(query, nameQuery) {
  const input = clean(query);
  if (input.length < 2) throw Object.assign(new Error("Arama için en az 2 harf girin."), { status: 400 });
  if (input.length > 80) throw Object.assign(new Error("Arama metni çok uzun."), { status: 400 });
  const index = await loadLocalOsmPlaces();
  const terms = normalizeOsmSearch(nameQuery || input).split(/\s+/).filter(Boolean);
  if (!terms.length) return { places: [] };

  const matches = [];
  for (const entry of index) {
    const [lat, lng] = entry.point || [];
    if (lat < 40.802 || lat > 41.700 || lng < 27.971 || lng > 29.959) continue;
    if (!terms.every((term) => entry._searchable.includes(term))) continue;
    const exactName = entry._normalizedName === terms.join(" ");
    const prefixName = entry._normalizedName.startsWith(terms.join(" "));
    matches.push({ entry, score: exactName ? 0 : prefixName ? 1 : 2 });
  }
  matches.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name, "tr"));
  return {
      places: matches.slice(0, 100).map(({ entry }) => ({
      id: entry.id,
      name: entry.name,
      address: entry.address,
      shortAddress: entry.shortAddress,
      point: entry.point,
      aliases: entry.aliases,
      category: entry.category,
      type: "poi",
      kind: "place",
      provider: "osm-local",
      dataAttribution: "© OpenStreetMap contributors",
      dataAttributionUrl: "https://www.openstreetmap.org/copyright",
      dataLicense: "Open Database License",
    })),
  };
}

function normalizeJourneyStop(stop) {
  const point = Array.isArray(stop?.point) ? stop.point : [];
  const lat = Number(point[0]);
  const lng = Number(point[1]);
  return {
    id: clean(stop?.stopId),
    name: clean(stop?.stopName),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

function normalizeJourneyLeg(leg) {
  const stops = (Array.isArray(leg?.stops) ? leg.stops : []).map(normalizeJourneyStop);
  const routeId = clean(leg?.routeId);
  const lineId = clean(leg?.lineId);
  const rawType = clean(leg?.type);
  const isWalking =
    rawType.toLocaleLowerCase("tr") === "walking" ||
    routeId.toLocaleLowerCase("tr") === "walking" ||
    lineId.toLocaleLowerCase("tr") === "walking" ||
    (!rawType && !lineId);
  const rawMode = isWalking ? "walking" : rawType || "transit";
  const departureTime = journeyTimestamp(leg?.departureTime);
  const arrivalTime = journeyTimestamp(leg?.arrivalTime);
  return {
    kind: isWalking ? "walk" : "transit",
    mode: rawMode,
    lineId: isWalking ? "" : lineId,
    routeId,
    lineName: clean(leg?.lineName),
    directionName: clean(leg?.directionName),
    from: stops[0] || { id: "", name: "", lat: null, lng: null },
    to: stops[stops.length - 1] || { id: "", name: "", lat: null, lng: null },
    departureTime,
    arrivalTime,
    durationMin: journeyMinutes(departureTime, arrivalTime),
    walkDistance: Number(leg?.walkDistance) || 0,
  };
}

function parseJourneyRoutes(data) {
  const rawRoutes = Array.isArray(data?.routes) ? data.routes : [];
  return rawRoutes
    .map((raw, index) => {
      const legs = (Array.isArray(raw?.path) ? raw.path : []).map(normalizeJourneyLeg);
      if (!legs.length) return null;
      const departureTime =
        journeyTimestamp(raw?.departureTime) ?? legs.find((leg) => Number.isFinite(leg.departureTime))?.departureTime ?? null;
      const arrivalTime =
        journeyTimestamp(raw?.arrivalTime) ??
        [...legs].reverse().find((leg) => Number.isFinite(leg.arrivalTime))?.arrivalTime ??
        null;
      const transitCount = legs.filter((leg) => leg.kind === "transit").length;
      return {
        id: index,
        departureTime,
        arrivalTime,
        durationMin: journeyMinutes(departureTime, arrivalTime),
        walkDistance: Number(raw?.walkDistance) || 0,
        totalFee: Number(raw?.totalFee) || 0,
        transfers: Math.max(0, transitCount - 1),
        legs,
      };
    })
    .filter(Boolean)
    .slice(0, JOURNEY_MAX_ROUTES);
}

async function fetchJourneyRoute(from, to, { plannedFor = istanbulDateTime(), isArrival = false } = {}) {
  const key = `journey:${from.lat.toFixed(5)},${from.lng.toFixed(5)}:${to.lat.toFixed(5)},${to.lng.toFixed(5)}:${plannedFor.date}:${plannedFor.time}:${isArrival ? "arrival" : "departure"}`;
  return withCache(key, JOURNEY_ROUTE_TTL, async () => {
    const url = new URL(JOURNEY_ROUTER_URL);
    url.searchParams.set("from", `${from.lat},${from.lng}`);
    url.searchParams.set("to", `${to.lat},${to.lng}`);
    url.searchParams.set("time", plannedFor.time);
    url.searchParams.set("date", plannedFor.date);
    url.searchParams.set("isArrival", isArrival ? "true" : "false");
    url.searchParams.set("optimizefor", "time");
    const data = await requestJourneyJson(url);
    return {
      routes: parseJourneyRoutes(data),
      plannedFor,
      fetchedAt: new Date().toISOString(),
    };
  });
}

/** İstemciden gelen YYYY-MM-DD / HH:MM değerlerini İETT'nin DD-MM-YYYY biçimine çevirir. */
function resolveJourneyPlan(dateValue, timeValue) {
  const date = String(dateValue || "").trim();
  const time = String(timeValue || "").trim();
  if (!date && !time) return { plannedFor: istanbulDateTime(), isArrival: false };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw Object.assign(new Error("Geçersiz tarih/saat. date=YYYY-MM-DD&time=HH:MM kullanın."), { status: 400 });
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    throw Object.assign(new Error("Geçersiz tarih/saat."), { status: 400 });
  }
  return {
    plannedFor: {
      date: `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}`,
      time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      timezone: "Europe/Istanbul",
    },
    isArrival: false,
  };
}

/* ---------------- istek yönlendirici ---------------- */
export async function handleBusRequest(url) {
  const type = url.searchParams.get("type") || "";
  const code = (url.searchParams.get("code") || "").trim();

  if (type === "health") {
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      body: { ok: true },
    };
  }

  try {
    if (type === "stop") {
      const data = await fetchStopBoard(code);
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, s-maxage=15, stale-while-revalidate=30",
        },
        body: data,
      };
    }

    if (type === "line") {
      const data = await fetchLineStops(code);
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
        body: data,
      };
    }

    if (type === "schedule") {
      const data = await fetchLineSchedule(code);
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, s-maxage=1800, stale-while-revalidate=3600",
        },
        body: data,
      };
    }

    if (type === "place") {
      const data = await fetchLocalOsmPlacePredictions(
        url.searchParams.get("q") || "",
        url.searchParams.get("name") || ""
      );
      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        body: data,
      };
    }

    if (type === "journey") {
      const from = parseJourneyPoint(url.searchParams.get("from"), "başlangıç");
      const to = parseJourneyPoint(url.searchParams.get("to"), "varış");
      const { plannedFor, isArrival } = resolveJourneyPlan(url.searchParams.get("date"), url.searchParams.get("time"));
      const data = await fetchJourneyRoute(from, to, { plannedFor, isArrival });
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, s-maxage=45, stale-while-revalidate=90",
        },
        body: data,
      };
    }

    if (type === "vehicles") {
      const data = await fetchLineVehicles(code);
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, s-maxage=10, stale-while-revalidate=20",
        },
        body: data,
      };
    }

    if (type === "announcements") {
      const data = await fetchAnnouncements();
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
        },
        body: data,
      };
    }

    if (type === "announcement") {
      const data = await fetchAnnouncementDetail((url.searchParams.get("id") || "").trim());
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
        body: data,
      };
    }

    return {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      body: { error: "Geçersiz istek. type=stop|line|schedule|vehicles|announcements|announcement|place|journey&code=…&id=…&q=…&from=…&to=… kullanın." },
    };
  } catch (e) {
    const status = e.status || 502;
    return {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      body: {
        error:
          status === 400
            ? e.message
            : status === 503
              ? e.message
              : "Ulaşım servisine ulaşılamadı. Lütfen biraz sonra tekrar deneyin.",
        detail: process.env.NODE_ENV === "development" ? String(e.message || e) : undefined,
      },
    };
  }
}

/* Testler için */
export {
  parseStopBoard,
  parseAnnouncementList,
  parseAnnouncementDetail,
  parseLineStops,
  parseLineVehicles,
  parseLineSchedule,
  parseJourneySearch,
  parseJourneyRoutes,
  fetchStopBoard,
  fetchAnnouncements,
  fetchAnnouncementDetail,
  fetchLineStops,
  fetchLineVehicles,
  fetchLineSchedule,
  fetchJourneyPlaces,
  fetchJourneyRoute,
};
