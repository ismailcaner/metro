/* İstanbul Ulaşım — uygulama mantığı (çerçevesiz, modüler vanilla JS) */

const API = "/api/metro";
const FAV_KEY = "sm.favorites";
const BUS_FAV_KEY = "sm.busFavs";
const RECENTS_KEY = "sm.recents";
const JOURNEY_RECENTS_KEY = "sm.journeyRecents";
const JOURNEY_RECENTS_CLEARED_AT_KEY = "sm.journeyRecentsClearedAt";
const RECENT_LIMIT = 8;
const QUICK_FAVORITE_LIMIT = 6;
const BUS_API = "api/bus";
const NEARBY_RADIUS_M = 500;
const METRO_NEARBY_RADIUS_M = 100;
const METRO_NEARBY_LINE_LIMIT = 3;
const BUS_NEARBY_STOP_LIMIT = 3;
const SCHEDULE_CACHE_TTL = 30 * 60_000;
const JOURNEY_MIN_QUERY = 2;
const SWIPE_EDGE_PX = 34;
const SWIPE_THRESHOLD_PX = 72;
const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const toastEl = $("#toast");

/* iOS PWA: pinch zoom ve çift dokunma yakınlaştırmasını kapat */
["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
  document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
});
document.addEventListener(
  "touchmove",
  (event) => {
    if (event.touches.length > 1) event.preventDefault();
  },
  { passive: false }
);

/* ---------------- state ---------------- */
const state = {
  lines: new Map(),        // code -> {code,name,color,first,last}
  stations: [],            // resmî API istasyon listesi (lat/lng dahil)
  stationIndex: new Map(), // normalize ad -> {key,name,entries:[{code,api,ttId,dirs}]}
  statuses: new Map(),     // code -> {active,desc,updated}
  timetable: null,
  generatedAt: null,
  favorites: new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")),
  bus: {
    lines: [],
    stops: [],
    lineStops: {},
    lineIndex: new Map(),
    stopIndex: new Map(),
    metrobusStopCodes: new Set(),
    metrobusStopLines: new Map(),
    metrobusStopGroupByCode: new Map(),
    metrobusListReverse: false,
    loaded: false,
    generatedAt: null,
    error: null,
    announcements: [],
    announcementsLoaded: false,
  },
  busFavs: new Set((JSON.parse(localStorage.getItem(BUS_FAV_KEY) || "[]") || []).map(Number).filter(Number.isFinite)),
  busDirSel: {},
  metroLineDirections: {},
  busCache: new Map(),
  busLineVehicles: new Map(),
  busLineView: null,
  busStopFocus: null,
  busSchedule: { code: null, open: false, day: null, dir: null, loading: false, error: null },
  busScheduleCache: new Map(),
  busScheduleCatalog: null,
  journey: {
    origin: null,
    destination: null,
    mode: "mixed",
    allowedModes: ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL", "OTHER"],
    routeSort: "fewest-transfers",
    wheelchairAccessibleOnly: false,
    timeMode: "now",
    departTime: "",
    originQuery: "",
    destinationQuery: "",
    originCleared: false,
    activeField: null,
    places: [],
    placesField: null,
    placesQuery: "",
    placesSessionToken: null,
    searchLoading: false,
    searchError: null,
    searchSeq: 0,
    routes: [],
    routesLoading: false,
    routesError: null,
    routesMeta: null,
    selected: 0,
    planSeq: 0,
    lastPlanKey: "",
  },
  journeyParent: null,
  settingsParent: null,
  lastLive: null,
  location: null,          // {lat,lng}
  route: { name: "home" },
};

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) =>
  String(s || "")
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function toast(msg, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toastEl.hidden = true), ms);
}

/* ---------------- tema ---------------- */
const THEME_KEY = "sm.theme";
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

function themePreference() {
  const value = localStorage.getItem(THEME_KEY);
  return ["dark", "light", "device"].includes(value) ? value : "device";
}

function resolvedTheme(pref = themePreference()) {
  return pref === "dark" || (pref === "device" && themeMedia.matches) ? "dark" : "light";
}

function applyTheme(pref = themePreference()) {
  const theme = resolvedTheme(pref);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f7fb" : "#0d1117");
}

function setThemePreference(pref) {
  if (!["dark", "light", "device"].includes(pref)) return;
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
  render();
}

applyTheme();
themeMedia.addEventListener?.("change", () => {
  if (themePreference() === "device") applyTheme("device");
});

/* ---------------- dil ---------------- */
const LANG_KEY = "sm.lang";

function langPreference() {
  return localStorage.getItem(LANG_KEY) === "en" ? "en" : "tr";
}

function isEnglish() {
  return langPreference() === "en";
}

function t(tr, en) {
  return isEnglish() ? en : tr;
}

function applyLanguage() {
  const en = isEnglish();
  document.documentElement.lang = en ? "en" : "tr";
  document.title = en
    ? "Istanbul Transit — Metro, metrobus & bus"
    : "İstanbul Ulaşım — Metro, metrobüs & otobüs";
  document.querySelector('meta[name="description"]')?.setAttribute(
    "content",
    en
      ? "Next departures for Istanbul metro, tram, metrobus and bus lines. Official timetables, live line status and IETT stop arrivals."
      : "İstanbul metro, tramvay, metrobüs ve otobüs hatlarında sıradaki sefer kaç dakika sonra? Resmî tarifeler, canlı hat durumu ve İETT durak varışları."
  );
  const manifest = document.querySelector('link[rel="manifest"]');
  if (manifest) manifest.setAttribute("href", en ? "/manifest.en.webmanifest" : "/manifest.webmanifest");
  const brandSub = $("#brandSub");
  if (brandSub) brandSub.textContent = t("İstanbul metro, metrobüs & otobüs", "Istanbul metro, metrobus & bus");
  $("#backBtn")?.setAttribute("aria-label", t("Geri", "Back"));
  const journeyBtn = $("#journeyBtn");
  journeyBtn?.setAttribute("aria-label", t("Yolculuğa çık", "Plan a trip"));
  journeyBtn?.setAttribute("title", t("Yolculuğa çık", "Plan a trip"));
  const journeyLabel = journeyBtn?.querySelector("span");
  if (journeyLabel) journeyLabel.textContent = t("Yolculuğa çık", "Plan a trip");
  const settingsBtn = $("#settingsBtn");
  settingsBtn?.setAttribute("aria-label", t("Ayarlar", "Settings"));
  settingsBtn?.setAttribute("title", t("Ayarlar", "Settings"));
  const tabLabels = [t("Otobüs", "Bus"), "Metro", t("Metrobüs", "Metrobus")];
  document.querySelectorAll(".tabbar button span").forEach((span, index) => {
    if (tabLabels[index]) span.textContent = tabLabels[index];
  });
}

function setLanguagePreference(lang) {
  if (!["tr", "en"].includes(lang)) return;
  localStorage.setItem(LANG_KEY, lang);
  applyLanguage();
  const j = state.journey;
  if (j.origin?.kind === "location") {
    j.origin = { ...j.origin, name: t("Konumunuz", "Your location"), district: t("Mevcut konumunuz", "Your current location") };
    j.originQuery = t("Konumunuz", "Your location");
  }
  if (j.destination?.kind === "location") {
    j.destination = {
      ...j.destination,
      name: t("Konumunuz", "Your location"),
      district: t("Mevcut konumunuz", "Your current location"),
    };
  }
  render();
}

applyLanguage();

function lineColor(code) {
  const l = state.lines.get(code);
  return l?.color || "#7c8593";
}

function badge(code, ghost = false) {
  return `<span class="badge${ghost ? " ghost" : ""}" style="--c:${lineColor(code)}">${esc(code)}</span>`;
}

function dayType(date) {
  const d = date.getDay();
  return d === 6 ? "sat" : d === 0 ? "sun" : "wd";
}

const DAY_NAMES = {
  tr: ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};
const dayName = (date) => (isEnglish() ? DAY_NAMES.en : DAY_NAMES.tr)[date.getDay()];
const fmtTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const fmtDate = (s) =>
  new Date(s).toLocaleString(isEnglish() ? "en-GB" : "tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Bir yönün zaman listesinden sıradaki kalkışları üretir */
function nextDepartures(times, count = 3, now = new Date()) {
  const out = [];
  for (let d = 0; d < 3 && out.length < count; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    day.setHours(0, 0, 0, 0);
    const list = times[dayType(day)] || times.wd || [];
    for (const t of list) {
      const [h, m] = t.split(":").map(Number);
      const when = new Date(day.getTime() + h * 3600e3 + m * 60e3);
      if (when.getTime() >= now.getTime()) out.push({ when, hhmm: t });
    }
  }
  return out.sort((a, b) => a.when - b.when).slice(0, count);
}

function minutesTo(when, now = new Date()) {
  return Math.round((when.getTime() - now.getTime()) / 60000);
}

function haversine(a, b) {
  const R = 6371e3, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function nearestStopInfo(stops, { maxDistance = NEARBY_RADIUS_M } = {}) {
  if (!state.location) return { index: -1, distance: null };
  let index = -1;
  let distance = Infinity;
  stops.forEach((stop, i) => {
    if (stop.lat == null || stop.lng == null) return;
    const d = haversine(state.location, { lat: stop.lat, lng: stop.lng });
    if (d < distance) {
      distance = d;
      index = i;
    }
  });
  const valid = Number.isFinite(distance);
  return {
    index: valid && distance <= maxDistance ? index : -1,
    distance: valid ? distance : null,
  };
}

function distanceText(distance) {
  if (distance == null) return "";
  return distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`;
}

function nearestStopLabel(info) {
  if (info.index < 0) return "";
  const distance = distanceText(info.distance);
  return `<span class="near-stop-label"><span class="near-stop-dot" aria-hidden="true"></span>${t("Tahmini konumunuz", "Your approximate location")}${distance ? ` · ${distance}` : ""}</span>`;
}

function lineLocationPrompt() {
  if (state.location) return "";
  return `<div class="line-location-prompt">
    <button class="dirchip" id="lineLocBtn">📍 ${t("Konumumu kullan", "Use my location")}</button>
    <span class="muted">${t("Tahmini konumunuza en yakın durağı görmek için konum izni verin.", "Allow location access to see the stop nearest to you.")}</span>
  </div>`;
}

function bindLineLocationPrompt() {
  $("#lineLocBtn")?.addEventListener("click", askLocation);
}

/* ---------------- yakındaki hatlar / duraklar ---------------- */
function nearestMetroLines(limit = METRO_NEARBY_LINE_LIMIT) {
  if (!state.location) return [];
  const byLine = new Map();
  for (const station of state.stations) {
    if (station.lat == null || station.lng == null || !station.code) continue;
    const distance = haversine(state.location, { lat: station.lat, lng: station.lng });
    const current = byLine.get(station.code);
    if (!current || distance < current.distance) {
      byLine.set(station.code, { code: station.code, station, distance });
    }
  }
  return [...byLine.values()]
    .filter((entry) => state.lines.has(entry.code))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

function nearbyMetroSection() {
  const title = t("Yakınındaki metro hatları", "Nearby metro lines");
  if (!state.location) {
    return `<div class="section-title">${title}</div>
      <div class="card tight nearby-prompt">
        <div class="muted">${t("Konum izni verdiğinizde size en yakın metro hatlarını ve duraklarını gösteririz.", "Allow location access to see the nearest metro lines and stops.")}</div>
        <button class="dirchip" id="nearbyMetroLoc" type="button">📍 ${t("Konumumu kullan", "Use my location")}</button>
      </div>`;
  }
  const near = nearestMetroLines();
  if (!near.length) {
    return `<div class="section-title">${title}</div>
      <div class="card tight"><div class="empty" style="padding:14px 4px">${t("Konumunuza yakın metro istasyonu bulunamadı.", "No metro station found near you.")}</div></div>`;
  }
  return `<div class="section-title">${title}</div>
    <div class="card">
      ${near
        .map(({ code, station, distance }) => {
          const line = state.lines.get(code);
          return `<div class="station-row nearby-line-row" data-near-line="${esc(code)}" role="button" tabindex="0">
            <div class="badges">${badge(code)}</div>
            <div class="grow">
              <div class="name">${esc(station.name)}</div>
              <div class="meta"><span>${esc(line?.name || code)}</span></div>
            </div>
            <div class="nearby-distance">${esc(distanceText(distance))}</div>
            <div class="go">›</div>
          </div>`;
        })
        .join("")}
    </div>`;
}

function bindNearbyMetroSection(root) {
  root.querySelectorAll("[data-near-line]").forEach((el) =>
    el.addEventListener("click", () => go(`#/hat/${encodeURIComponent(el.dataset.nearLine)}`))
  );
  $("#nearbyMetroLoc")?.addEventListener("click", askLocation);
}

function nearestMetrobusLines(limit = METRO_NEARBY_LINE_LIMIT) {
  if (!state.location || !state.bus.loaded) return [];
  return metrobusLines()
    .map((line) => {
      const data = state.bus.lineStops?.[line.code];
      let best = null;
      for (const dir of data?.directions || []) {
        for (const stop of dir.stops || []) {
          if (stop.lat == null || stop.lng == null) continue;
          const distance = haversine(state.location, { lat: stop.lat, lng: stop.lng });
          if (!best || distance < best.distance) best = { stop, distance };
        }
      }
      return best ? { line, ...best } : null;
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.distance - b.distance || a.line.code.localeCompare(b.line.code, "tr", { numeric: true })
    )
    .slice(0, limit);
}

function nearbyMetrobusSection() {
  const title = t("Yakınındaki metrobüs hatları", "Nearby metrobus lines");
  if (!state.location) {
    return `<div class="section-title">${title}</div>
      <div class="card tight nearby-prompt">
        <div class="muted">${t("Konum izni verdiğinizde size en yakın metrobüs hatlarını ve duraklarını gösteririz.", "Allow location access to see the nearest metrobus lines and stops.")}</div>
        <button class="dirchip" id="nearbyMetrobusLoc" type="button">📍 ${t("Konumumu kullan", "Use my location")}</button>
      </div>`;
  }
  const near = nearestMetrobusLines();
  if (!near.length) {
    return `<div class="section-title">${title}</div>
      <div class="card tight"><div class="empty" style="padding:14px 4px">${t("Konumunuza yakın metrobüs durağı bulunamadı.", "No metrobus stop found near you.")}</div></div>`;
  }
  return `<div class="section-title">${title}</div>
    <div class="card">
      ${near
        .map(
          ({ line, stop, distance }) => `<div class="station-row nearby-line-row" data-near-mb-line="${esc(line.code)}" role="button" tabindex="0">
            <div class="badges">${busBadge(line.code)}</div>
            <div class="grow">
              <div class="name">${esc(stop.name)}</div>
              <div class="meta"><span>${esc(line.name)}</span></div>
            </div>
            <div class="nearby-distance">${esc(distanceText(distance))}</div>
            <div class="go">›</div>
          </div>`
        )
        .join("")}
    </div>`;
}

function bindNearbyMetrobusSection(root) {
  root.querySelectorAll("[data-near-mb-line]").forEach((el) =>
    el.addEventListener("click", () =>
      go(`#/metrobus/hat/${encodeURIComponent(el.dataset.nearMbLine)}`)
    )
  );
  $("#nearbyMetrobusLoc")?.addEventListener("click", askLocation);
}

/* ---------------- data yükleme ---------------- */
async function fetchJson(url, { timeout = 7000, cache, signal } = {}) {
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, ...(cache ? { cache } : {}) });
    if (!r.ok) {
      const payload = await r.json().catch(() => ({}));
      const error = new Error(payload?.error || `HTTP ${r.status}`);
      error.status = r.status;
      throw error;
    }
    return await r.json();
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", abort);
  }
}

/** API rengi bazen {"Color_R":238,...} nesnesi, bazen metin olarak döner */
function parseColor(c) {
  if (!c) return null;
  if (typeof c === "object") {
    const { Color_R: r, Color_G: g, Color_B: b } = c;
    return r != null && g != null && b != null ? `rgb(${+r},${+g},${+b})` : null;
  }
  const mm = String(c).match(/\d+/g);
  return mm && mm.length >= 3 ? `rgb(${mm[0]},${mm[1]},${mm[2]})` : null;
}

function normalizeApiLines(data) {
  return data.map((x) => ({
    id: Number(x.Id),
    code: x.Name,
    name: x.LongDescription || x.Name,
    short: x.ShortDescription,
    color: parseColor(x.Color),
    first: x.FirstTime,
    last: x.LastTime,
  }));
}

function normalizeApiStations(data) {
  return data.map((s) => ({
    id: Number(s.Id),
    code: s.LineName, // hat kodu (M4, T1…)
    name: s.Description,
    line: s.LineName,
    order: s.Order,
    lat: s.DetailInfo?.Latitude ? Number(s.DetailInfo.Latitude) : null,
    lng: s.DetailInfo?.Longitude ? Number(s.DetailInfo.Longitude) : null,
    info: s.DetailInfo || null,
  }));
}

async function loadBase() {
  try {
    const [lines, stations] = await Promise.all([fetchJson(`${API}/GetLines`), fetchJson(`${API}/GetStations`)]);
    if (!lines.Success || !stations.Success) throw new Error("API Success=false");
    setLines(normalizeApiLines(lines.Data));
    state.stations = normalizeApiStations(stations.Data);
    state.lastLive = new Date();
  } catch (e) {
    console.warn("Canlı API alınamadı, paketli veri kullanılıyor:", e);
    const [lines, stations] = await Promise.all([fetchJson("data/lines.json"), fetchJson("data/stations.json")]);
    setLines(lines.lines.map((l) => ({ ...l, color: parseColor(l.color) })));
    state.stations = stations.stations; // paketli dosya uygulama biçiminde saklanır
  }
}

function setLines(list) {
  state.lines.clear();
  for (const l of list) state.lines.set(l.code, l);
}

async function loadTimetable() {
  const j = await fetchJson("data/timetable.json", { timeout: 15000 });
  state.timetable = j.lines;
  state.generatedAt = j.generatedAt;
}

async function loadStatuses() {
  try {
    const j = await fetchJson(`${API}/GetServiceStatuses`);
    if (!j.Success) throw new Error("status");
    state.statuses.clear();
    for (const s of j.Data) {
      state.statuses.set(s.LineName, { active: !!s.IsActive, desc: s.Description || "", updated: s.UpdateDate });
    }
    state.lastLive = new Date();
  } catch (e) {
    console.warn("Hat durumu alınamadı:", e);
  }
}

/** İETT hat ve durak kataloğunu (arama için) yükler */
async function loadBusData() {
  try {
    const [lineFile, stopFile, lineStopsFile] = await Promise.all([
      fetchJson("data/bus-lines.json", { timeout: 20000 }),
      fetchJson("data/bus-stops.json", { timeout: 25000 }),
      fetchJson("data/bus-line-stops.json", { timeout: 20000 }).catch(() => null),
    ]);
    state.bus.lines = (lineFile.lines || []).map(([code, name, tariff, length, duration]) => ({
      code,
      name,
      tariff,
      length,
      duration,
    }));
    state.bus.stops = (stopFile.stops || []).map(([code, name, district, direction, lat, lng]) => ({
      code,
      name,
      district,
      direction,
      lat,
      lng,
    }));
    state.bus.generatedAt = lineFile.generatedAt || stopFile.generatedAt || null;
    state.bus.lineStops = lineStopsFile?.lines || {};
    state.bus.lineIndex = new Map(state.bus.lines.map((l) => [l.code, l]));
    state.bus.stopIndex = new Map(state.bus.stops.map((s) => [s.code, s]));

    // Metrobüs aramasında yalnızca metrobüs hatlarının gerçekten uğradığı
    // platform duraklarını kullan; adında "metrobüs" geçen normal otobüs
    // durakları aramaya karışmasın.
    state.bus.metrobusStopCodes = new Set();
    state.bus.metrobusStopLines = new Map();
    state.bus.metrobusStopGroupByCode = new Map();
    for (const [code, line] of Object.entries(state.bus.lineStops)) {
      if (!isMetrobusLine(state.bus.lineIndex.get(code))) continue;
      for (const dir of line.directions || []) {
        for (const stop of dir.stops || []) {
          if (stop?.code == null) continue;
          const id = Number(stop.code);
          state.bus.metrobusStopCodes.add(id);
          if (!state.bus.metrobusStopLines.has(id)) state.bus.metrobusStopLines.set(id, []);
          const entries = state.bus.metrobusStopLines.get(id);
          let entry = entries.find((e) => e.code === code);
          if (!entry) {
            entry = { code, dirs: [] };
            entries.push(entry);
          }
          if (!entry.dirs.some((d) => d.from === dir.from && d.to === dir.to)) {
            entry.dirs.push({ from: dir.from, to: dir.to });
          }
        }
      }
    }

    const metrobusStopGroups = new Map();
    for (const code of state.bus.metrobusStopCodes) {
      const stop = state.bus.stopIndex.get(code);
      if (!stop) continue;
      const key = norm(stop.name);
      if (!metrobusStopGroups.has(key)) metrobusStopGroups.set(key, { ...stop, codes: [] });
      metrobusStopGroups.get(key).codes.push(code);
    }
    for (const group of metrobusStopGroups.values()) {
      group.codes.sort((a, b) => Number(a) - Number(b));
      for (const code of group.codes) state.bus.metrobusStopGroupByCode.set(code, group);
    }

    for (const l of state.bus.lines) {
      l._n = norm(`${l.code} ${l.name} ${l.tariff || ""}`);
      l._code = norm(l.code);
    }
    for (const s of state.bus.stops) {
      s._n = norm(`${s.name} ${s.district || ""} ${s.direction || ""} ${s.code}`);
      s._name = norm(s.name);
    }
    state.bus.loaded = true;
    const activeField = state.journey.activeField;
    if (activeField) scheduleJourneySearch(activeField, journeyQueryFor(activeField).trim());
  } catch (e) {
    console.warn("Otobüs verisi yüklenemedi:", e);
    state.bus.error = e;
  }
}

async function loadBusAnnouncements() {
  try {
    const data = await fetchBusApi({ type: "announcements" });
    state.bus.announcements = Array.isArray(data.announcements) ? data.announcements : [];
  } catch (e) {
    console.warn("İETT duyuruları alınamadı:", e);
  } finally {
    state.bus.announcementsLoaded = true;
  }
}

/** Tarife istasyonlarını resmî API istasyonlarıyla eşleştirip birleşik dizin kurar */
function buildStationIndex() {
  state.stationIndex.clear();
  const timetables = state.timetable || {};
  for (const [code, line] of Object.entries(timetables)) {
    for (const [ttId, st] of Object.entries(line.stations)) {
      const key = norm(st.name);
      if (!key) continue;
      if (!state.stationIndex.has(key)) state.stationIndex.set(key, { key, name: st.name, entries: [] });
      const api = state.stations.find((s) => s.code === code && norm(s.name) === key) || null;
      const dirs = Object.entries(st.dirs)
        .map(([id, d]) => ({ id, to: d.to, from: d.from, times: d.times }))
        // terminal istasyonda "varış yönü" seferlerini gösterme
        .filter((d) => !(norm(d.to) === key && norm(d.from) !== key))
        .sort((a, b) => (norm(a.from) === key ? 0 : 1) - (norm(b.from) === key ? 0 : 1));
      if (!dirs.length) continue;
      state.stationIndex.get(key).entries.push({ code, ttId, api, dirs });
    }
  }
  // koordinatları olan istasyonlar için temsili konum
  for (const s of state.stationIndex.values()) {
    const a = s.entries.map((e) => e.api).find((x) => x && x.lat);
    s.lat = a?.lat ?? null;
    s.lng = a?.lng ?? null;
    s.lines = [...new Set(s.entries.map((e) => e.code))];
  }
}

/* ---------------- otobüs yardımcıları ---------------- */
const BUS_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h12a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3v2h-2v-2H8v2H6v-2a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3m0 2a1 1 0 0 0-1 1v6h14V5a1 1 0 0 0-1-1zM6 18h12a1 1 0 0 0 1-1v-5H5v5a1 1 0 0 0 1 1m1-4.5A1.5 1.5 0 1 1 5.5 15 1.5 1.5 0 0 1 7 13.5m10 0A1.5 1.5 0 1 1 15.5 15 1.5 1.5 0 0 1 17 13.5M8 5h8v3H8z"/></svg>`;

function isMetrobusLine(line) {
  return line?.tariff === "METROBÜS";
}

const METROBUS_STOP_ORDER = [
  ["B.SONDURAK", "Beylikdüzü Sondurak (TÜYAP)"],
  ["BEYKENT", "Beykent"],
  ["CUMHURİYET MAHALLESİ", "Cumhuriyet Mahallesi"],
  ["B.BELEDİYE", "Beylikdüzü Belediye"],
  ["BEYLİKDÜZÜ", "Beylikdüzü"],
  ["GÜZELYURT", "Güzelyurt"],
  ["HARAMİDERE", "Haramidere"],
  ["H.SANAYİ", "Haramidere Sanayi"],
  ["SAADETDERE MAHALLESİ", "Saadetdere Mahallesi"],
  ["MUSTAFA KEMALPAŞA", "Mustafa Kemalpaşa"],
  ["CİHANGİR - ÜNİV.MAH.", "Cihangir - Üniversite Mahallesi"],
  ["AVCILAR MRK.ÜNV.KMP.", "Avcılar Merkez Üniversite Kampüsü"],
  ["ŞÜKRÜBEY", "Şükrübey"],
  ["İBB SOSYAL TESİSLERİ", "Büyükşehir Bld. Sosyal Tesisleri"],
  ["KÜÇÜKÇEKMECE", "Küçükçekmece"],
  ["CENNET MAHALLESİ", "Cennet Mahallesi"],
  ["FLORYA", "Florya"],
  ["BEŞYOL", "Beşyol"],
  ["SEFAKÖY", "Sefaköy"],
  ["YENİBOSNA", "Yenibosna"],
  ["ŞİRİNEVLER", "Şirinevler (Ataköy)"],
  ["BAHÇELİEVLER", "Bahçelievler"],
  ["İNCİRLİ", "İncirli - Ömür (Bakırköy)"],
  ["ZEYTİNBURNU", "Zeytinburnu"],
  ["MERTER", "Merter"],
  ["CEVİZLİBAĞ", "Cevizlibağ"],
  ["TOPKAPI - ŞEHİT MUSTAFA CAMBAZ", "Topkapı"],
  ["BAYRAMPAŞA - MALTEPE / KOÇ ÜNİVERSİTESİ HASTANESİ", "Bayrampaşa - Maltepe"],
  ["EDİRNEKAPI", "Edirnekapı"],
  ["AYVANSARAY EYÜPSULTAN", "Ayvansaray - Eyüpsultan"],
  ["HALICIOĞLU", "Halıcıoğlu"],
  ["OKMEYDANI", "Okmeydanı"],
  ["DARÜLACEZE PERPA", "Darülaceze - PERPA"],
  ["OKMEYDANI HASTANE", "Okmeydanı Hastane"],
  ["ÇAĞLAYAN", "Çağlayan (Adliye)"],
  ["MECİDİYEKÖY", "Mecidiyeköy"],
  ["ZİNCİRLİKUYU", "Zincirlikuyu"],
  ["15 TEMMUZ ŞEHİTLER KÖPRÜSÜ", "15 Temmuz Şehitler Köprüsü"],
  ["BURHANİYE", "Burhaniye"],
  ["ALTUNİZADE", "Altunizade"],
  ["ACIBADEM", "Acıbadem"],
  ["UZUNÇAYIR", "Uzunçayır (Ünalan)"],
  ["FİKİRTEPE", "Fikirtepe"],
  ["SÖĞÜTLÜÇEŞME", "Söğütlüçeşme"],
].map(([source, label], index) => [norm(source), label, index]);
const METROBUS_STOP_ORDER_BY_NAME = new Map(METROBUS_STOP_ORDER.map(([name, label, index]) => [name, { label, index }]));

function metrobusStopOrder(stop) {
  return METROBUS_STOP_ORDER_BY_NAME.get(norm(stop?.name));
}

function metrobusDirectionIsReverse(direction) {
  const endpointIndex = (name) => {
    const key = norm(name);
    const direct = METROBUS_STOP_ORDER_BY_NAME.get(key);
    if (direct) return direct.index;
    if (key.includes("avcilar")) return METROBUS_STOP_ORDER_BY_NAME.get(norm("AVCILAR MRK.ÜNV.KMP."))?.index ?? null;
    return null;
  };
  const from = endpointIndex(direction?.from);
  const to = endpointIndex(direction?.to);
  if (from == null || to == null || from === to) return null;
  return from > to;
}

function metrobusDirectionIndex(directions, reverse = state.bus.metrobusListReverse) {
  const index = directions.findIndex((direction) => metrobusDirectionIsReverse(direction) === reverse);
  return index >= 0 ? index : 0;
}

function isMetrobusStop(stop) {
  if (!stop) return false;
  const codes = state.bus.metrobusStopCodes;
  if (codes?.size) return codes.has(Number(stop.code));
  return norm(`${stop.name} ${stop.direction || ""}`).includes("metrobus");
}

function metrobusStopLines(stopOrCode) {
  const code = Number(typeof stopOrCode === "object" ? stopOrCode?.code : stopOrCode);
  if (!Number.isFinite(code)) return [];
  const codes = state.bus.metrobusStopGroupByCode.get(code)?.codes || [code];
  const lines = new Map();
  for (const stopCode of codes) {
    for (const item of state.bus.metrobusStopLines.get(stopCode) || []) {
      if (!lines.has(item.code)) lines.set(item.code, { ...item, dirs: [...item.dirs] });
      else {
        const target = lines.get(item.code);
        for (const dir of item.dirs) {
          if (!target.dirs.some((existing) => existing.from === dir.from && existing.to === dir.to)) target.dirs.push(dir);
        }
      }
    }
  }
  return [...lines.values()].sort((a, b) => (a.code === "34G" ? -1 : b.code === "34G" ? 1 : a.code.localeCompare(b.code, "tr", { numeric: true })));
}

function metrobusLines() {
  return state.bus.lines
    .filter(isMetrobusLine)
    .sort((a, b) => a.code.localeCompare(b.code, "tr", { numeric: true }));
}

function busColor(code) {
  const line = state.bus.lineIndex.get(code);
  return isMetrobusLine(line) ? "#c8102e" : "#0b6bcb";
}

function busBadge(code) {
  return `<span class="badge" style="--c:${busColor(code)}">${esc(code)}</span>`;
}

function busStopIcon() {
  return `<span class="bus-stop-icon">${BUS_SVG}</span>`;
}

function busSearch(q, { lineLimit = 12, stopLimit = 18, mode = "all" } = {}) {
  if (!q || !state.bus.loaded) return { lines: [], stops: [] };
  const lines = state.bus.lines
    .filter((l) => (mode === "metrobus" ? isMetrobusLine(l) : mode === "bus" ? !isMetrobusLine(l) : true))
    .filter((l) => l._n.includes(q))
    .sort((a, b) => {
      const ae = a._code === q ? 0 : a._code.startsWith(q) ? 1 : 2;
      const be = b._code === q ? 0 : b._code.startsWith(q) ? 1 : 2;
      return ae - be || a.code.localeCompare(b.code, "tr", { numeric: true });
    })
    .slice(0, lineLimit);
  const stops = state.bus.stops
    .filter((s) => (mode === "metrobus" ? isMetrobusStop(s) : mode === "bus" ? !isMetrobusStop(s) : true))
    .filter((s) => (mode === "metrobus" ? s._name.includes(q) || String(s.code).includes(q) : s._n.includes(q)))
    .sort((a, b) => {
      const ae = a._name === q ? 0 : a._name.startsWith(q) ? 1 : 2;
      const be = b._name === q ? 0 : b._name.startsWith(q) ? 1 : 2;
      return ae - be || a.name.localeCompare(b.name, "tr");
    })
    .slice(0, stopLimit);
  return { lines, stops };
}

function busLineRow(line) {
  return `<div class="station-row" data-bus-line="${esc(line.code)}" role="button" tabindex="0">
    <div class="badges">${busBadge(line.code)}</div>
    <div class="grow">
      <div class="name">${esc(line.name)}</div>
      <div class="meta">
        <span>${esc(line.tariff || t("Otobüs", "Bus"))}</span>
        ${line.duration ? `<span>·</span><span>~${line.duration} ${t("dk", "min")}</span>` : ""}
        ${line.length ? `<span>·</span><span>${line.length} km</span>` : ""}
      </div>
    </div>
    <div class="go">›</div>
  </div>`;
}

function busStopRow(stop) {
  const fav = state.busFavs.has(stop.code);
  const mbLines = isMetrobusStop(stop) ? metrobusStopLines(stop).map((entry) => entry.code) : [];
  const meta = [mbLines.length ? mbLines.join(", ") : "", stop.district || "", stop.direction ? `${stop.direction} ${t("yönü", "direction")}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<div class="station-row" data-bus-stop="${stop.code}" role="button" tabindex="0">
    ${mbLines.length ? `<div class="badges">${mbLines.map(busBadge).join("")}</div>` : busStopIcon()}
    <div class="grow">
      <div class="name">${esc(stop.name)}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
    </div>
    <button class="fav-btn ${fav ? "on" : ""}" data-bus-fav="${stop.code}" aria-label="${t("Favorilere ekle", "Add to favorites")}">${fav ? "★" : "☆"}</button>
  </div>`;
}

function metrobusStopRow(stop, { showFavoriteStar = false } = {}) {
  const codes = stop.codes || state.bus.metrobusStopGroupByCode.get(Number(stop.code))?.codes || [stop.code];
  const meta = [stop.district || ""]
    .filter(Boolean)
    .join(" · ");
  return `<div class="station-row" data-bus-stop="${stop.code}" data-bus-stop-codes="${codes.join(",")}" role="button" tabindex="0">
    <span class="metrobus-stop-icon" aria-hidden="true">Ⓜ</span>
    <div class="grow">
      <div class="name">${esc(metrobusStopOrder(stop)?.label || stop.name)}</div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
    </div>
    ${showFavoriteStar ? `<button class="fav-btn on" data-bus-fav="${stop.code}" data-bus-fav-codes="${codes.join(",")}" aria-label="${t("Favorilerden çıkar", "Remove from favorites")}">★</button>` : `<div class="go" aria-hidden="true">›</div>`}
  </div>`;
}

function nearbyMetrobusStops(limit = 3) {
  if (!state.location || !state.bus.loaded) return [];
  const uniqueStops = new Map();
  for (const [code, group] of state.bus.metrobusStopGroupByCode) {
    const stop = group || state.bus.stopIndex.get(Number(code));
    if (!stop || !metrobusStopOrder(stop) || stop.lat == null || stop.lng == null) continue;
    const key = norm(stop.name);
    if (uniqueStops.has(key)) continue;
    uniqueStops.set(key, {
      stop: { ...stop, codes: group?.codes || [Number(code)] },
      distance: haversine(state.location, { lat: stop.lat, lng: stop.lng }),
    });
  }
  return [...uniqueStops.values()].sort((a, b) => a.distance - b.distance).slice(0, limit);
}

function nearbyMetrobusStopsSection() {
  const title = t("Yakınındaki 3 metrobüs durağı", "Nearest 3 metrobus stops");
  if (!state.location) {
    return `<div class="section-title">${title}</div>
      <div class="card tight nearby-prompt">
        <div class="muted">${t("Konum izni verdiğinizde size en yakın 3 metrobüs durağını mesafeleriyle gösteririz.", "Allow location access to see the 3 nearest metrobus stops with their distances.")}</div>
        <button class="dirchip" id="metrobusNearbyLoc" type="button">📍 ${t("Konumumu kullan", "Use my location")}</button>
      </div>`;
  }
  const nearby = nearbyMetrobusStops();
  if (!nearby.length) {
    return `<div class="section-title">${title}</div>
      <div class="card tight"><div class="empty" style="padding:14px 4px">${t("Yakınınızda metrobüs durağı bulunamadı.", "No metrobus stops found near you.")}</div></div>`;
  }
  return `<div class="section-title">${title}</div>
    <div class="card nearby-stop-list">${nearby.map(({ stop, distance }) => `
      <div class="station-row nearby-stop-row" data-bus-stop="${stop.code}" data-bus-stop-codes="${(stop.codes || [stop.code]).join(",")}" role="button" tabindex="0">
        <span class="metrobus-stop-icon" aria-hidden="true">Ⓜ</span>
        <div class="grow">
          <div class="name">${esc(metrobusStopOrder(stop)?.label || stop.name)}</div>
          ${stop.district ? `<div class="meta">${esc(stop.district)}</div>` : ""}
        </div>
        <div class="nearby-distance">${esc(distanceText(distance))}</div>
        <div class="go" aria-hidden="true">›</div>
      </div>`).join("")}</div>`;
}

function nearbyBusStops({ limit = BUS_NEARBY_STOP_LIMIT, radius = Infinity } = {}) {
  if (!state.location || !state.bus.loaded) return [];
  return state.bus.stops
    .filter((stop) => stop.lat != null && stop.lng != null && !isMetrobusStop(stop))
    .map((stop) => ({
      stop,
      distance: haversine(state.location, { lat: stop.lat, lng: stop.lng }),
    }))
    .filter((entry) => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

function nearbyBusStopRow({ stop, distance }) {
  const meta = [stop.district, stop.direction ? `${stop.direction} ${t("yönü", "direction")}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<div class="station-row nearby-stop-row" data-bus-stop="${stop.code}" role="button" tabindex="0">
    ${busStopIcon()}
    <div class="grow">
      <div class="name">${esc(stop.name)}</div>
      <div class="meta">${esc(meta)}</div>
    </div>
    <div class="nearby-distance">${esc(distanceText(distance))}</div>
    <div class="go" aria-hidden="true">›</div>
  </div>`;
}

function nearbyBusSection() {
  const title = t(`Yakınındaki ${BUS_NEARBY_STOP_LIMIT} otobüs durağı`, `Nearest ${BUS_NEARBY_STOP_LIMIT} bus stops`);
  if (!state.location) {
    return `<div class="section-title">${title}</div>
      <div class="card tight nearby-prompt">
        <div class="muted">${t(`Konum izni verdiğinizde size en yakın ${BUS_NEARBY_STOP_LIMIT} otobüs durağını mesafeleriyle listeleriz.`, `Allow location access to list the ${BUS_NEARBY_STOP_LIMIT} bus stops nearest to you with distances.`)}</div>
        <button class="dirchip" id="busNearbyLoc" type="button">📍 ${t("Konumumu kullan", "Use my location")}</button>
      </div>`;
  }
  const nearby = nearbyBusStops();
  if (!nearby.length) {
    return `<div class="section-title">${title}</div>
      <div class="card tight"><div class="empty" style="padding:14px 4px">${t("Yakınınızda otobüs durağı bulunamadı.", "No bus stop found near you.")}<br><span class="muted">${t("Konumunuzu yenileyip tekrar deneyin.", "Refresh your location and try again.")}</span></div></div>`;
  }
  return `<div class="section-title">${title}</div>
    <div class="card nearby-stop-list">${nearby.map(nearbyBusStopRow).join("")}</div>`;
}

function bindBusRows(root, rerender = render, { mode = null, line = null, trackRecent = false } = {}) {
  root.querySelectorAll("[data-bus-stop]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-bus-fav]")) return;
      const stop = state.bus.stopIndex.get(Number(el.dataset.busStop));
      const targetMode = mode || (isMetrobusStop(stop) ? "metrobus" : "bus");
      const query = [];
      if (line) query.push(`hat=${encodeURIComponent(line)}`);
      const groupedCodes = (el.dataset.busStopCodes || "").split(",").map(Number).filter(Number.isFinite);
      if (targetMode === "metrobus" && groupedCodes.length > 1) query.push(`stops=${encodeURIComponent(groupedCodes.join(","))}`);
      if (trackRecent && stop) {
        rememberRecent({
          type: "busStop",
          id: Number(el.dataset.busStop),
          name: targetMode === "metrobus" ? metrobusStopOrder(stop)?.label || stop.name : stop.name,
          mode: targetMode,
          codes: targetMode === "metrobus" && groupedCodes.length ? groupedCodes : [Number(el.dataset.busStop)],
        });
      }
      go(`${targetMode === "metrobus" ? "#/metrobus" : "#/otobus"}/durak/${el.dataset.busStop}${query.length ? `?${query.join("&")}` : ""}`);
    })
  );
  root.querySelectorAll("[data-bus-line]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-bus-fav]")) return;
      const line = state.bus.lineIndex.get(el.dataset.busLine);
      const targetMode = mode || (isMetrobusLine(line) ? "metrobus" : "bus");
      if (trackRecent) {
        rememberRecent({
          type: "busLine",
          id: el.dataset.busLine,
          name: line?.name || el.dataset.busLine,
          mode: targetMode,
        });
      }
      go(`${targetMode === "metrobus" ? "#/metrobus" : "#/otobus"}/hat/${encodeURIComponent(el.dataset.busLine)}`);
    })
  );
  root.querySelectorAll("[data-bus-fav]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const codes = (btn.dataset.busFavCodes || "").split(",").map(Number).filter(Number.isFinite);
      if (codes.length > 1) {
        const remove = codes.some((code) => state.busFavs.has(code));
        for (const code of codes) remove ? state.busFavs.delete(code) : state.busFavs.add(code);
        localStorage.setItem(BUS_FAV_KEY, JSON.stringify([...state.busFavs]));
        toast(remove ? t("Favorilerden çıkarıldı", "Removed from favorites") : t("Durak favorilere eklendi ★", "Stop added to favorites ★"));
      } else toggleBusFav(btn.dataset.busFav, { silent: true });
      rerender();
    })
  );
}

function toggleBusFav(code, { silent = false } = {}) {
  if (!code) return;
  const numeric = Number(code);
  const key = Number.isFinite(numeric) ? numeric : code;
  state.busFavs.has(key) ? state.busFavs.delete(key) : state.busFavs.add(key);
  localStorage.setItem(BUS_FAV_KEY, JSON.stringify([...state.busFavs]));
  toast(state.busFavs.has(key) ? t("Durak favorilere eklendi ★", "Stop added to favorites ★") : t("Favorilerden çıkarıldı", "Removed from favorites"));
  if (!silent) render();
}

function fetchBusApi(params, { timeout = 12000 } = {}) {
  const query = new URLSearchParams(params);
  return fetchJson(`${BUS_API}?${query}`, { timeout, cache: "no-store" });
}

function announcementLineCodes(item) {
  const upper = String(item?.title || "").toLocaleUpperCase("tr");
  const tokens = upper.match(/[0-9A-ZÇĞİÖŞÜ]+/g) || [];
  return [...new Set(tokens.filter((token) => state.bus.lineIndex.has(token)))];
}

function announcementMode(item) {
  const codes = announcementLineCodes(item);
  const metroCodes = codes.filter((code) => isMetrobusLine(state.bus.lineIndex.get(code)));
  const regularCodes = codes.filter((code) => !isMetrobusLine(state.bus.lineIndex.get(code)));
  const mentionsMetrobus = /METROB[ÜU]S/.test(String(item?.title || "").toLocaleUpperCase("tr"));
  return {
    bus: regularCodes.length > 0 || (!mentionsMetrobus && metroCodes.length === 0),
    metrobus: metroCodes.length > 0 || mentionsMetrobus,
  };
}

function modeAnnouncements(mode, limit = 8) {
  return state.bus.announcements
    .filter((item) => (mode === "metrobus" ? announcementMode(item).metrobus : announcementMode(item).bus))
    .slice(0, limit);
}

function shortText(text, max = 88) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf(" "))).trim()}…`;
}

let annCardSeq = 0;

function announcementItem(item) {
  const title = `${
    item.badge ? `<span class="badge" style="--c:${item.color || "#888"}">${esc(item.badge)}</span>` : ""
  }<span class="ann-title">${esc(item.title)}</span>`;
  const body = item.body
    ? `<div class="ann-body" data-loaded="1"><p>${esc(item.body)}</p></div>`
    : `<div class="ann-body"><p class="muted">${t("Duyuru metni yükleniyor…", "Loading announcement…")}</p></div>`;
  return `<details class="ann-item"${item.announcementId ? ` data-ann-id="${esc(item.announcementId)}"` : ""}>
    <summary>
      <span class="ann-summary-main">
        <span class="ann-line">${title}</span>
        ${item.date ? `<time>${esc(item.date)}</time>` : ""}
      </span>
      <span class="ann-chevron" aria-hidden="true"></span>
    </summary>
    ${body}
  </details>`;
}

function announcementCard(title, items, { id = "", footer = "", className = "" } = {}) {
  if (!items.length) return "";
  const listId = `${id || "ann"}-list-${++annCardSeq}`;
  return `<div class="alert warn announce mode-announce${className ? ` ${esc(className)}` : ""}"${id ? ` id="${id}"` : ""}>
    <button class="ann-head ann-toggle" type="button" aria-expanded="false" aria-controls="${listId}">
      <span class="ann-head-title">📢 ${esc(title)} <span class="ann-count">${items.length}</span></span>
      <span class="ann-chevron" aria-hidden="true"></span>
    </button>
    <div class="ann-list" id="${listId}" hidden>
      ${items.map(announcementItem).join("")}
      ${footer ? `<p class="muted ann-foot">${esc(footer)}</p>` : ""}
    </div>
  </div>`;
}

function metroAnnouncementCard(items) {
  const announcements = items.map(([code, s]) => {
    const line = state.lines.get(code);
    return {
      badge: code,
      color: line?.color || "#888",
      title: shortText(s.desc || t("Aksama bildirildi.", "Service disruption reported.")),
      body: s.desc || t("Aksama bildirildi.", "Service disruption reported."),
    };
  });
  return announcementCard(t("Metro Uyarıları", "Metro alerts"), announcements, {
    id: "homeStatus",
    footer: state.lastLive ? `${t("Son güncelleme", "Last updated")}: ${fmtDate(state.lastLive)}` : "",
  });
}

function stopAnnouncementsBanner(announcements) {
  if (!announcements.length) return "";
  const items = announcements.map((item) => ({
    badge: item.line,
    color: "#888",
    title: shortText(item.text, 92),
    body: item.text,
  }));
  return announcementCard(t("Durak Uyarıları", "Stop alerts"), items);
}

async function loadAnnouncementText(item) {
  const body = item.querySelector(".ann-body");
  if (!body || item.dataset.loaded === "1" || item.dataset.loading === "1") return;
  item.dataset.loading = "1";
  body.innerHTML = `<p class="muted">${t("Duyuru metni yükleniyor…", "Loading announcement…")}</p>`;
  try {
    const data = await fetchBusApi({ type: "announcement", id: item.dataset.annId });
    body.innerHTML = `<p>${esc(data.content || t("Duyuru metni bulunamadı.", "Announcement text not found."))}</p>`;
    item.dataset.loaded = "1";
  } catch {
    body.innerHTML = `<p class="muted">${t("Duyuru metni alınamadı.", "Could not load announcement.")}</p><button class="dirchip ann-retry" type="button">↻ ${t("Tekrar dene", "Try again")}</button>`;
    body.querySelector(".ann-retry")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      item.dataset.loading = "";
      loadAnnouncementText(item);
    });
  } finally {
    item.dataset.loading = "";
  }
}

function bindAnnouncementItems(root) {
  root.querySelectorAll(".ann-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const card = toggle.closest(".announce");
      const list = card?.querySelector(".ann-list");
      if (!card || !list) return;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      list.hidden = expanded;
      if (expanded) {
        list.querySelectorAll(".ann-item[open]").forEach((item) => (item.open = false));
        list.classList.remove("has-open");
      }
    });
  });

  root.querySelectorAll("details.ann-item").forEach((item) => {
    item.addEventListener("toggle", () => {
      const list = item.closest(".ann-list");
      if (item.open && list) {
        list.querySelectorAll(".ann-item[open]").forEach((other) => {
          if (other !== item) other.open = false;
        });
      }
      if (list) list.classList.toggle("has-open", Boolean(list.querySelector(".ann-item[open]")));
      if (item.open && item.dataset.annId) loadAnnouncementText(item);
    });
  });
}

function hasActiveSearch() {
  return ["#q", "#busQ", "#metrobusQ"].some((selector) => ($(selector)?.value || "").trim());
}

/* ---------------- görünümler ---------------- */
function renderLoading(text = t("Veriler yükleniyor…", "Loading data…")) {
  view.innerHTML = `<div class="empty">${esc(text)}</div>`;
}

function renderHome() {
  const favs = [...state.favorites].map((k) => state.stationIndex.get(k)).filter(Boolean);
  const problematic = [...state.statuses.entries()].filter(([code, s]) => s.active && state.lines.has(code));
  view.innerHTML = `
    ${metroAnnouncementCard(problematic)}
    <div class="searchbox mode-search" id="searchBox">
      <input id="q" type="search" placeholder="${t("İstasyon veya hat ara", "Search station or line")}" autocomplete="off" />
      <svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2m0 2a6 6 0 1 1 0 12a6 6 0 0 1 0-12"/></svg>
    </div>
    <div id="searchResults"></div>

    <div id="homeExtras">
      ${nearbyMetroSection()}
      ${favs.length ? `<div class="section-title">${t("Favorilerim", "My favorites")}</div><div class="card">${favs.map(stationRow).join("")}</div>` : ""}

      <div class="section-title">${t("Tüm hatlar", "All lines")}</div>
      <div class="card" id="lineList">
        ${[...state.lines.values()]
          .sort((a, b) => a.code.localeCompare(b.code, "tr", { numeric: true }))
          .map(
            (l) => `
          <div class="station-row" data-line="${esc(l.code)}" role="button" tabindex="0">
            <div class="badges">${badge(l.code)}</div>
            <div class="grow"><div class="name" style="font-weight:500">${esc(l.name)}</div>
              <div class="meta">${esc(l.first || "")}${l.last ? " – " + esc(l.last) : ""} ${statusDot(l.code)}</div>
            </div><div class="go">›</div>
          </div>`
          )
          .join("")}
      </div>
      <div class="footer-note">${t("Metro tarifesi", "Metro timetable")}: ${state.generatedAt ? fmtDate(state.generatedAt) : "—"} · ${t("otobüs varışları İETT’den canlı", "bus arrivals live from İETT")}</div>
    </div>
  `;

  bindAnnouncementItems(view);
  bindNearbyMetroSection(view);
  $("#q")?.addEventListener("input", onSearch);
  $("#lineList")?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-line]");
    if (row) go(`#/hat/${row.dataset.line}`);
  });
  view.querySelectorAll("[data-station]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest(".fav-btn")) return;
      go(`#/istasyon/${el.dataset.station}`);
    })
  );
  view.querySelectorAll(".fav-btn[data-key]").forEach((b) => b.addEventListener("click", () => toggleFav(b.dataset.key)));
  renderHomeQuick($("#searchResults"));
}

function statusDot(code) {
  const s = state.statuses.get(code);
  if (!s) return "";
  const color = s.active ? "var(--warn)" : "var(--accent)";
  const title = s.active ? esc(s.desc || t("Aksama var", "Disruption")) : t("Normal işletme", "Normal service");
  return `<span class="statusdot" style="background:${color}" title="${title}"></span>`;
}

function stationRow(s) {
  const fav = state.favorites.has(s.key);
  const name = s.name;
  const codeList = s.lines;
  return `
    <div class="station-row" data-station="${esc(s.key)}" role="button" tabindex="0">
      <div class="badges">${codeList.map((c) => badge(c)).join("")}</div>
      <div class="grow">
        <div class="name">${esc(name)}</div>
        <div class="meta"><span>${codeList.join(", ")}</span></div>
      </div>
      <button class="fav-btn ${fav ? "on" : ""}" data-key="${esc(s.key)}" aria-label="${t("Favorilere ekle", "Add to favorites")}">${fav ? "★" : "☆"}</button>
    </div>`;
}

/* ---------------- son aramalar / hızlı erişim ---------------- */
function recentItems() {
  try {
    const items = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item.type === "string" && item.id != null && item.name)
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function rememberRecent(item) {
  if (!item || item.id == null || !item.name) return;
  const entry = { ...item, at: Date.now() };
  const key = `${entry.type}:${entry.id}`;
  const next = [entry, ...recentItems().filter((old) => `${old.type}:${old.id}` !== key)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {}
}

function journeyRecentPlaces() {
  let saved = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(JOURNEY_RECENTS_KEY) || "[]");
    if (Array.isArray(parsed)) saved = parsed.flatMap((place) => {
      if (place?.provider === "google") return [];
      return Array.isArray(place?.point) && place.point.length === 2 && place.point.every((value) => Number.isFinite(Number(value))) ? [place] : [];
    });
  } catch {}

  let clearedAt = 0;
  try { clearedAt = Number(localStorage.getItem(JOURNEY_RECENTS_CLEARED_AT_KEY)) || 0; } catch {}
  const fromSearch = recentItems().filter((item) => (Number(item.at) || 0) > clearedAt).flatMap((item) => {
    if (item.type === "station") {
      const station = state.stationIndex.get(norm(item.id));
      if (!station || !Number.isFinite(Number(station.lat)) || !Number.isFinite(Number(station.lng))) return [];
      return [{ id: `metro-station:${station.key}`, name: station.name, point: [Number(station.lat), Number(station.lng)], type: "metro", kind: "stop", lineCodes: station.lines || [], at: Number(item.at) || 0 }];
    }
    if (item.type === "busStop") {
      const stop = state.bus.stopIndex.get(Number(item.codes?.[0] ?? item.id));
      if (!stop || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))) return [];
      const mode = item.mode === "metrobus" || isMetrobusStop(stop) ? "metrobus" : "bus";
      return [{ id: `bus-stop:${stop.code}`, stopCode: String(stop.code), name: item.name || stop.name, district: stop.district || "", point: [Number(stop.lat), Number(stop.lng)], type: mode, kind: "stop", lineCodes: (state.bus.metrobusStopLines.get(Number(stop.code)) || []).map((line) => line.code), at: Number(item.at) || 0 }];
    }
    return [];
  });

  const seen = new Set();
  return [...saved, ...fromSearch]
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .filter((place) => {
      const key = String(place.id || `${place.name}:${place.point.join(",")}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function rememberJourneyPlace(place) {
  const entry = { ...place, at: Date.now() };
  const next = [entry, ...journeyRecentPlaces().filter((item) => item.id !== entry.id)].slice(0, 5);
  try { localStorage.setItem(JOURNEY_RECENTS_KEY, JSON.stringify(next)); } catch {}
}

function clearJourneyRecentPlaces() {
  try { localStorage.removeItem(JOURNEY_RECENTS_KEY); } catch {}
  try { localStorage.setItem(JOURNEY_RECENTS_CLEARED_AT_KEY, String(Date.now())); } catch {}
}

function clearRecentItems() {
  try {
    localStorage.removeItem(RECENTS_KEY);
  } catch {}
}

function recentLink(item) {
  if (item.type === "station") {
    const line = Array.isArray(item.lines) ? item.lines[0] : null;
    return `#/istasyon/${encodeURIComponent(item.id)}${line ? `?hat=${encodeURIComponent(line)}` : ""}`;
  }
  if (item.type === "busLine") {
    return `${item.mode === "metrobus" ? "#/metrobus" : "#/otobus"}/hat/${encodeURIComponent(item.id)}`;
  }
  const mode = item.mode === "metrobus" ? "metrobus" : "otobus";
  const codes = (Array.isArray(item.codes) ? item.codes : []).map(Number).filter(Number.isFinite);
  const query = item.mode === "metrobus" && codes.length > 1 ? `?stops=${encodeURIComponent(codes.join(","))}` : "";
  return `#/${mode}/durak/${encodeURIComponent(item.id)}${query}`;
}

function recentBadge(item) {
  if (item.type === "station") {
    const lines = Array.isArray(item.lines) ? item.lines : [];
    return `<div class="badges">${lines.map((code) => badge(code)).join("")}</div>`;
  }
  if (item.type === "busLine") return `<div class="badges">${busBadge(item.id)}</div>`;
  if (item.mode === "metrobus") return `<span class="metrobus-stop-icon" aria-hidden="true">Ⓜ</span>`;
  return busStopIcon();
}

function recentMeta(item) {
  if (item.type === "station") {
    return [t("Metro istasyonu", "Metro station"), ...(item.lines || [])].filter(Boolean).join(" · ");
  }
  if (item.type === "busLine") {
    return item.mode === "metrobus" ? t("Metrobüs hattı", "Metrobus line") : t("Otobüs hattı", "Bus line");
  }
  return item.mode === "metrobus" ? t("Metrobüs durağı", "Metrobus stop") : t("Otobüs durağı", "Bus stop");
}

function quickFavoriteItems() {
  const items = [];
  for (const key of state.favorites) {
    const station = state.stationIndex.get(key);
    if (!station) continue;
    items.push({ type: "station", id: station.key, name: station.name, lines: station.lines });
  }

  const seenStops = new Set();
  for (const rawCode of state.busFavs) {
    const stop = state.bus.stopIndex.get(Number(rawCode));
    if (!stop) continue;
    const metrobus = isMetrobusStop(stop);
    const group = metrobus ? state.bus.metrobusStopGroupByCode.get(Number(stop.code)) : null;
    const codes = (group?.codes || [Number(stop.code)]).map(Number).filter(Number.isFinite);
    const id = metrobus ? Math.min(...codes) : Number(stop.code);
    const key = `${metrobus ? "metrobus" : "bus"}:${id}`;
    if (seenStops.has(key)) continue;
    seenStops.add(key);
    items.push({
      type: "busStop",
      id,
      name: metrobus ? metrobusStopOrder(stop)?.label || stop.name : stop.name,
      mode: metrobus ? "metrobus" : "bus",
      codes,
    });
  }
  return items.slice(0, QUICK_FAVORITE_LIMIT);
}

function quickRow(item, source, index) {
  return `<div class="station-row quick-row" data-quick="${source}:${index}" role="button" tabindex="0">
    ${recentBadge(item)}
    <div class="grow">
      <div class="name">${esc(item.name)}</div>
      <div class="meta">${esc(recentMeta(item))}</div>
    </div>
    <div class="go" aria-hidden="true">›</div>
  </div>`;
}

function bindQuickRows(box, recents, favorites, onClear) {
  box.querySelectorAll("[data-quick]").forEach((row) => {
    const [source, rawIndex] = row.dataset.quick.split(":");
    const list = source === "favorite" ? favorites : recents;
    const item = list[Number(rawIndex)];
    if (!item) return;
    const open = () => {
      rememberRecent(item);
      go(recentLink(item));
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  box.querySelector("#clearRecents")?.addEventListener("click", () => {
    clearRecentItems();
    onClear?.();
  });
}

function renderHomeQuick(box) {
  const recents = recentItems();
  box.innerHTML = recents.length
    ? `<div class="section-head">
        <div class="section-title">${t("Son aramalar", "Recent searches")}</div>
        <button type="button" class="dirchip" id="clearRecents">${t("Temizle", "Clear")}</button>
      </div>
      <div class="card">${recents.map((item, index) => quickRow(item, "recent", index)).join("")}</div>`
    : "";
  bindQuickRows(box, recents, [], () => renderHomeQuick(box));
}

function renderSearchQuick(box) {
  const recents = recentItems();
  const favorites = quickFavoriteItems();
  const sections = [];
  if (recents.length) {
    sections.push(`<div class="section-head">
      <div class="section-title">${t("Son aramalar", "Recent searches")}</div>
      <button type="button" class="dirchip" id="clearRecents">${t("Temizle", "Clear")}</button>
    </div>
    <div class="card">${recents.map((item, index) => quickRow(item, "recent", index)).join("")}</div>`);
  }
  if (favorites.length) {
    sections.push(`<div class="section-title">${t("Hızlı erişim", "Quick access")}</div>
      <div class="card">${favorites.map((item, index) => quickRow(item, "favorite", index)).join("")}</div>`);
  }
  if (!sections.length) {
    sections.push(`<div class="empty">${t("İstasyon, hat veya durak arayın. Son aramalarınız burada görünecek.", "Search for a station, line or stop. Your recent searches will appear here.")}</div>`);
  }
  box.innerHTML = sections.join("");
  bindQuickRows(box, recents, favorites, () => renderSearchQuick(box));
}

function searchAll(q, { metroLimit = 15, lineLimit = 10, stopLimit = 15, scope = "all" } = {}) {
  const metro =
    scope === "bus" || scope === "metrobus"
      ? []
      : [...state.stationIndex.values()]
          .filter((s) => norm(s.name).includes(q) || s.lines.some((c) => norm(c).includes(q)))
          .sort((a, b) => (state.favorites.has(b.key) ? 1 : 0) - (state.favorites.has(a.key) ? 1 : 0))
          .slice(0, metroLimit);
  const bus =
    scope === "metro" || !state.bus.loaded
      ? { lines: [], stops: [] }
      : busSearch(q, { lineLimit, stopLimit, mode: scope });
  return { metro, lines: bus.lines, stops: bus.stops };
}

function bindSearchRows(box, rerender) {
  box.querySelectorAll("[data-station]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target.closest(".fav-btn")) return;
      const station = state.stationIndex.get(el.dataset.station);
      if (station) rememberRecent({ type: "station", id: station.key, name: station.name, lines: station.lines });
      go(`#/istasyon/${el.dataset.station}`);
    })
  );
  box.querySelectorAll(".fav-btn[data-key]").forEach((b) =>
    b.addEventListener("click", () => {
      toggleFav(b.dataset.key, { silent: true });
      rerender();
    })
  );
  bindBusRows(box, rerender, { trackRecent: true });
}

function renderSearchSections(raw, box, rerender, limits, scope = "all") {
  const q = norm(raw);
  if (!q) {
    box.innerHTML = "";
    return;
  }
  const { metro, lines, stops } = searchAll(q, { ...(limits || {}), scope });
  const sections = [];
  if (metro.length) {
    sections.push(`<div class="section-title">${t("Metro & tramvay", "Metro & tram")}</div><div class="card">${metro.map(stationRow).join("")}</div>`);
  }
  if (lines.length) {
    sections.push(`<div class="section-title">${t("Otobüs hatları", "Bus lines")}</div><div class="card">${lines.map(busLineRow).join("")}</div>`);
  }
  if (stops.length) {
    sections.push(`<div class="section-title">${t("Otobüs durakları", "Bus stops")}</div><div class="card">${stops.map(busStopRow).join("")}</div>`);
  }
  box.innerHTML = sections.length
    ? sections.join("")
    : `<div class="empty">${t(`"${esc(raw)}" için sonuç bulunamadı.`, `No results for "${esc(raw)}".`)}</div>`;
  bindSearchRows(box, rerender);
}

function onSearch(e) {
  const box = $("#searchResults");
  const searching = !!norm(e.target.value);
  $("#homeStatus")?.toggleAttribute("hidden", searching);
  $("#homeExtras")?.toggleAttribute("hidden", searching);
  if (!searching) {
    renderHomeQuick(box);
    return;
  }
  renderSearchSections(e.target.value, box, () => onSearch(e), undefined, "metro");
}

function onGlobalSearch(e) {
  const box = $("#globalResults");
  if (!norm(e.target.value)) {
    renderSearchQuick(box);
    return;
  }
  renderSearchSections(e.target.value, box, () => onGlobalSearch(e), { metroLimit: 20, lineLimit: 12, stopLimit: 20 });
}

function renderSearchPage() {
  view.innerHTML = `
    <div class="searchbox">
      <input id="globalQ" type="search" placeholder="${t("İstasyon, hat veya durak ara…", "Search station, line or stop…")}" autocomplete="off" />
      <svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2m0 2a6 6 0 1 1 0 12a6 6 0 0 1 0-12"/></svg>
    </div>
    <div id="globalResults"></div>`;
  $("#globalQ")?.addEventListener("input", onGlobalSearch);
  renderSearchQuick($("#globalResults"));
}

/* ---------------- yolculuk planlayıcı ---------------- */
const JOURNEY_MODE_META = {
  walking: { get label() { return t("Yürüyüş", "Walk"); }, icon: "🚶", color: "#7c8593" },
  metro: { get label() { return "Metro"; }, icon: "🚇", color: "#d81e35" },
  marmaray: { get label() { return "Marmaray"; }, icon: "🚆", color: "#0e7490" },
  mar: { get label() { return "Marmaray"; }, icon: "🚆", color: "#0e7490" },
  tren: { get label() { return t("Tren", "Train"); }, icon: "🚆", color: "#0e7490" },
  bus: { get label() { return t("Otobüs", "Bus"); }, icon: "🚌", color: "#0b6bcb" },
  otobus: { get label() { return t("Otobüs", "Bus"); }, icon: "🚌", color: "#0b6bcb" },
  metrobus: { get label() { return t("Metrobüs", "Metrobus"); }, icon: "🚍", color: "#c8102e" },
  tram: { get label() { return t("Tramvay", "Tram"); }, icon: "🚋", color: "#d97706" },
  tramvay: { get label() { return t("Tramvay", "Tram"); }, icon: "🚋", color: "#d97706" },
  funicular: { get label() { return t("Füniküler", "Funicular"); }, icon: "🚡", color: "#7c3aed" },
  funikuler: { get label() { return t("Füniküler", "Funicular"); }, icon: "🚡", color: "#7c3aed" },
  funi: { get label() { return t("Füniküler", "Funicular"); }, icon: "🚡", color: "#7c3aed" },
  teleferik: { get label() { return t("Teleferik", "Cable car"); }, icon: "🚡", color: "#7c3aed" },
  tele: { get label() { return t("Teleferik", "Cable car"); }, icon: "🚡", color: "#7c3aed" },
  turyol: { get label() { return "Turyol"; }, icon: "⛴️", color: "#0f7fa8" },
  ferry: { get label() { return t("Vapur", "Ferry"); }, icon: "⛴️", color: "#0f7fa8" },
  vapur: { get label() { return t("Vapur", "Ferry"); }, icon: "⛴️", color: "#0f7fa8" },
  shatlari: { get label() { return t("Şehir Hatları", "City Lines"); }, icon: "⛴️", color: "#0f7fa8" },
  ido: { get label() { return "İDO"; }, icon: "⛴️", color: "#0f7fa8" },
  dentur: { get label() { return "Dentur"; }, icon: "⛴️", color: "#0f7fa8" },
  taksidolmus: { get label() { return t("Taksi dolmuş", "Shared taxi"); }, icon: "🚐", color: "#b45309" },
  dolmus: { get label() { return t("Dolmuş", "Dolmuş"); }, icon: "🚐", color: "#b45309" },
  minibus: { get label() { return t("Minibüs", "Minibus"); }, icon: "🚐", color: "#b45309" },
  transit: { get label() { return t("Toplu taşıma", "Public transit"); }, icon: "🚏", color: "#6b7280" },
};
const JOURNEY_PLACE_LABELS = {
  tr: {
    bus: "Otobüs durağı",
    otobus: "Otobüs durağı",
    metro: "Metro istasyonu",
    marmaray: "Marmaray istasyonu",
    mar: "Marmaray istasyonu",
    tram: "Tramvay durağı",
    tramvay: "Tramvay durağı",
    metrobus: "Metrobüs durağı",
    funicular: "Füniküler istasyonu",
    funikuler: "Füniküler istasyonu",
    funi: "Füniküler istasyonu",
    teleferik: "Teleferik istasyonu",
    tele: "Teleferik istasyonu",
    turyol: "Vapur iskelesi",
    ferry: "Vapur iskelesi",
    vapur: "Vapur iskelesi",
    shatlari: "Vapur iskelesi",
    ido: "Vapur iskelesi",
    dentur: "Vapur iskelesi",
    minibus: "Minibüs durağı",
    dolmus: "Dolmuş durağı",
    taksidolmus: "Taksi dolmuş durağı",
    poi: "Yer",
  },
  en: {
    bus: "Bus stop",
    otobus: "Bus stop",
    metro: "Metro station",
    marmaray: "Marmaray station",
    mar: "Marmaray station",
    tram: "Tram stop",
    tramvay: "Tram stop",
    metrobus: "Metrobus stop",
    funicular: "Funicular station",
    funikuler: "Funicular station",
    funi: "Funicular station",
    teleferik: "Cable car station",
    tele: "Cable car station",
    turyol: "Ferry pier",
    ferry: "Ferry pier",
    vapur: "Ferry pier",
    shatlari: "Ferry pier",
    ido: "Ferry pier",
    dentur: "Ferry pier",
    minibus: "Minibus stop",
    dolmus: "Dolmuş stop",
    taksidolmus: "Shared taxi stop",
    poi: "Place",
  },
};
let journeySearchTimer = null;
let journeySearchController = null;
function cancelJourneyPlaceRequest() {
  clearTimeout(journeySearchTimer);
  journeySearchTimer = null;
  journeySearchController?.abort();
  journeySearchController = null;
}

const JOURNEY_TR_MAP = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };

function journeySlug(value) {
  return String(value || "")
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşüâîû]/g, (char) => JOURNEY_TR_MAP[char] || char)
    .replace(/[^a-z0-9]+/g, "");
}

function journeyModeKey(mode) {
  const key = journeySlug(mode) || "transit";
  return ({ otobus: "bus", tramvay: "tram", mar: "marmaray", vapur: "ferry", turyol: "ferry", ido: "ferry", dentur: "ferry", sehirhatlari: "ferry", shatlari: "ferry", funikuler: "funicular", funi: "funicular", tele: "teleferik", dolmus: "minibus", taksidolmus: "minibus" })[key] || key;
}

const JOURNEY_MODE_OPTIONS = [
  ["fastest", "En hızlı", "Fastest"],
  ["least-walking", "Az yürüme", "Least walking"],
  ["direct", "Aktarmasız", "Direct"],
  ["mixed", "Karışık", "Mixed"],
];

function journeyRouteMatchesMode(route, mode = state.journey.mode) {
  if (mode !== "direct") return true;
  return Number(route?.transfers) === 0;
}

function journeyModeMeta(mode) {
  return JOURNEY_MODE_META[journeyModeKey(mode)] || JOURNEY_MODE_META.transit;
}

function journeyPlaceTypeLabel(place) {
  if (!place) return "";
  const key = journeySlug(place.type);
  if (place.kind === "location" || key === "location") return t("Mevcut konumunuz", "Your current location");
  if (place.kind === "place" || key === "poi") return t("Yer", "Place");
  return (isEnglish() ? JOURNEY_PLACE_LABELS.en : JOURNEY_PLACE_LABELS.tr)[key] || t("Durak", "Stop");
}

function journeyPlaceIcon(place) {
  if (!place) return "📍";
  const key = journeySlug(place.type);
  if (place.kind === "location" || key === "location") return "📍";
  if (place.kind === "place" || key === "poi") return "📌";
  if (key === "metro") return "🚇";
  if (key === "marmaray" || key === "mar" || key === "tren") return "🚆";
  if (key === "tram" || key === "tramvay") return "🚋";
  if (key === "metrobus") return "🚍";
  if (key === "bus" || key === "otobus") return "🚌";
  if (key === "funi" || key === "funicular" || key === "funikuler" || key === "tele" || key === "teleferik") return "🚡";
  if (["turyol", "ferry", "vapur", "shatlari", "ido", "dentur"].includes(key)) return "⛴️";
  if (key === "minibus" || key === "taksidolmus" || key === "dolmus") return "🚐";
  return "📍";
}

function journeyPlaceMeta(place) {
  const details = place?.kind === "place" || place?.type === "poi"
    ? place.shortAddress || place.address || journeyPlaceCoordinateLabel(place)
    : [place?.category || journeyPlaceTypeLabel(place), place?.district || "", Array.isArray(place?.lineCodes) ? place.lineCodes.slice(0, 4).join(", ") : ""].filter(Boolean).join(" · ");
  const distance = journeyPlaceDistanceLabel(place);
  return [details, distance].filter(Boolean).join(" · ");
}

function journeyPlaceCoordinateLabel(place) {
  const point = place?.point;
  if (!Array.isArray(point) || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) return "";
  return `${Number(point[0]).toFixed(4)}, ${Number(point[1]).toFixed(4)}`;
}

function journeyReferencePoint() {
  const location = state.location;
  if (Number.isFinite(Number(location?.lat)) && Number.isFinite(Number(location?.lng))) {
    return { lat: Number(location.lat), lng: Number(location.lng) };
  }
  const point = state.journey.origin?.point;
  if (Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) {
    return { lat: Number(point[0]), lng: Number(point[1]) };
  }
  return null;
}

function journeyPlaceDistance(place) {
  const reference = journeyReferencePoint();
  const point = place?.point;
  if (!reference || !Array.isArray(point) || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) return null;
  return haversine(reference, { lat: Number(point[0]), lng: Number(point[1]) });
}

function journeyPlaceDistanceLabel(place) {
  const meters = journeyPlaceDistance(place);
  if (meters == null) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toLocaleString(isEnglish() ? "en-GB" : "tr-TR", { maximumFractionDigits: 1 })} km`;
}

function sortJourneyPlacesByDistance(places) {
  const reference = journeyReferencePoint();
  if (!reference) return places;
  return places.map((place, index) => ({ place, index, distance: journeyPlaceDistance(place) }))
    .sort((a, b) => {
      if (a.distance == null) return b.distance == null ? a.index - b.index : 1;
      if (b.distance == null) return -1;
      return a.distance - b.distance || a.index - b.index;
    })
    .map(({ place }) => place);
}

function journeyPlaceAttribution(places) {
  const sources = [...new Map((places || [])
    .filter((place) => place?.kind === "place" || place?.type === "poi")
    .map((place) => [place.dataAttribution || "© OpenStreetMap contributors", place.dataAttributionUrl || "https://www.openstreetmap.org/copyright"])).entries()];
  if (!sources.length) return "";
  const sourceLinks = sources.map(([label, url]) => {
    let safeUrl = "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") safeUrl = parsed.href;
    } catch {}
    return safeUrl ? `<a href="${esc(safeUrl)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : esc(label);
  }).join(" · ");
  return `<div class="journey-place-attribution" translate="no"><span>${sourceLinks}</span></div>`;
}

function journeyClock(value) {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || stamp <= 0) return "—";
  return new Intl.DateTimeFormat(isEnglish() ? "en-GB" : "tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Istanbul",
  }).format(new Date(stamp));
}

function journeyDurationText(minutes) {
  const value = Number(minutes);
  return Number.isFinite(value) && value > 0 ? `${Math.round(value)} ${t("dk", "min")}` : "—";
}

function journeyTransfersText(count) {
  const value = Math.max(0, Number(count) || 0);
  return value
    ? isEnglish()
      ? `${value} transfer${value === 1 ? "" : "s"}`
      : `${value} aktarma`
    : t("Aktarmasız", "Direct");
}

function journeyFareText(fee) {
  const value = Number(fee);
  if (!Number.isFinite(value) || value <= 0) return "";
  return `${value.toLocaleString(isEnglish() ? "en-GB" : "tr-TR", { maximumFractionDigits: 2 })} TL`;
}

function journeyRouteDuration(route) {
  return Number(route?.durationMin) || 0;
}

function journeyLineBadge(leg) {
  const code = String(leg?.lineId || "").trim();
  const mode = journeyModeKey(leg?.mode);
  if (
    code &&
    state.lines.has(code) &&
    ["metro", "tram", "tramvay", "funicular", "funikuler", "funi", "teleferik", "tele", "mar", "marmaray"].includes(mode)
  ) {
    return badge(code);
  }
  if (code && ["bus", "metrobus"].includes(mode) && state.bus.lineIndex.has(code)) {
    return busBadge(code);
  }
  const meta = journeyModeMeta(leg?.mode);
  return `<span class="badge journey-badge" style="--c:${meta.color}">${esc(code || meta.label)}</span>`;
}

function journeyLegTitle(leg) {
  return String(leg?.lineName || leg?.lineId || journeyModeMeta(leg?.mode).label).trim();
}

function journeyLegEndpoint(leg, which, index, total) {
  const endpoint = leg?.[which];
  const name = String(endpoint?.name || "").trim();
  const title = journeyLegTitle(leg);
  const duplicate = Boolean(leg?.from?.name && leg.from.name === leg.to?.name);
  if (name && !(duplicate && name === title)) return name;
  if (which === "from") {
    if (index === 0) return state.journey.origin?.name || t("Başlangıç", "Origin");
    return t("Biniş noktası", "Boarding point");
  }
  if (index === total - 1) return state.journey.destination?.name || t("Varış", "Destination");
  return t("İniş noktası", "Alighting point");
}

function journeyLocationPlace() {
  if (!state.location) return null;
  return {
    id: "current-location",
    name: t("Konumunuz", "Your location"),
    district: t("Mevcut konumunuz", "Your current location"),
    point: [state.location.lat, state.location.lng],
    type: "location",
    kind: "location",
  };
}

function ensureJourneyOrigin() {
  const j = state.journey;
  if (j.origin?.kind === "location") {
    if (state.location) {
      j.origin = journeyLocationPlace();
      j.originQuery = t("Konumunuz", "Your location");
    } else {
      j.origin = null;
      j.originQuery = "";
      j.originCleared = false;
      resetJourneyRoutes();
    }
    return;
  }
  if (!state.location || j.origin || j.originCleared) return;
  j.origin = journeyLocationPlace();
  j.originQuery = t("Konumunuz", "Your location");
}

function journeyPointParam(place) {
  const lat = Number(place?.point?.[0]);
  const lng = Number(place?.point?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function journeyIstanbulParts(date = new Date()) {
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
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function journeyDepartureDate(time) {
  const now = journeyIstanbulParts();
  if (!time || time > now.time) return now.date;
  const [year, month, day] = now.date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function journeyPlannedFor() {
  const j = state.journey;
  if (j.timeMode !== "depart" || !j.departTime) return null;
  return { date: journeyDepartureDate(j.departTime), time: j.departTime };
}

function journeyPairKey() {
  const planned = journeyPlannedFor();
  return `${journeyPointParam(state.journey.origin)}|${journeyPointParam(state.journey.destination)}|${state.journey.mode}|${planned ? `${planned.date}T${planned.time}` : "now"}`;
}

function resetJourneyRoutes() {
  const j = state.journey;
  j.planSeq += 1;
  j.routes = [];
  j.routesLoading = false;
  j.routesError = null;
  j.routesMeta = null;
  j.selected = 0;
  j.lastPlanKey = "";
}

function journeyQueryFor(field) {
  return field === "origin" ? state.journey.originQuery : state.journey.destinationQuery;
}

function setJourneyQuery(field, value) {
  if (field === "origin") state.journey.originQuery = value;
  else state.journey.destinationQuery = value;
}

function updateJourneyPlanButton() {
  const button = $("#journeyPlanBtn");
  if (!button) return;
  const j = state.journey;
  const ready = Boolean(j.origin && j.destination);
  button.disabled = !ready || j.routesLoading;
  button.textContent = j.routesLoading
    ? t("Planlanıyor…", "Planning…")
    : j.routes.length
      ? t("Yolculuğu yenile", "Refresh trip")
      : t("Yolculuğu planla", "Plan trip");
}

function updateJourneyInputAria() {
  const active = state.journey.activeField;
  $("#journeyOrigin")?.setAttribute("aria-expanded", String(active === "origin"));
  $("#journeyDestination")?.setAttribute("aria-expanded", String(active === "destination"));
}

function renderJourney() {
  ensureJourneyOrigin();
  const j = state.journey;
  const canPlan = Boolean(j.origin && j.destination);
  const originHint =
    j.origin?.kind === "location"
      ? t("Başlangıç olarak mevcut konumunuz kullanılıyor.", "Your current location is used as the starting point.")
      : j.origin
        ? t("Başlangıç noktanız seçildi; değiştirmek için Nereden alanına dokunun.", "Your starting point is selected; tap the From field to change it.")
        : state.location
          ? t("Başlangıç noktanızı yazın veya mevcut konumunuzu kullanın.", "Type your starting point or use your current location.")
          : t("Konum kapalıysa başlangıç noktanızı yazarak arayın.", "If location is off, search by typing your starting point.");
  view.innerHTML = `
    <div class="card journey-card">
      <div class="journey-inputs">
        <div class="journey-field" data-journey-field="origin">
          <span class="journey-pin" aria-hidden="true">A</span>
          <div class="grow">
            <label class="journey-field-label" for="journeyOrigin">${t("Nereden", "From")}</label>
            <input id="journeyOrigin" type="search" value="${esc(j.originQuery)}" placeholder="${t("Başlangıç veya mekân ara", "Search origin or place")}" maxlength="80"
              autocomplete="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="search"
              role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="journeySuggestions" />
          </div>
        </div>
        <div class="journey-field" data-journey-field="destination">
          <span class="journey-pin destination" aria-hidden="true">B</span>
          <div class="grow">
            <label class="journey-field-label" for="journeyDestination">${t("Nereye", "To")}</label>
            <input id="journeyDestination" type="search" value="${esc(j.destinationQuery)}" placeholder="${t("Durak, istasyon veya mekân ara", "Search stop, station or place")}" maxlength="80"
              autocomplete="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="search"
              role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="journeySuggestions" />
          </div>
        </div>
      </div>
      ${journeyPlaceAttribution([j.origin, j.destination])}
      <div class="journey-mode-picker">
        <div class="setting-title">${t("Rota tercihi?", "Route preference")}</div>
        <div class="journey-mode-options" role="group" aria-label="${t("Rota tercihi", "Route preference")}">
          ${JOURNEY_MODE_OPTIONS.map(([value, trLabel, enLabel]) => `<button type="button" class="journey-mode-option ${j.mode === value ? "active" : ""}" data-journey-mode="${value}" aria-pressed="${j.mode === value}">${t(trLabel, enLabel)}</button>`).join("")}
        </div>
      </div>
      <div class="journey-mode-picker">
        <div class="setting-title">${t("Kalkış zamanı", "Departure time")}</div>
        <div class="journey-mode-options" role="group" aria-label="${t("Kalkış zamanı", "Departure time")}">
          <button type="button" class="journey-mode-option ${j.timeMode === "now" ? "active" : ""}" data-journey-time="now" aria-pressed="${j.timeMode === "now"}">${t("Şimdi", "Now")}</button>
          <button type="button" class="journey-mode-option ${j.timeMode === "depart" ? "active" : ""}" data-journey-time="depart" aria-pressed="${j.timeMode === "depart"}">${t("Saat seç", "Choose time")}</button>
        </div>
        <input id="journeyTime" class="journey-time-input" type="time" value="${esc(j.departTime || journeyIstanbulParts(new Date(Date.now() + 15 * 60000)).time)}"
          aria-label="${t("Kalkış saati", "Departure time")}" ${j.timeMode === "depart" ? "" : "hidden"} />
      </div>
      <div id="journeySuggestions" class="journey-suggestions" hidden></div>
      <div class="journey-actions">
        <button id="journeyPlanBtn" class="journey-plan-btn" type="button" ${canPlan ? "" : "disabled"}>
          ${j.routesLoading ? t("Planlanıyor…", "Planning…") : j.routes.length ? t("Yolculuğu yenile", "Refresh trip") : t("Yolculuğu planla", "Plan trip")}
        </button>
        <span class="journey-hint">${originHint}</span>
      </div>
    </div>
    <div id="journeyResults"></div>
  `;

  bindJourneyInputs();
  view.querySelectorAll("[data-journey-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      const mode = button.dataset.journeyMode;
      if (mode === state.journey.mode) return;
      state.journey.mode = mode;
      resetJourneyRoutes();
      renderJourney();
    })
  );
  view.querySelectorAll("[data-journey-time]").forEach((button) =>
    button.addEventListener("click", () => {
      const timeMode = button.dataset.journeyTime;
      if (timeMode === state.journey.timeMode) return;
      state.journey.timeMode = timeMode;
      if (timeMode === "depart" && !state.journey.departTime) {
        state.journey.departTime = journeyIstanbulParts(new Date(Date.now() + 15 * 60000)).time;
      }
      resetJourneyRoutes();
      renderJourney();
    })
  );
  $("#journeyTime")?.addEventListener("change", (event) => {
    const value = event.target.value;
    if (!/^\d{2}:\d{2}$/.test(value)) return;
    state.journey.departTime = value;
    resetJourneyRoutes();
    renderJourney();
  });
  renderJourneySuggestions();
  if (j.origin && j.destination && !j.routesLoading && j.lastPlanKey !== journeyPairKey()) {
    planJourney();
  } else {
    renderJourneyResults();
  }
}

function bindJourneyInputs() {
  const origin = $("#journeyOrigin");
  const destination = $("#journeyDestination");
  [
    [origin, "origin"],
    [destination, "destination"],
  ].forEach(([input, field]) => {
    if (!input) return;
    input.addEventListener("focus", () => focusJourneyField(field));
    input.addEventListener("input", () => onJourneyInput(field, input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeJourneySuggestions();
        return;
      }
      if (event.key === "Enter" && state.journey.activeField === field && state.journey.places.length) {
        event.preventDefault();
        selectJourneyPlace(field, 0);
      }
    });
  });
  $("#journeyPlanBtn")?.addEventListener("click", () => planJourney({ force: true }));
}

function closeJourneySuggestions() {
  cancelJourneyPlaceRequest();
  const j = state.journey;
  j.searchSeq += 1;
  j.activeField = null;
  j.searchLoading = false;
  renderJourneySuggestions();
}

function focusJourneyField(field) {
  const j = state.journey;
  j.activeField = field;
  j.searchSeq += 1;
  cancelJourneyPlaceRequest();
  j.searchLoading = false;
  j.searchError = null;
  j.places = [];
  j.placesField = field;
  j.placesQuery = "";
  renderJourneySuggestions();
}

function onJourneyInput(field, value) {
  const j = state.journey;
  j.activeField = field;
  setJourneyQuery(field, value);
  if (field === "origin") {
    if (!j.origin || value !== j.origin.name) {
      j.origin = null;
      j.originCleared = true;
    }
  } else if (!j.destination || value !== j.destination.name) {
    j.destination = null;
  }
  resetJourneyRoutes();
  scheduleJourneySearch(field, value.trim());
  updateJourneyPlanButton();
  renderJourneyResults();
}

function localJourneyPlaces(query) {
  const q = norm(query);
  if (q.length < JOURNEY_MIN_QUERY) return [];
  const terms = q.split(/\s+/).filter(Boolean);

  const rankName = (name, all) => {
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    const words = norm(all).split(/\s+/).filter(Boolean);
    return terms.every((term) => words.some((word) => word.includes(term))) ? 3 : Infinity;
  };

  const busStops = state.bus.stops
    .map((stop) => ({
      stop,
      rank: rankName(stop._name || norm(stop.name), `${stop._n || `${stop.name} ${stop.district || ""} ${stop.direction || ""} ${stop.code}`} ${stop.lines?.map((line) => line.code).join(" ") || ""} otobüs bus`),
    }))
    .filter(({ stop, rank }) => rank < Infinity && stop.lat != null && stop.lng != null && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lng)))
    .sort((a, b) => a.rank - b.rank || a.stop.name.localeCompare(b.stop.name, "tr") || Number(a.stop.code) - Number(b.stop.code))
    .slice(0, 8)
    .map(({ stop }) => ({
      id: `bus-stop:${stop.code}`,
      stopCode: String(stop.code),
      name: stop.name,
      district: stop.district || "",
      point: [Number(stop.lat), Number(stop.lng)],
      type: "bus",
      kind: "stop",
      lineCodes: (state.bus.metrobusStopLines.get(Number(stop.code)) || []).map((entry) => entry.code),
    }));

  const stations = new Map();
  for (const station of state.stations) {
    const name = norm(station.name);
    const rank = rankName(name, `${name} metro ${station.code || ""}`);
    const lat = Number(station.lat);
    const lng = Number(station.lng);
    if (rank === Infinity || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = `${name}:${lat.toFixed(5)}:${lng.toFixed(5)}`;
    const existing = stations.get(key);
    if (existing) {
      if (station.code && !existing.place.lineCodes.includes(station.code)) existing.place.lineCodes.push(station.code);
      continue;
    }
    stations.set(key, {
      rank,
      place: {
        id: `metro-station:${key}`,
        name: station.name,
        point: [lat, lng],
        type: "metro",
        kind: "stop",
        lineCodes: station.code ? [station.code] : [],
      },
    });
  }

  const metroStops = [...stations.values()]
    .sort((a, b) => a.rank - b.rank || a.place.name.localeCompare(b.place.name, "tr"))
    .slice(0, 6)
    .map(({ place }) => place);

  return [...busStops, ...metroStops];
}

async function searchLocalJourneyPlaces(query, signal) {
  const params = new URLSearchParams({ type: "place", q: query, name: query });
  const result = await fetchJson(`${BUS_API}?${params}`, { signal, timeout: 5000, cache: "default" });
  return (Array.isArray(result?.places) ? result.places : []);
}

function scheduleJourneySearch(field, query) {
  const j = state.journey;
  cancelJourneyPlaceRequest();
  const requestId = ++j.searchSeq;
  const localStops = localJourneyPlaces(query);
  j.places = sortJourneyPlacesByDistance(localStops);
  j.placesField = field;
  j.placesQuery = query;
  j.searchError = null;
  j.searchLoading = norm(query).length >= JOURNEY_MIN_QUERY;
  renderJourneySuggestions();
  if (!j.searchLoading) return;

  const controller = new AbortController();
  journeySearchController = controller;
  journeySearchTimer = setTimeout(async () => {
    try {
      const localPlaces = await searchLocalJourneyPlaces(query, controller.signal);
      if (requestId !== j.searchSeq || j.activeField !== field || j.placesQuery !== query) return;
      j.places = sortJourneyPlacesByDistance([...localStops, ...localPlaces]);
      j.searchLoading = false;
      j.searchError = null;
    } catch (error) {
      if (error.name === "AbortError" || requestId !== j.searchSeq) return;
      j.searchLoading = false;
      j.searchError = error.status === 503
        ? t("Yerel OSM arama verisi hazır değil. npm run osm:index komutunu çalıştırın.", "Local OSM search data is unavailable. Run npm run osm:index.")
        : t("Yer araması yapılamadı. Durak sonuçları kullanılabilir.", "Place search failed. Stop results are still available.");
    }
    if (requestId === j.searchSeq) {
      renderJourneySuggestions();
    }
  }, 180);
}

function renderJourneySuggestions() {
  const box = $("#journeySuggestions");
  if (!box) return;
  const j = state.journey;
  updateJourneyInputAria();
  if (!j.activeField) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  const field = j.activeField;
  const query = journeyQueryFor(field).trim();
  const hasQuery = query.length >= JOURNEY_MIN_QUERY;
  const isEmptyQuery = query.length === 0;
  let body = "";

  if (field === "origin") {
    const locationLabel = state.location
      ? t("Mevcut konumunuzu başlangıç yap", "Use your current location as the origin")
      : t("Konum izni vererek başlangıcı bul", "Allow location access to find the origin");
    body += `<button class="journey-suggestion journey-location-suggestion" type="button" data-journey-location="1">
      <span class="journey-suggestion-icon">📍</span>
      <span class="grow">
        <span class="journey-suggestion-name">${t("Konumumu kullan", "Use my location")}</span>
        <span class="journey-suggestion-meta">${esc(locationLabel)}</span>
      </span>
      <span class="go">›</span>
    </button>`;
  }

  if (isEmptyQuery) {
    const recents = journeyRecentPlaces();
    if (recents.length) {
      body += `<div class="journey-suggestion-head"><span>${t("Son aramalar", "Recent places")}</span>
          <button class="journey-suggestion-clear" type="button" data-journey-clear-recent="1">${t("Temizle", "Clear")}</button></div>`;
      body += recents.map((place, index) => `<button class="journey-suggestion" type="button" data-journey-recent="${index}">
          <span class="journey-suggestion-icon">${journeyPlaceIcon(place)}</span>
          <span class="grow"><span class="journey-suggestion-name">${esc(place.name)}</span>
          <span class="journey-suggestion-meta">${esc(journeyPlaceMeta(place))}</span></span><span class="go">›</span>
        </button>`).join("");
    }
  } else if (!hasQuery) {
    body += `<div class="journey-suggestion-note">${t("Aramak için en az 2 harf yazın.", "Type at least 2 characters to search.")}</div>`;
  } else if (!j.placesQuery) {
    body += `<div class="journey-suggestion-note">${t("Yazmaya başlayın; durakları ve internetten yerleri arayalım.", "Start typing; we'll search stops and places online.")}</div>`;
  } else {
    if (j.searchLoading) body += `<div class="journey-suggestion-note"><span class="pulse"></span> ${t("Yerel durak ve mekân verisi aranıyor…", "Searching local stops and places…")}</div>`;
    if (j.places.length) {
      body += `<div class="journey-suggestion-head">${t("Yakından uzağa", "Nearest first")}</div>`;
      body += j.places.map((place, index) => `<button class="journey-suggestion" type="button" data-journey-place="${index}">
        <span class="journey-suggestion-icon">${journeyPlaceIcon(place)}</span>
        <span class="grow"><span class="journey-suggestion-name">${esc(place.name)}</span>
        <span class="journey-suggestion-meta">${esc(journeyPlaceMeta(place))}</span></span><span class="go">›</span>
      </button>`).join("");
    }
    if (j.searchError) body += `<div class="journey-suggestion-note">${esc(j.searchError)}</div>`;
    else if (!j.searchLoading && !j.places.length) body += `<div class="journey-suggestion-note">${t(`“${esc(j.placesQuery || query)}” için sonuç bulunamadı.`, `No results for “${esc(j.placesQuery || query)}”.`)}</div>`;
    if (!journeyReferencePoint() && j.places.length) body += `<div class="journey-suggestion-note">${t("Yakınlık sıralaması için başlangıç alanından konumunuzu kullanın.", "Use your location in the origin field to sort by distance.")}</div>`;
    body += journeyPlaceAttribution(j.places);
  }

  if (!body) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `${isEmptyQuery ? "" : `<div class="journey-suggestions-head">
    <span>${field === "origin" ? t("Başlangıç için sonuçlar", "Results for origin") : t("Varış için sonuçlar", "Results for destination")}</span>
    <button class="journey-suggestions-close" type="button" aria-label="${t("Aramayı kapat", "Close search")}" data-journey-close="1">×</button>
  </div>`}${body}`;
  box.hidden = false;

  box.querySelectorAll("[data-journey-place]").forEach((button) =>
    button.addEventListener("click", () => selectJourneyPlace(field, Number(button.dataset.journeyPlace)))
  );
  box.querySelectorAll("[data-journey-recent]").forEach((button) =>
    button.addEventListener("click", () => selectJourneyRecentPlace(field, Number(button.dataset.journeyRecent)))
  );
  box.querySelector("[data-journey-clear-recent]")?.addEventListener("click", () => {
    clearJourneyRecentPlaces();
    renderJourneySuggestions();
  });
  box.querySelector("[data-journey-location]")?.addEventListener("click", useJourneyLocation);
  box.querySelector("[data-journey-search-retry]")?.addEventListener("click", () => scheduleJourneySearch(field, query));
  box.querySelector("[data-journey-close]")?.addEventListener("click", closeJourneySuggestions);
}

function selectJourneyPlace(field, index) {
  const place = state.journey.places[index];
  if (!place) return;
  selectJourneyPlaceValue(field, place);
}

function selectJourneyRecentPlace(field, index) {
  const place = journeyRecentPlaces()[index];
  if (!place) return;
  selectJourneyPlaceValue(field, place);
}

function selectJourneyPlaceValue(field, place) {
  const j = state.journey;
  cancelJourneyPlaceRequest();
  j.searchSeq += 1;
  j.searchLoading = false;
  j.searchError = null;
  j.places = [];
  j.placesField = null;
  j.placesQuery = "";
  j.activeField = null;
  if (field === "origin") {
    j.origin = place;
    j.originQuery = place.name;
    j.originCleared = false;
  } else {
    j.destination = place;
    j.destinationQuery = place.name;
  }
  rememberJourneyPlace(place);
  resetJourneyRoutes();
  renderJourney();
}

function useJourneyLocation() {
  const j = state.journey;
  if (!state.location) {
    cancelJourneyPlaceRequest();
    j.searchSeq += 1;
    j.activeField = null;
    j.searchLoading = false;
    j.searchError = null;
    j.places = [];
    j.placesField = null;
    j.placesQuery = "";
    renderJourneySuggestions();
    askLocation({
      onSuccess: () => {
        const planner = state.journey;
        planner.origin = journeyLocationPlace();
        planner.originQuery = t("Konumunuz", "Your location");
        planner.originCleared = false;
        resetJourneyRoutes();
      },
    });
    return;
  }
  cancelJourneyPlaceRequest();
  j.searchSeq += 1;
  j.activeField = null;
  j.searchLoading = false;
  j.searchError = null;
  j.places = [];
  j.placesField = null;
  j.placesQuery = "";
  j.origin = journeyLocationPlace();
  j.originQuery = t("Konumunuz", "Your location");
  j.originCleared = false;
  resetJourneyRoutes();
  renderJourney();
}

function renderJourneyTimeline(route) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  let previousTransit = null;
  return legs
    .map((leg, index) => {
      const total = legs.length;
      const mode = journeyModeKey(leg.mode);
      const isWalk = leg.kind === "walk" || mode === "walking";
      const nextTransit = legs.slice(index + 1).find((item) => item.kind === "transit") || null;
      const transferWalk = isWalk && previousTransit && nextTransit;
      const fromName = journeyLegEndpoint(leg, "from", index, total);
      const toName = journeyLegEndpoint(leg, "to", index, total);
      const duration = journeyDurationText(leg.durationMin);
      const walkMeters = Number(leg.walkDistance) || 0;
      const distance = walkMeters > 0 ? distanceText(walkMeters) : "";

      if (isWalk) {
        return `<li class="journey-step journey-step-walk${transferWalk ? " journey-step-transfer" : ""}">
          <span class="journey-step-marker">${transferWalk ? "↔" : "🚶"}</span>
          <div class="journey-step-body">
            <div class="journey-step-top">
              <strong>${transferWalk ? t("Aktarma yürüyüşü", "Transfer walk") : t("Yürüyüş", "Walk")}</strong>
              <span class="journey-step-time">${duration}${distance ? ` · ${distance}` : ""}</span>
            </div>
            <div class="journey-step-meta">${esc(fromName)} → ${esc(toName)}</div>
          </div>
        </li>`;
      }

      const meta = journeyModeMeta(leg.mode);
      const transferPoint = t(
        fromName === "Biniş noktası" || fromName === "Aktarma noktası" ? "Aktarma noktası" : `${fromName} noktasında`,
        fromName === "Boarding point" || fromName === "Transfer point" ? "Transfer point" : `at ${fromName}`
      );
      const transfer = previousTransit
        ? `<div class="journey-transfer-note"><span>${t("Aktarma", "Transfer")}</span> ${esc(transferPoint)}</div>`
        : "";
      const detail = [meta.label, duration].filter(Boolean).join(" · ");
      previousTransit = leg;
      return `<li class="journey-step journey-step-transit">
        <span class="journey-step-marker">${meta.icon}</span>
        <div class="journey-step-body">
          ${transfer}
          <div class="journey-step-top">
            <div class="journey-step-title">${journeyLineBadge(leg)}<strong>${esc(journeyLegTitle(leg))}</strong></div>
            <span class="journey-step-time">${leg.estimated ? journeyDurationText(leg.durationMin) : `${journeyClock(leg.departureTime)} → ${journeyClock(leg.arrivalTime)}`}</span>
          </div>
          <div class="journey-step-meta">${esc(detail)}</div>
          <div class="journey-board">
            <div class="journey-board-row"><span class="journey-board-label">${t("Bin", "Board")}</span><span class="grow">${esc(fromName)}</span><span class="journey-board-clock">${journeyClock(leg.departureTime)}</span></div>
            <div class="journey-board-row"><span class="journey-board-label in">${t("İn", "Exit")}</span><span class="grow">${esc(toName)}</span><span class="journey-board-clock">${journeyClock(leg.arrivalTime)}</span></div>
          </div>
        </div>
      </li>`;
    })
    .join("");
}

function journeyRouteTags(route) {
  const routes = state.journey.routes || [];
  if (routes.length < 2) return [];
  const durations = routes.map(journeyRouteDuration).filter(Boolean);
  const fastest = durations.length ? Math.min(...durations) : 0;
  const fewestTransfers = Math.min(...routes.map((item) => Number(item.transfers) || 0));
  const tags = [];
  if (fastest && journeyRouteDuration(route) === fastest) tags.push(t("En hızlı", "Fastest"));
  if ((Number(route.transfers) || 0) === fewestTransfers) tags.push(t("En az aktarma", "Fewest transfers"));
  return tags;
}

function journeyRouteDisruptions(route) {
  const codes = [...new Set(
    (route?.legs || [])
      .filter((leg) => leg.kind === "transit" && leg.lineId)
      .map((leg) => String(leg.lineId).toLocaleUpperCase("tr"))
  )];
  return codes.flatMap((code) => {
    const status = state.statuses.get(code);
    return status?.active ? [{ code, desc: status.desc || "" }] : [];
  });
}

function journeyRailFacilities(route) {
  const stations = [];
  const seen = new Set();
  for (const leg of route?.legs || []) {
    if (leg?.kind !== "transit") continue;
    const code = String(leg.lineId || leg.line?.id || leg.routeId || "").toLocaleUpperCase("tr");
    if (!state.lines.has(code)) continue;
    const mode = journeyModeKey(leg.mode || state.lines.get(code)?.mode || "");
    const lineMode = String(state.lines.get(code)?.mode || "").toLocaleLowerCase("tr");
    if (!/metro|tram|rail|train|subway|funicular|marmaray|light.?rail/.test(`${mode} ${lineMode} ${code}`)) continue;
    for (const endpoint of [leg.from, leg.to]) {
      const name = String(endpoint?.name || "").trim();
      if (!name) continue;
      const key = `${code}:${norm(name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const station = state.stations.find((item) => item.code === code && norm(item.name) === norm(name))
        || state.stations.find((item) => item.code === code && (norm(item.name).includes(norm(name)) || norm(name).includes(norm(item.name))));
      if (station?.info) stations.push({ code, name: station.name, info: station.info });
    }
  }
  return stations;
}

function journeyMetroAlertLink(route) {
  const codes = [...new Set((route?.legs || [])
    .filter((leg) => leg?.kind === "transit")
    .map((leg) => String(leg.lineId || leg.line?.id || leg.routeId || "").toLocaleUpperCase("tr"))
    .filter((code) => state.lines.has(code) && /^(M|T|F|TF|B2|B1)/.test(code)))];
  if (!codes.length) return "";
  return `<div class="card journey-metro-alert-link">
    <strong>⚠️ ${t("Raylı sistem işletme uyarıları", "Rail service alerts")}</strong>
    <p class="muted">${t("Rotandaki hatlar", "Lines on your route")}: ${codes.map((code) => esc(code)).join(", ")}. ${t("Güncel sefer aksaması ve istasyon ekipmanı uyarılarını resmî kaynaktan kontrol et.", "Check current service disruptions and station equipment alerts at the official source.")}</p>
    <a class="dirchip journey-alert-source" href="https://www.metro.istanbul/SeferDurumlari/Ariza/1" target="_blank" rel="noopener noreferrer">${t("Resmî uyarıları aç ↗", "Open official alerts ↗")}</a>
  </div>`;
}

function journeyRailFacilitiesCard(route) {
  const stations = journeyRailFacilities(route);
  if (!stations.length) return "";
  const items = stations.map(({ code, name, info }) => {
    const facilities = [];
    if (info.Lift != null && Number.isFinite(Number(info.Lift))) facilities.push(`${t("Asansör", "Elevators")}: ${Number(info.Lift)}`);
    const escalators = info.Escolator ?? info.Escalator;
    if (escalators != null && Number.isFinite(Number(escalators))) facilities.push(`${t("Yürüyen merdiven", "Escalators")}: ${Number(escalators)}`);
    if (typeof info.WC === "boolean") facilities.push(`${t("WC", "Restroom")}: ${info.WC ? t("var", "available") : t("yok", "not listed")}`);
    return { badge: code, color: lineColor(code), title: name, body: facilities.join(" · ") || t("Tesis bilgisi sınırlı.", "Facility details are limited.") };
  });
  return announcementCard(t("Güzergâhtaki istasyon bilgileri", "Facilities at stations on your route"), items, {
    className: "journey-facilities",
    footer: t("Bu bilgiler istasyon veri kaydındaki tesis sayılarını gösterir; asansör/yürüyen merdivenlerin anlık çalışır durumda olduğunu belirtmez. Canlı metro işletme uyarıları ayrı gösterilir.", "These are facility counts from the station dataset; they do not indicate whether lifts or escalators are currently working. Live metro service alerts are shown separately.")
  });
}

function renderJourneyResults() {
  const box = $("#journeyResults");
  if (!box) return;
  updateJourneyPlanButton();
  const j = state.journey;
  if (!j.origin || !j.destination) {
    box.innerHTML = "";
    return;
  }
  if (j.routesMeta?.engine === "ibb-tubs") {
    box.innerHTML = `<div class="card journey-result-card">
      <div class="journey-result-head">
        <div class="grow">
          <span class="journey-plan-tag">${t("İBB Toplu Ulaşım Bilgi Sistemi", "IMM Public Transit Information System")}</span>
          <h2>${t("Toplu taşıma rotası", "Public transit route")}</h2>
          <p class="muted">${esc(j.origin.name)} → ${esc(j.destination.name)}</p>
        </div>
      </div>
      <p class="journey-note">${t("Rota İBB Şehir Haritası üzerinde gösterilir. TUBS API rota adımlarını uygulamaya JSON olarak döndürmediği için harita ve güzergâh İBB bileşeninde görüntülenir.", "The route is displayed on the IMM City Map. TUBS does not return route steps as JSON to this app, so the map and directions are shown in the IMM component.")}</p>
      <div id="ibbJourneyMapStatus" class="muted">${t("İBB haritası yükleniyor…", "Loading IMM map…")}</div>
      <div class="ibb-journey-map-wrap"><iframe id="ibbJourneyMapFrame" title="${t("İBB toplu taşıma rotası", "IMM public transit route")}" src="https://sehirharitasiapi.ibb.gov.tr/" loading="lazy" allow="geolocation *"></iframe></div>
    </div>`;
    renderIbbJourneyMap();
    return;
  }
  if (j.routesLoading) {
    box.innerHTML = `<div class="card journey-loading">
      <div class="live-head"><div><strong>${t("Yolculuk planlanıyor", "Planning your trip")}</strong><p class="muted">${t("Resmî İETT rota planlayıcısı hazırlanıyor…", "Preparing the official IETT journey planner…")}</p></div><span class="pulse"></span></div>
      <div class="skeleton" style="height:50px;margin-top:14px"></div>
      <div class="skeleton" style="height:80px;margin-top:8px"></div>
    </div>`;
    return;
  }
  if (j.routesError) {
    box.innerHTML = `<div class="card journey-error">
      <strong>${t("Yolculuk planı alınamadı", "Could not get trip plan")}</strong>
      <p class="muted">${esc(j.routesError)}</p>
      <button class="dirchip" id="journeyRetry" type="button">↻ ${t("Tekrar dene", "Try again")}</button>
    </div>`;
    $("#journeyRetry")?.addEventListener("click", () => planJourney({ force: true }));
    return;
  }
  if (!j.routes.length) {
    const noDirectRoute = j.mode === "direct";
    box.innerHTML = `<div class="card journey-error">
      <strong>${t("Bu saat için rota bulunamadı", "No route found for this time")}</strong>
      <p class="muted">${noDirectRoute
        ? t("Bu saat için aktarmasız rota bulunamadı. Alternatifleri görmek için Karışık seçeneğini deneyin.", "No direct route was found for this time. Choose Mixed to see alternatives.")
        : t("İETT planlayıcısı bu başlangıç ve varış için bir yolculuk döndürmedi. Noktaları değiştirip tekrar deneyin.", "The İETT planner returned no trip for this origin and destination. Change the points and try again.")}</p>
      <button class="dirchip" id="journeyRetry" type="button">↻ ${t("Tekrar dene", "Try again")}</button>
    </div>`;
    $("#journeyRetry")?.addEventListener("click", () => planJourney({ force: true }));
    return;
  }

  const selected = Math.min(j.selected, j.routes.length - 1);
  const route = j.routes[selected];
  const duration = journeyRouteDuration(route);
  const fare = journeyFareText(route.totalFee);
  const walkMeters = Number(route.walkDistance) || 0;
  const walk = walkMeters > 0 ? distanceText(walkMeters) : "—";
  const meta = j.routesMeta || {};
  const planned = meta.plannedFor || {};
  const disruptions = journeyRouteDisruptions(route);
  const routeTags = journeyRouteTags(route);
  const options =
    j.routes.length > 1
      ? `<div class="journey-options" role="group" aria-label="${t("Yolculuk seçenekleri", "Trip options")}">
          ${j.routes
            .map((item, index) => {
              const tags = journeyRouteTags(item);
              return `<button class="journey-option ${index === selected ? "active" : ""}" type="button" data-journey-option="${index}" aria-pressed="${index === selected}">
                <span class="journey-option-duration">${journeyRouteDuration(item) ? `${journeyRouteDuration(item)} ${t("dk", "min")}` : "—"}</span>
                <span class="journey-option-time">${item.estimated ? t("Tahmini", "Estimated") : `${journeyClock(item.departureTime)} → ${journeyClock(item.arrivalTime)}`}</span>
                <span class="journey-option-meta">${journeyTransfersText(item.transfers)}${tags.length ? ` · ${tags.map((tag) => `<span class="journey-option-tag">${esc(tag)}</span>`).join(" ")}` : ""}</span>
              </button>`;
            })
            .join("")}
        </div>`
      : "";

  box.innerHTML = `
    ${options}
    <div class="card journey-result-card">
      <div class="journey-result-head">
        <div class="grow">
          <span class="journey-plan-tag">${route.source === "local-json" ? t("Yerel rota motoru · tahmini", "Local route engine · estimated") : t("Planlanan tarife", "Scheduled timetable")}</span>
          <h2>${route.source === "local-json" ? String(duration) + " " + t("dk tahmini", "min estimated") : `${journeyClock(route.departureTime)} → ${journeyClock(route.arrivalTime)}`}</h2>
          <p class="muted">${esc(j.origin.name)} → ${esc(j.destination.name)}</p>
          ${routeTags.length ? `<div class="journey-result-tags">${routeTags.map((tag) => `<span>${esc(tag)}</span>`).join("")}</div>` : ""}
        </div>
        <button class="dirchip" id="journeyRefresh" type="button" aria-label="${t("Yolculuk planını yenile", "Refresh trip plan")}">↻</button>
      </div>
      <div class="journey-summary">
        <div><span>${t("Süre", "Duration")}</span><strong>${duration ? `${duration} ${t("dk", "min")}` : "—"}</strong></div>
        <div><span>${t("Aktarma", "Transfers")}</span><strong>${journeyTransfersText(route.transfers)}</strong></div>
        <div><span>${t("Yürüyüş", "Walk")}</span><strong>${walk}</strong></div>
        ${fare ? `<div><span>${t("Tahmini ücret", "Estimated fare")}</span><strong>${esc(fare)}</strong></div>` : ""}
      </div>
      ${disruptions.length ? announcementCard(t("Canlı hat uyarısı", "Live line alert"), disruptions.map((item) => ({
        badge: item.code,
        color: "#d97706",
        title: shortText(item.desc, 150),
        body: item.desc,
      })), { className: "journey-alert" }) : ""}
      ${journeyMetroAlertLink(route)}\n      ${journeyRailFacilitiesCard(route)}\n      <ol class="journey-timeline">${renderJourneyTimeline(route)}</ol>
      <p class="journey-note">${route.source === "local-json" ? t("Yerel JSON ağından hesaplandı. Süreler tahminidir; yürüme mesafesi düz çizgi yaklaşımıdır ve gerçek yürüme rotası ya da aktarma erişilebilirliği garanti edilmez.", "Calculated from the local JSON network. Durations are estimates; walking distance is a straight-line approximation and actual walking paths or transfer accessibility are not guaranteed.") : t("Saatler İETT Nasıl Giderim’in planlanan tarifesine dayanır; canlı araç konumu değildir. Trafik, sefer ve işletme değişiklikleriyle farklılık gösterebilir.", "Times are based on the IETT Nasıl Giderim scheduled timetable; they are not live vehicle positions and may vary.")}${
        planned.time ? ` ${t("Sorgu saati", "Query time")}: ${esc(planned.time)}${planned.date ? ` · ${esc(planned.date)}` : ""}.` : ""
      }${meta.stale ? ` ${t("Son önbellek gösteriliyor.", "Showing the last cached result.")}` : ""}</p>
    </div>
  `;

  bindAnnouncementItems(box);
  box.querySelectorAll("[data-journey-option]").forEach((button) =>
    button.addEventListener("click", () => {
      state.journey.selected = Number(button.dataset.journeyOption);
      renderJourneyResults();
    })
  );
  const optionsBox = box.querySelector(".journey-options");
  const activeOption = optionsBox?.querySelector(".journey-option.active");
  if (optionsBox && activeOption) {
    const boxRect = optionsBox.getBoundingClientRect();
    const activeRect = activeOption.getBoundingClientRect();
    optionsBox.scrollLeft += activeRect.left - boxRect.left - (boxRect.width - activeRect.width) / 2;
  }
  $("#journeyRefresh")?.addEventListener("click", () => planJourney({ force: true }));
}

async function planJourney({ force = false } = {}) {
  const j = state.journey;
  if (!j.origin || !j.destination) {
    renderJourneyResults();
    return;
  }
  const key = journeyPairKey();
  if (!force && (j.routesLoading || (j.lastPlanKey === key && (j.routes.length || j.routesError)))) return;

  j.planSeq += 1;
  const seq = j.planSeq;
  j.lastPlanKey = key;
  j.routesLoading = true;
  j.routesError = null;
  j.routes = [];
  j.routesMeta = null;
  j.selected = 0;
  renderJourneyResults();

  try {
    const params = {
      type: "journey",
      from: journeyPointParam(j.origin),
      to: journeyPointParam(j.destination),
    };
    const planned = journeyPlannedFor();
    if (planned) {
      params.date = planned.date;
      params.time = planned.time;
    }
    const data = await fetchBusApi(params, { timeout: 14000 });
    if (seq !== j.planSeq) return;
    j.routes = (Array.isArray(data.routes) ? data.routes : []).filter((route) => journeyRouteMatchesMode(route));
    if (j.mode === "fastest") j.routes.sort((a, b) => journeyRouteDuration(a) - journeyRouteDuration(b));
    j.routesMeta = data;
  } catch {
    if (seq !== j.planSeq) return;
    j.routes = [];
    j.routesError = t("İETT yolculuk servisi yanıt vermedi. Tarife dosyası yüklenemedi. Bağlantıyı kontrol edip tekrar deneyin.", "The İETT trip service did not respond. The timetable file could not be loaded. Check your connection and try again.");
  } finally {
    if (seq === j.planSeq) {
      j.routesLoading = false;
      renderJourneyResults();
    }
  }
}

function askLocation({ onSuccess, onError } = {}) {
  if (!navigator.geolocation) {
    onError?.();
    toast(t("Bu cihaz konum desteklemiyor.", "This device does not support location."));
    render();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      localStorage.setItem("sm.loc", JSON.stringify(state.location));
      onSuccess?.();
      render();
    },
    () => {
      onError?.();
      toast(t("Konum izni verilmedi.", "Location permission was not granted."));
      render();
    },
    { maximumAge: 60000, timeout: 8000 }
  );
}

function toggleFav(key, { silent = false } = {}) {
  if (!key) return;
  state.favorites.has(key) ? state.favorites.delete(key) : state.favorites.add(key);
  localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
  toast(state.favorites.has(key) ? t("Favorilere eklendi ★", "Added to favorites ★") : t("Favorilerden çıkarıldı", "Removed from favorites"));
  if (!silent) render();
}

/* --- istasyon görünümü --- */
function renderStation(key, lineCode) {
  const s = state.stationIndex.get(key);
  if (!s) return renderNotFound();
  const activeLine = s.entries.find((e) => e.code === lineCode) || s.entries[0];
  if (activeLine.dirs.length > 1) activeLine.sel = Math.min(state.metroLineDirections[activeLine.code] || 0, activeLine.dirs.length - 1);
  const now = new Date();
  const fav = state.favorites.has(s.key);
  const status = state.statuses.get(activeLine.code);

  const dirIdx = Math.min(+(activeLine.sel ?? 0), activeLine.dirs.length - 1);
  const dir = activeLine.dirs[dirIdx];
  const nextDirIdx = activeLine.dirs.length > 1 ? (dirIdx + 1) % activeLine.dirs.length : dirIdx;
  const deps = dir ? nextDepartures(dir.times, 6, now) : [];

  view.innerHTML = `
    <div class="card">
      <div class="row between">
        <div class="grow">
          <h2>${esc(s.name)}</h2>
          <div class="meta" style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">${s.lines.map((c) => badge(c)).join("")}</div>
        </div>
        <button class="fav-btn ${fav ? "on" : ""}" id="fav2" aria-label="${t("Favori", "Favorite")}">${fav ? "★" : "☆"}</button>
      </div>
    </div>

    ${
      s.entries.length > 1
        ? `<div class="dirwrap">${s.entries.map((e) => `<button class="dirchip ${e.code === activeLine.code ? "active" : ""}" data-line="${esc(e.code)}">${badge(e.code)}</button>`).join("")}</div>`
        : ""
    }

    ${
      status?.active
        ? announcementCard(t("Metro Uyarıları", "Metro alerts"), [
            {
              badge: activeLine.code,
              color: state.lines.get(activeLine.code)?.color || "#888",
              title: shortText(status.desc || t("Aksama bildirildi.", "Service disruption reported.")),
              body: status.desc || t("Aksama bildirildi.", "Service disruption reported."),
            },
          ])
        : ""
    }

    <div class="card">
      <div class="row between">
        <div><strong>${esc(activeLine.code)} · ${t("sıradaki seferler", "next departures")}</strong>
          <p class="muted">${t(`${dayName(now)} tarifesi`, `${dayName(now)} timetable`)} · ${dir ? esc(dir.from) + " → " + esc(dir.to) : ""}</p>
        </div>
        ${deps[0] ? `<span class="pulse" title="${t("canlı tarife", "live timetable")}"></span>` : ""}
      </div>
      ${activeLine.dirs.length > 1
        ? `<button type="button" class="schedule-direction-toggle" data-dir="${nextDirIdx}" aria-label="${t(`${esc(activeLine.dirs[nextDirIdx].to)} yönünü göster`, `Show direction to ${esc(activeLine.dirs[nextDirIdx].to)}`)}">
            <span class="schedule-direction-current">${esc(dir.from)} → ${esc(dir.to)}</span>
            <span class="schedule-direction-action" aria-hidden="true">↔ ${t("Yönü değiştir", "Switch direction")}</span>
          </button>`
        : `<div class="schedule-direction-current schedule-direction-only">${esc(dir?.from || "")} → ${esc(dir?.to || "")}</div>`}
      ${deps.length
        ? deps
            .map((d) => {
              const m = minutesTo(d.when, now);
              const cls = m <= 0 ? "now" : m <= 5 ? "soon" : "";
              return `<div class="dep ${cls}"><div class="when">${m <= 0 ? t("Kalkış", "Departing") : `${m} ${t("dk", "min")}`}</div>
                <div class="grow"></div><div class="hhmm">${esc(d.hhmm)}</div></div>`;
            })
            .join("")
        : `<div class="empty">${t("Bu yönde bugün için kalan sefer görünmüyor.", "No remaining departures in this direction today.")}</div>`}
      <p class="muted" style="margin-top:10px">${t("Saatler resmî sefer tarifesine göredir; istasyon içi duyurulara dikkat edin.", "Times are based on the official timetable; pay attention to in-station announcements.")}</p>
    </div>

    ${
      s.entries.length > 1
        ? `<div class="section-title">${t("Bu istasyondaki hatlar", "Lines at this station")}</div><div class="card">${s.entries
            .map((e) => {
              const firstDep = e.dirs[0] ? nextDepartures(e.dirs[0].times, 1, now)[0] : null;
              return `<div class="station-row"><div class="badges">${badge(e.code)}</div><div class="grow"><div class="name" style="font-size:14.5px">${esc(e.code)} · ${esc(e.dirs[0]?.to ? e.dirs[0].to + " " + t("yönü", "direction") : "")}</div>
              <div class="meta">${firstDep ? `${t("Sıradaki", "Next")}: ${minutesTo(firstDep.when, now) <= 0 ? t("kalkış", "departing") : minutesTo(firstDep.when, now) + " " + t("dk", "min")} (${esc(firstDep.hhmm)})` : t("Sefer yok", "No departures")}</div></div>
              <button class="dirchip" data-line2="${esc(e.code)}">${t("Aç", "Open")}</button></div>`;
            })
            .join("")}</div>`
        : ""
    }
  `;

  bindAnnouncementItems(view);
  $("#fav2")?.addEventListener("click", () => toggleFav(s.key));
  view.querySelectorAll("[data-line]").forEach((el) =>
    el.addEventListener("click", () => renderStation(key, el.dataset.line))
  );
  view.querySelectorAll("[data-line2]").forEach((el) =>
    el.addEventListener("click", () => renderStation(key, el.dataset.line2))
  );
  view.querySelectorAll("[data-dir]").forEach((el) =>
    el.addEventListener("click", () => {
      activeLine.sel = +el.dataset.dir;
      state.metroLineDirections[activeLine.code] = activeLine.sel;
      renderStation(key, activeLine.code);
    })
  );
}

/* --- hat görünümü --- */
function renderLine(code) {
  const line = state.lines.get(code);
  const entry = state.timetable?.[code];
  if (!line || !entry) return renderNotFound();
  const stations = state.stations.filter((s) => s.code === code).sort((a, b) => (a.order || 0) - (b.order || 0));
  const direction = state.metroLineDirections[code] ? 1 : 0;
  const displayedStations = direction ? [...stations].reverse() : stations;
  const directionFrom = displayedStations[0]?.name || "";
  const directionTo = displayedStations.at(-1)?.name || "";
  const st = state.statuses.get(code);
  const near = nearestStopInfo(stations, { maxDistance: METRO_NEARBY_RADIUS_M });
  const displayedNearestIndex = near.index < 0 ? -1 : direction ? stations.length - 1 - near.index : near.index;
  view.innerHTML = `
    <div class="card">
      <div class="row"><div class="badges">${badge(code)}</div><div class="grow"><h2>${esc(line.name)}</h2>
      <p class="muted">${esc(line.first || "")} – ${esc(line.last || "")}</p>
      <p class="muted" style="margin-top:4px">${t("Metro tarife tarihi", "Metro timetable date")}: ${state.generatedAt ? esc(fmtDate(state.generatedAt)) : "—"}</p></div></div>
      ${!st || !st.active ? `<p class="muted" style="margin-top:8px">${st ? `✅ ${t("Normal işletme", "Normal service")} · ${fmtDate(st.updated)}` : ""}</p>` : ""}
    </div>
    ${
      st?.active
        ? announcementCard(t("Metro Uyarıları", "Metro alerts"), [
            {
              badge: code,
              color: line.color,
              title: shortText(st.desc || t("Aksama bildirildi.", "Service disruption reported.")),
              body: st.desc || t("Aksama bildirildi.", "Service disruption reported."),
            },
          ])
        : ""
    }
    ${stations.length > 1 ? `<button type="button" class="schedule-direction-toggle metro-line-direction-toggle" id="metroLineDirection" aria-label="${t("Metro yönünü değiştir", "Switch metro direction")}">
      <span class="schedule-direction-current">${esc(directionFrom)} → ${esc(directionTo)}</span>
      <span class="schedule-direction-action" aria-hidden="true">↔ ${t("Yönü değiştir", "Switch direction")}</span>
    </button>` : ""}
    <div class="card" id="lineStations">
      ${lineLocationPrompt()}
      ${displayedStations
        .map(
          (s, i) => `
        <div class="station-row${i === displayedNearestIndex ? " nearest-stop" : ""}" data-station="${esc(norm(s.name))}" role="button" tabindex="0">
          <div class="grow"><div class="name">${esc(s.name)}${i === displayedNearestIndex ? ` ${nearestStopLabel(near)}` : ""}</div></div><div class="go">›</div>
        </div>`
        )
        .join("")}
    </div>`;
  bindAnnouncementItems(view);
  bindLineLocationPrompt();
  $("#metroLineDirection")?.addEventListener("click", () => {
    state.metroLineDirections[code] = direction ? 0 : 1;
    renderLine(code);
  });
  view.querySelectorAll("[data-station]").forEach((el) =>
    el.addEventListener("click", () => go(`#/istasyon/${el.dataset.station}?hat=${code}`))
  );
}

/* --- otobüs görünümleri --- */
function bindBusSearch({ inputId, boxId, announcementsId, extrasId, mode, lineLabel, stopLabel, stopsOnly = false }) {
  const input = $(inputId);
  if (!input) return;
  const run = () => {
    const raw = input.value;
    const q = norm(raw);
    const searching = !!q;
    $(announcementsId)?.toggleAttribute("hidden", searching);
    $(extrasId)?.toggleAttribute("hidden", searching);
    const box = $(boxId);
    if (!box) return;
    if (!q) {
      box.innerHTML = "";
      return;
    }
    const { lines, stops } = busSearch(q, { mode });
    const shownStops = stopsOnly
      ? [...new Map(stops.map((stop) => {
          const group = state.bus.metrobusStopGroupByCode.get(Number(stop.code)) || stop;
          return [norm(group.name), group];
        })).values()]
          .filter((stop) => metrobusStopOrder(stop))
          .sort((a, b) => (metrobusStopOrder(a).index - metrobusStopOrder(b).index) * (state.bus.metrobusListReverse ? -1 : 1))
      : stops;
    const sections = [];
    if (lines.length && !stopsOnly) {
      sections.push(`<div class="section-title">${esc(lineLabel)}</div><div class="card">${lines.map(busLineRow).join("")}</div>`);
    }
    if (shownStops.length) {
      sections.push(`<div class="section-title">${esc(stopLabel)}</div><div class="card">${shownStops.map(stopsOnly ? metrobusStopRow : busStopRow).join("")}</div>`);
    }
    box.innerHTML = sections.length
      ? sections.join("")
      : `<div class="empty">${t(
          `"${esc(raw)}" için ${stopsOnly ? "metrobüs durağı" : mode === "metrobus" ? "metrobüs hattı veya durağı" : "hat veya durak"} bulunamadı.`,
          `No ${stopsOnly ? "metrobus stop" : mode === "metrobus" ? "metrobus line or stop" : "line or stop"} found for "${esc(raw)}".`
        )}</div>`;
    bindBusRows(box, run, { mode });
  };
  input.addEventListener("input", run);
}

function renderBusHome() {
  if (!state.bus.loaded) {
    view.innerHTML = state.bus.error
      ? `<div class="empty">${t("Otobüs verisi yüklenemedi.", "Could not load bus data.")}<br><button class="dirchip" id="busReload">↻ ${t("Tekrar dene", "Try again")}</button></div>`
      : `<div class="empty">${t("Otobüs hatları yükleniyor…", "Loading bus lines…")}</div>`;
    $("#busReload")?.addEventListener("click", () => location.reload());
    return;
  }

  const favs = [...state.busFavs]
    .map((code) => state.bus.stopIndex.get(Number(code)))
    .filter((stop) => stop && !isMetrobusStop(stop));
  const announcements = modeAnnouncements("bus").map((item) => ({
    announcementId: item.id,
    title: item.title,
    date: item.date,
  }));

  view.innerHTML = `
    ${announcementCard(t("Otobüs Uyarıları", "Bus alerts"), announcements, { id: "busAnnouncements" })}
    <div class="searchbox mode-search">
      <input id="busQ" type="search" placeholder="${t("Hat veya durak ara", "Search line or stop")}" autocomplete="off" />
      <svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2m0 2a6 6 0 1 1 0 12a6 6 0 0 1 0-12"/></svg>
    </div>
    <div id="busResults"></div>

    <div id="busExtras">
      ${nearbyBusSection()}
      ${favs.length ? `<div class="section-title">${t("Favori duraklarım", "My favorite stops")}</div><div class="card">${favs.map(busStopRow).join("")}</div>` : ""}
      <div class="footer-note">${t("Canlı varışlar İETT durak panosundan alınır · trafiğe göre değişebilir", "Live arrivals come from the İETT stop board · may vary with traffic")}</div>
    </div>
  `;

  bindAnnouncementItems(view);
  $("#busNearbyLoc")?.addEventListener("click", askLocation);
  bindBusSearch({
    inputId: "#busQ",
    boxId: "#busResults",
    announcementsId: "#busAnnouncements",
    extrasId: "#busExtras",
    mode: "bus",
    lineLabel: t("Otobüs hatları", "Bus lines"),
    stopLabel: t("Otobüs durakları", "Bus stops"),
  });
  bindBusRows(view, () => render(), { mode: "bus" });
}

function renderMetrobusHome() {
  if (!state.bus.loaded) {
    view.innerHTML = state.bus.error
      ? `<div class="empty">${t("Metrobüs verisi yüklenemedi.", "Could not load metrobus data.")}<br><button class="dirchip" id="metrobusReload">↻ ${t("Tekrar dene", "Try again")}</button></div>`
      : `<div class="empty">${t("Metrobüs hatları yükleniyor…", "Loading metrobus lines…")}</div>`;
    $("#metrobusReload")?.addEventListener("click", () => location.reload());
    return;
  }

  const favs = [...state.busFavs]
    .map((code) => state.bus.stopIndex.get(Number(code)))
    .filter((stop) => stop && isMetrobusStop(stop) && metrobusStopOrder(stop))
    .map((stop) => state.bus.metrobusStopGroupByCode.get(Number(stop.code)) || stop)
    .filter((stop, index, list) => list.findIndex((item) => norm(item.name) === norm(stop.name)) === index)
    .sort((a, b) => (metrobusStopOrder(a).index - metrobusStopOrder(b).index) * (state.bus.metrobusListReverse ? -1 : 1));
  const allStops = [...new Set(state.bus.metrobusStopGroupByCode.values())]
    .filter((stop) => metrobusStopOrder(stop))
    .sort((a, b) => metrobusStopOrder(a).index - metrobusStopOrder(b).index);
  if (state.bus.metrobusListReverse) allStops.reverse();
  const currentDirection = state.bus.metrobusListReverse
    ? "SÖĞÜTLÜÇEŞME → BEYLİKDÜZÜ SONDURAK"
    : "BEYLİKDÜZÜ SONDURAK → SÖĞÜTLÜÇEŞME";
  const nextDirection = state.bus.metrobusListReverse
    ? "BEYLİKDÜZÜ SONDURAK → SÖĞÜTLÜÇEŞME"
    : "SÖĞÜTLÜÇEŞME → BEYLİKDÜZÜ SONDURAK";
  const announcements = modeAnnouncements("metrobus").map((item) => ({
    announcementId: item.id,
    title: item.title,
    date: item.date,
  }));

  view.innerHTML = `
    ${announcementCard(t("Metrobüs Uyarıları", "Metrobus alerts"), announcements, { id: "metrobusAnnouncements" })}

    <div class="searchbox mode-search">
      <input id="metrobusQ" type="search" placeholder="${t("Metrobüs durağı ara", "Search metrobus stops")}" autocomplete="off" />
      <svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2m0 2a6 6 0 1 1 0 12a6 6 0 0 1 0-12"/></svg>
    </div>
    <div id="metrobusResults"></div>

    <div id="metrobusExtras">
      ${nearbyMetrobusStopsSection()}
      ${favs.length ? `<div class="section-title">${t("Favori metrobüs duraklarım", "My favorite metrobus stops")}</div><div class="card">${favs.map((stop) => metrobusStopRow(stop, { showFavoriteStar: true })).join("")}</div>` : ""}

      <div class="section-title">${t("Tüm metrobüs durakları", "All metrobus stops")} · ${allStops.length}</div>
      <button type="button" class="schedule-direction-toggle metrobus-list-direction-toggle" id="metrobusListDirection" aria-label="${t(`${nextDirection} yönünü göster`, `Show ${nextDirection} direction`)}">
        <span class="schedule-direction-current">${currentDirection}</span>
        <span class="schedule-direction-action" aria-hidden="true">↔ ${t("Yönü değiştir", "Switch direction")}</span>
      </button>
      <div class="card">${allStops.map(metrobusStopRow).join("") || `<div class="muted">${t("Metrobüs durağı bulunamadı.", "No metrobus stops found.")}</div>`}</div>

      <div class="footer-note">${t("Canlı varışlar İETT durak panosundan alınır · trafiğe göre değişebilir", "Live arrivals come from the İETT stop board · may vary with traffic")}</div>
    </div>
  `;

  bindAnnouncementItems(view);
  $("#metrobusNearbyLoc")?.addEventListener("click", askLocation);
  $("#metrobusListDirection")?.addEventListener("click", () => {
    state.bus.metrobusListReverse = !state.bus.metrobusListReverse;
    renderMetrobusHome();
  });
  bindBusSearch({
    inputId: "#metrobusQ",
    boxId: "#metrobusResults",
    announcementsId: "#metrobusAnnouncements",
    extrasId: "#metrobusExtras",
    mode: "metrobus",
    lineLabel: "",
    stopLabel: t("Metrobüs durakları", "Metrobus stops"),
    stopsOnly: true,
  });
  bindBusRows(view, () => render(), { mode: "metrobus" });
}

function renderBusStop(code) {
  if (!state.bus.loaded) {
    if (state.bus.error) view.innerHTML = `<div class="empty">${t("Otobüs verisi yüklenemedi.", "Could not load bus data.")}<br><button class="dirchip" onclick="location.reload()">↻ ${t("Tekrar dene", "Try again")}</button></div>`;
    else renderLoading(t("Otobüs verisi yükleniyor…", "Loading bus data…"));
    return;
  }
  const key = Number(code);
  const stop = state.bus.stopIndex.get(key);
  if (!stop) return renderNotFound();
  const stopCodes = state.route.codes?.length ? state.route.codes : [key];
  const cacheKey = `stop:${[...stopCodes].sort((a, b) => a - b).join(",")}`;
  if (state.busStopFocus?.key !== key) state.busStopFocus = null;
  const fav = state.busFavs.has(key);
  const isMetrobus = state.route.mode === "metrobus" || isMetrobusStop(stop);
  const mbLines = isMetrobus ? metrobusStopLines(stop) : [];
  const requested =
    state.busStopFocus?.key === key && state.busStopFocus.line
      ? String(state.busStopFocus.line).toLocaleUpperCase("tr")
      : state.route.mode === "metrobus" && state.route.line
        ? String(state.route.line).toLocaleUpperCase("tr")
        : null;
  const focusLine = isMetrobus
    ? mbLines.find((entry) => entry.code.toLocaleUpperCase("tr") === requested)?.code || mbLines.find((entry) => entry.code === "34G")?.code || mbLines[0]?.code || null
    : null;

  if (isMetrobus) {
    view.innerHTML = `
      <div class="card">
        <div class="row between">
          <div class="grow">
            <h2>${esc(stop.name)}</h2>
            <div class="meta" style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">${mbLines.map((entry) => busBadge(entry.code)).join("")}</div>
            <div class="meta" style="margin-top:4px">${[stop.district, stopCodes.length > 1 ? t("İki yön", "Both directions") : stop.direction ? `${stop.direction} ${t("yönü", "direction")}` : "", `${t("Durak", "Stop")} ${stop.code}`]
              .filter(Boolean)
              .map(esc)
              .join(" · ")}</div>
          </div>
          <button class="fav-btn ${fav ? "on" : ""}" id="busFav2" aria-label="${t("Favori", "Favorite")}">${fav ? "★" : "☆"}</button>
        </div>
      </div>

      ${
        mbLines.length > 1
          ? `<div class="dirwrap">${mbLines
              .map(
                (entry) =>
                  `<button class="dirchip ${entry.code === focusLine ? "active" : ""}" data-mb-focus="${esc(entry.code)}">${busBadge(entry.code)}</button>`
              )
              .join("")}</div>`
          : ""
      }

      <div class="card" id="busLive">
        <div class="live-head"><div><strong>${esc(focusLine || t("Metrobüs", "Metrobus"))} · ${t("sıradaki seferler", "next departures")}</strong><p class="muted">${t("Metrobüs · canlı varış", "Metrobus · live arrivals")}</p></div><span class="pulse"></span></div>
        <div class="skeleton" style="height:44px;margin-top:12px"></div>
        <div class="skeleton" style="height:44px;margin-top:8px"></div>
      </div>

      <div class="section-title">${t("Bu duraktaki hatlar", "Lines at this stop")}</div>
      <div class="card">
        ${mbLines
          .map(
            (entry) => `<div class="station-row">
              <div class="badges">${busBadge(entry.code)}</div>
              <div class="grow">
                <div class="name" style="font-size:14.5px">${esc(entry.code)} · ${esc(entry.dirs[0]?.to ? entry.dirs[0].to + " " + t("yönü", "direction") : t("Metrobüs", "Metrobus"))}</div>
                <div class="meta" data-mb-next="${esc(entry.code)}">${t("Canlı varış yükleniyor…", "Loading live arrivals…")}</div>
              </div>
              <button class="dirchip" data-mb-focus="${esc(entry.code)}">${t("Aç", "Open")}</button>
            </div>`
          )
          .join("")}
      </div>
    `;
  } else {
    view.innerHTML = `
      <div class="card">
        <div class="row between">
          <div class="row" style="gap:10px;min-width:0">
            ${busStopIcon()}
            <div class="grow">
              <h2>${esc(stop.name)}</h2>
              <div class="meta" style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
                ${stop.district ? `<span>${esc(stop.district)}</span>` : ""}
                ${stop.direction ? `<span>·</span><span>${esc(stop.direction)} ${t("yönü", "direction")}</span>` : ""}
                <span>·</span><span>${t("Durak", "Stop")} ${stop.code}</span>
              </div>
            </div>
          </div>
          <button class="fav-btn ${fav ? "on" : ""}" id="busFav2" aria-label="${t("Favori", "Favorite")}">${fav ? "★" : "☆"}</button>
        </div>
      </div>

      <div id="busStopAnnouncements"></div>

      <div class="card" id="busLive">
        <div class="live-head"><div><strong>${t("Bu duraktan geçen otobüsler", "Buses passing this stop")}</strong><p class="muted">${t("Canlı varış süreleri", "Live arrival times")}</p></div><span class="pulse"></span></div>
        <div class="skeleton" style="height:44px;margin-top:12px"></div>
        <div class="skeleton" style="height:44px;margin-top:8px"></div>
      </div>
    `;
  }

  $("#busFav2")?.addEventListener("click", () => toggleBusFav(key));
  view.querySelectorAll("[data-mb-focus]").forEach((el) =>
    el.addEventListener("click", () => {
      state.busStopFocus = { key, line: el.dataset.mbFocus };
      renderBusStop(key);
    })
  );

  const hit = state.busCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 15000) renderStopBoard(hit.data);
  else refreshBusStop(stopCodes, { silent: false });
}

async function fetchLineStopsCached(code) {
  const key = `line:${code}`;
  const hit = state.busCache.get(key);
  if (hit) return hit.data;
  const line = state.bus.lineIndex.get(code);
  const bundled = state.bus.lineStops?.[code];
  if (bundled && isMetrobusLine(line)) {
    state.busCache.set(key, { at: Date.now(), data: bundled });
    return bundled;
  }
  const data = await fetchBusApi({ type: "line", code });
  state.busCache.set(key, { at: Date.now(), data });
  return data;
}

async function fetchLineVehiclesCached(code) {
  const key = `vehicles:${code}`;
  const hit = state.busCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.data;
  try {
    const data = await fetchBusApi({ type: "vehicles", code });
    state.busCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (hit && Date.now() - hit.at < 120000) return hit.data;
    throw e;
  }
}

function routeDirectionCode(route) {
  const match = String(route || "").toLocaleUpperCase("tr").match(/(?:^|[_-])([GD])(?:[_-]|$)/);
  return match ? match[1] : "";
}

function vehicleStopIndex(vehicle, direction) {
  const nearest = Number(vehicle.nearestStop);
  let index = direction.stops.findIndex((s) => Number(s.code) === nearest);
  if (index >= 0) return index;
  if (vehicle.lat == null || vehicle.lng == null) return -1;
  let best = -1;
  let bestDistance = Infinity;
  direction.stops.forEach((s, i) => {
    if (s.lat == null || s.lng == null) return;
    const distance = haversine({ lat: vehicle.lat, lng: vehicle.lng }, { lat: s.lat, lng: s.lng });
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });
  return bestDistance <= 1000 ? best : -1;
}

function vehiclesForDirection(vehicles, direction) {
  const code = String(direction.code || "").toLocaleUpperCase("tr");
  return vehicles
    .filter((vehicle) => {
      const routeCode = routeDirectionCode(vehicle.route);
      if (routeCode) return routeCode === code;
      return direction.stops.some((s) => Number(s.code) === Number(vehicle.nearestStop));
    })
    .map((vehicle) => ({ ...vehicle, _stopIndex: vehicleStopIndex(vehicle, direction) }))
    .filter((vehicle) => vehicle._stopIndex >= 0);
}

function arrivalRow(a, { showBadge = true } = {}) {
  const m = a.minutes;
  const cls = m == null ? "" : m <= 0 ? "now" : m <= 5 ? "soon" : "";
  const eta = m == null ? (a.status === "B" ? "B" : "—") : m <= 0 ? t("Kalkış", "Departing") : `${m} ${t("dk", "min")}`;
  const meta = [
    a.status === "B" ? t("henüz sefere başlamadı / sinyal yok", "not yet in service / no signal") : "",
    a.note && a.status === "unknown" ? a.note : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lineAttr = a.line ? ` data-bus-line="${esc(a.line)}" role="button" tabindex="0"` : "";
  return `<div class="bus-arrival ${cls}"${lineAttr}>
    <div class="bus-arrival-main">
      ${
        showBadge
          ? `<span class="badge" style="--c:${busColor(a.line)}">${esc(a.line)}</span>`
          : ""
      }
      <div class="grow">
        <div class="dest">${esc(a.destination || "—")}</div>
        ${meta ? `<div class="line-meta">${esc(meta)}</div>` : ""}
      </div>
      <div class="eta"><strong>${esc(eta)}</strong>${a.clock ? `<small>${esc(a.clock)}</small>` : ""}</div>
    </div>
  </div>`;
}

function metrobusClock(arrival, base = new Date()) {
  if (arrival.minutes != null) {
    const when = new Date(base.getTime() + Math.max(0, arrival.minutes) * 60000);
    return fmtTime(when);
  }
  return arrival.clock || "";
}

function metrobusDepartureRow(arrival, base = new Date()) {
  const m = arrival.minutes;
  const cls = m == null ? "" : m <= 0 ? "now" : m <= 5 ? "soon" : "";
  const eta = m == null ? (arrival.status === "B" ? "B" : "—") : m <= 0 ? t("Kalkış", "Departing") : `${m} ${t("dk", "min")}`;
  return `<div class="dep ${cls}">
    <div class="when">${esc(eta)}</div>
    <div class="grow" style="font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(arrival.destination || "")}</div>
    <div class="hhmm">${esc(metrobusClock(arrival, base))}</div>
  </div>`;
}

function renderStopBoard(data, { stale = false } = {}) {
  const box = $("#busLive");
  if (!box) return;
  const updated = data.fetchedAt ? new Date(data.fetchedAt) : new Date();
  const time = `${fmtTime(updated)}:${String(updated.getSeconds()).padStart(2, "0")}`;
  const arrivals = data.arrivals || [];
  const stop = state.bus.stopIndex.get(Number(state.route.code));
  const mbLines = isMetrobusStop(stop) ? metrobusStopLines(stop) : [];
  const requested =
    state.busStopFocus?.key === Number(state.route.code) && state.busStopFocus.line
      ? String(state.busStopFocus.line).toLocaleUpperCase("tr")
      : state.route.mode === "metrobus" && state.route.line
        ? String(state.route.line).toLocaleUpperCase("tr")
        : null;
  const isMetrobus = state.route.mode === "metrobus" || isMetrobusStop(stop);
  const requestedLine = requested ? mbLines.find((entry) => entry.code.toLocaleUpperCase("tr") === requested) : null;
  const lineWithArrivals = mbLines.find((entry) =>
    arrivals.some((arrival) => String(arrival.line || "").toLocaleUpperCase("tr") === entry.code.toLocaleUpperCase("tr"))
  );
  const focusLine = isMetrobus ? requestedLine?.code || mbLines.find((entry) => entry.code === "34G")?.code || lineWithArrivals?.code || mbLines[0]?.code || null : null;

  view.querySelectorAll(".dirwrap [data-mb-focus]").forEach((el) => {
    el.classList.toggle("active", el.dataset.mbFocus === focusLine);
  });

  if (focusLine) {
    const focused = arrivals.filter((arrival) => String(arrival.line || "").toLocaleUpperCase("tr") === focusLine.toLocaleUpperCase("tr"));
    const seen = new Set();
    const focusedArrivals = focused
      .filter((arrival) => {
        const key = [arrival.line, arrival.destination, arrival.minutes, arrival.clock, arrival.status, arrival.note].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
    const entry = mbLines.find((item) => item.code === focusLine);
    const dirs = entry?.dirs || [];
    const hasLocalDirection = state.busStopFocus?.key === Number(state.route.code) &&
      state.busStopFocus.line === focusLine && state.busStopFocus.dirIndex != null;
    const selectedDirIndex = Math.min(
      hasLocalDirection ? Number(state.busStopFocus.dirIndex) : metrobusDirectionIndex(dirs),
      Math.max(0, dirs.length - 1)
    );
    const selectedDir = dirs[selectedDirIndex];
    const nextDirIndex = dirs.length > 1 ? (selectedDirIndex + 1) % dirs.length : selectedDirIndex;
    const directionArrivals = selectedDir
      ? focusedArrivals.filter((arrival) => {
          const destination = norm(arrival.destination || "");
          const target = norm(selectedDir.to || "");
          return destination && target && (destination.includes(target) || target.includes(destination));
        })
      : focusedArrivals;
    const arrivalsForDirection = directionArrivals;
    box.innerHTML = `
      <div class="live-head">
        <div>
          <strong>${esc(focusLine)} · ${t("sıradaki seferler", "next departures")}</strong>
          <p class="muted">${t("Metrobüs", "Metrobus")}${selectedDir ? ` · ${esc(selectedDir.from)} → ${esc(selectedDir.to)}` : ""} · ${t("canlı varış · son güncelleme", "live arrivals · last updated")}: ${time}${stale || data.stale ? ` · ${t("eski önbellek", "stale cache")}` : ""}</p>
        </div>
        <button class="dirchip" id="busRefresh" aria-label="${t("Yenile", "Refresh")}">↻</button>
      </div>
      ${dirs.length > 1
        ? `<button type="button" class="schedule-direction-toggle" data-mb-dir="${nextDirIndex}" aria-label="${t(`${esc(dirs[nextDirIndex].to)} yönünü göster`, `Show direction to ${esc(dirs[nextDirIndex].to)}`)}">
            <span class="schedule-direction-current">${esc(selectedDir.from)} → ${esc(selectedDir.to)}</span>
            <span class="schedule-direction-action" aria-hidden="true">↔ ${t("Yönü değiştir", "Switch direction")}</span>
          </button>`
        : ""}
      ${
        arrivalsForDirection.length
          ? arrivalsForDirection.map((arrival) => metrobusDepartureRow(arrival, updated)).join("")
          : `<div class="empty">${t(`Bu durakta ${esc(selectedDir?.to || focusLine)} yönü için canlı varış bilgisi yok.`, `No live arrival information toward ${esc(selectedDir?.to || focusLine)} at this stop.`)}</div>`
      }
      <p class="muted" style="margin-top:10px">${esc((isEnglish() ? "" : data.notes) || t("Süreler İETT canlı varış verisine göredir; trafiğe göre değişebilir.", "Times are based on İETT live arrival data; they may vary with traffic."))}</p>
    `;
    $("[data-mb-dir]")?.addEventListener("click", (event) => {
      if (!state.busStopFocus || state.busStopFocus.key !== Number(state.route.code) || state.busStopFocus.line !== focusLine) {
        state.busStopFocus = { key: Number(state.route.code), line: focusLine, dirIndex: 0 };
      }
      state.busStopFocus.dirIndex = Number(event.currentTarget.dataset.mbDir);
      const reverse = metrobusDirectionIsReverse(dirs[state.busStopFocus.dirIndex]);
      if (reverse != null) state.bus.metrobusListReverse = reverse;
      renderStopBoard(data, { stale });
    });
    $("#busRefresh")?.addEventListener("click", () => {
      toast(t("Varışlar güncelleniyor…", "Updating arrivals…"));
      refreshBusStop(state.route.codes?.length ? state.route.codes : state.route.code, { silent: false });
    });

    const nextByLine = new Map();
    for (const arrival of arrivals) {
      const line = String(arrival.line || "").toLocaleUpperCase("tr");
      if (line && !nextByLine.has(line)) nextByLine.set(line, arrival);
    }
    view.querySelectorAll("[data-mb-next]").forEach((el) => {
      const next = nextByLine.get(String(el.dataset.mbNext || "").toLocaleUpperCase("tr"));
      el.textContent = next
        ? `${t("Sıradaki", "Next")}: ${next.minutes == null ? "—" : next.minutes <= 0 ? t("kalkış", "departing") : `${next.minutes} ${t("dk", "min")}`} (${metrobusClock(next, updated)})`
        : t("Canlı varış yok", "No live arrivals");
    });
    return;
  }

  const announcements = data.announcements || [];
  const annBox = $("#busStopAnnouncements");
  if (annBox) annBox.innerHTML = stopAnnouncementsBanner(announcements);
  box.innerHTML = `
    <div class="live-head">
      <div>
        <strong>${t("Bu duraktan geçen otobüsler", "Buses passing this stop")}</strong>
        <p class="muted">${t("Canlı varış süreleri", "Live arrival times")} · ${t("son güncelleme", "last updated")}: ${time}${stale || data.stale ? ` · ${t("önbellek", "cached")}` : ""}</p>
      </div>
      <button class="dirchip" id="busRefresh" aria-label="${t("Yenile", "Refresh")}">↻</button>
    </div>
    <div style="margin-top:6px">
      ${
        arrivals.length
          ? arrivals.map((arrival) => arrivalRow(arrival)).join("")
          : `<div class="empty">${t("Şu anda bu durak için canlı varış bilgisi yok.", "No live arrival information for this stop right now.")}<br><span class="muted">${t("Gece saatlerinde seferler seyrek olabilir.", "Departures may be less frequent at night.")}</span></div>`
      }
    </div>
    <p class="muted" style="margin-top:10px">${esc((isEnglish() ? "" : data.notes) || t("Süreler tahminidir; trafiğe göre değişebilir.", "Times are estimates; they may vary with traffic."))}</p>
  `;
  $("#busRefresh")?.addEventListener("click", () => {
    toast(t("Varışlar güncelleniyor…", "Updating arrivals…"));
    refreshBusStop(state.route.codes?.length ? state.route.codes : state.route.code, { silent: false });
  });
  bindBusRows(box, () => render(), { mode: state.route.mode || null });
}

async function refreshBusStop(code, { silent = false } = {}) {
  const codes = [...new Set((Array.isArray(code) ? code : [code]).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const key = codes[0];
  if (!codes.length) return;
  const cacheKey = `stop:${codes.join(",")}`;
  const routeMatches = () => {
    const currentCodes = [...new Set((state.route.codes?.length ? state.route.codes : [state.route.code]).map(Number))].sort((a, b) => a - b);
    return state.route.name === "busStop" && currentCodes.join(",") === codes.join(",");
  };
  try {
    const responses = await Promise.all(codes.map((stopCode) => fetchBusApi({ type: "stop", code: stopCode })));
    const seen = new Set();
    const arrivals = responses.flatMap((item) => item.arrivals || []).filter((arrival) => {
      const arrivalKey = [arrival.line, arrival.destination, arrival.minutes, arrival.clock, arrival.status, arrival.note].join("|");
      if (seen.has(arrivalKey)) return false;
      seen.add(arrivalKey);
      return true;
    });
    const data = {
      ...responses[0],
      arrivals,
      fetchedAt: responses.map((item) => item.fetchedAt).filter(Boolean).sort().at(-1) || responses[0]?.fetchedAt,
    };
    state.busCache.set(cacheKey, { at: Date.now(), data });
    if (routeMatches()) renderStopBoard(data);
  } catch (e) {
    if (!routeMatches()) return;
    const hit = state.busCache.get(cacheKey);
    if (hit) return renderStopBoard(hit.data, { stale: true });
    if (silent) return;
    const box = $("#busLive");
    if (!box) return;
    box.innerHTML = `<div class="empty">${t("Canlı varış bilgisi alınamadı.", "Could not get live arrival information.")}<br>
      <span class="muted">${t("İnternet bağlantınızı kontrol edin veya tekrar deneyin.", "Check your internet connection or try again.")}</span><br>
      <button class="dirchip" id="busRetry" style="margin-top:10px">↻ ${t("Tekrar dene", "Try again")}</button></div>`;
    view.querySelectorAll("[data-mb-next]").forEach((el) => {
      if (/yükleniyor|loading/i.test(el.textContent || "")) el.textContent = t("Canlı varış alınamadı", "Could not get live arrivals");
    });
    $("#busRetry")?.addEventListener("click", () => refreshBusStop(codes, { silent: false }));
  }
}

function dirLabel(d) {
  return d.from && d.to && d.from !== d.to ? `${d.from} → ${d.to}` : `${d.from || d.code} ${t("(tur)", "(loop)")}`;
}

const VEHICLE_COLORS = ["#4aa3ff", "#ffb020", "#35d0a5", "#c084fc", "#ff7a59", "#f472b6"];

function vehicleColor(index) {
  return VEHICLE_COLORS[index % VEHICLE_COLORS.length];
}

function vehicleMarkerHtml(index) {
  return `<span class="vehicle-marker" style="--vc:${vehicleColor(index)}" title="${t("Araç", "Vehicle")} ${index + 1} · ${t("en yakın durak", "nearest stop")}" aria-label="${t("Araç", "Vehicle")} ${index + 1} ${t("en yakın durak", "nearest stop")}">${index + 1}</span>`;
}

function vehicleMarkersForDirection(direction, vehicleState) {
  const vehicles = vehiclesForDirection(vehicleState?.vehicles || [], direction);
  const byStop = new Map();
  vehicles.forEach((vehicle, index) => {
    if (vehicle._stopIndex < 0) return;
    if (!byStop.has(vehicle._stopIndex)) byStop.set(vehicle._stopIndex, []);
    byStop.get(vehicle._stopIndex).push(index);
  });
  return { vehicles, byStop };
}

function lineVehiclesHtml(direction, vehicleState) {
  const matched = vehiclesForDirection(vehicleState?.vehicles || [], direction);
  const total = vehicleState?.vehicles?.length || 0;
  const unlocated = Math.max(0, total - matched.length);
  const time = vehicleState?.at ? fmtTime(new Date(vehicleState.at)) : "";
  const stale = Boolean(vehicleState?.stale);
  const loading = !vehicleState;
  const error = Boolean(vehicleState?.error) && !matched.length;

  const head = `<div class="line-vehicles-head">
    <div><strong>${t("Canlı araçlar", "Live vehicles")}</strong><p class="muted">${esc(direction.to)} ${t("yönü", "direction")}${time ? ` · ${time}${stale ? ` · ${t("son bilinen", "last known")}` : ""}` : ""}</p></div>
    <button class="dirchip" id="busLineRefresh" type="button" aria-label="${t("Canlı araçları yenile", "Refresh live vehicles")}">↻</button>
  </div>`;

  if (loading) {
    return `${head}<div class="skeleton" style="height:42px;margin-top:10px"></div>`;
  }
  if (error) {
    return `${head}<div class="line-vehicles-note">${t("Canlı araç konumu alınamadı. Durak listesi kullanılmaya devam eder.", "Could not get live vehicle locations. The stop list remains available.")}</div>`;
  }
  if (!matched.length) {
    return `${head}<div class="line-vehicles-note">${t("Şu anda bu yön için canlı araç konumu yok.", "No live vehicle locations for this direction right now.")}${unlocated ? ` ${t(`${unlocated} aracın konumu bilinmiyor.`, `${unlocated} vehicle${unlocated === 1 ? "" : "s"} location unknown.`)}` : ""}</div>`;
  }

  const rows = matched
    .map((vehicle, index) => {
      const stop = direction.stops[vehicle._stopIndex];
      const updated = String(vehicle.updatedAt || "").match(/(\d{1,2}:\d{2})/)?.[1] || "";
      const label = vehicle.door ? `${t("Kapı", "Door")} ${vehicle.door}` : vehicle.plate || `${t("Araç", "Vehicle")} ${index + 1}`;
      const speed = Number(vehicle.speed);
      const meta = [
        stop ? `${t("En yakın durak", "Nearest stop")}: ${stop.name}` : "",
        updated ? t(`${updated} itibarıyla`, `as of ${updated}`) : "",
        Number.isFinite(speed) && speed > 0 ? `${Math.round(speed)} km/h` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<button class="vehicle-row" type="button" data-vehicle-focus="${index}">
        <span class="vehicle-dot" style="--vc:${vehicleColor(index)}">${index + 1}</span>
        <span class="grow">
          <span class="vehicle-title">${esc(label)}</span>
          <span class="vehicle-meta">${esc(meta || t("Konum bilgisi sınırlı", "Limited location information"))}</span>
        </span>
        <span class="go">›</span>
      </button>`;
    })
    .join("");

  return `${head}
    <div class="vehicle-list">${rows}</div>
    <p class="line-vehicles-note">${stale ? t("Son bilinen konum gösteriliyor; veri güncel olmayabilir. ", "Showing the last known location; data may be out of date. ") : ""}${t("Konumlar aracın en yakın durağına göre tahmin edilir, kesin GPS konumu değildir.", "Locations are estimated from each vehicle's nearest stop, not an exact GPS position.")}${unlocated ? ` ${t(`${unlocated} aracın konumu bilinmiyor.`, `${unlocated} vehicle${unlocated === 1 ? "" : "s"} location unknown.`)}` : ""}</p>`;
}

function updateBusLineVehicleMarkers(body, direction, vehicleState) {
  const { byStop } = vehicleMarkersForDirection(direction, vehicleState);
  body.querySelectorAll("[data-vehicle-stop]").forEach((el) => {
    const index = Number(el.dataset.vehicleStop);
    el.innerHTML = (byStop.get(index) || []).map((vehicleIndex) => vehicleMarkerHtml(vehicleIndex)).join("");
  });
}

function bindBusLineVehicles(body, direction, vehicleState) {
  const vehicles = vehiclesForDirection(vehicleState?.vehicles || [], direction);
  body.querySelectorAll("[data-vehicle-focus]").forEach((el) =>
    el.addEventListener("click", () => {
      const vehicle = vehicles[Number(el.dataset.vehicleFocus)];
      if (!vehicle || vehicle._stopIndex < 0) return;
      const target = body.querySelector(`[data-line-stop-index="${vehicle._stopIndex}"]`);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("vehicle-target");
      clearTimeout(target._vehicleTargetTimer);
      target._vehicleTargetTimer = setTimeout(() => target.classList.remove("vehicle-target"), 1800);
    })
  );
}

function updateBusLineVehiclesView(code) {
  if (state.route.name !== "busLine" || state.route.code !== code || state.route.mode === "metrobus") return;
  const viewData = state.busLineView;
  if (!viewData || viewData.code !== code) return;
  const body = $("#busLineBody");
  if (!body) return;
  const dirs = viewData.data.directions || [];
  if (!dirs.length) return;
  const selected = Math.min(state.busDirSel[code] || 0, dirs.length - 1);
  const dir = dirs[selected];
  const vehicleState = state.busLineVehicles.get(code);
  const box = $("#busLineVehicles");
  if (box) box.innerHTML = lineVehiclesHtml(dir, vehicleState);
  updateBusLineVehicleMarkers(body, dir, vehicleState);
  bindBusLineVehicles(body, dir, vehicleState);
  $("#busLineRefresh")?.addEventListener("click", () => refreshBusLineVehicles(code, { force: true }));
}

async function refreshBusLineVehicles(code, { silent = false, force = false } = {}) {
  if (state.route.name !== "busLine" || state.route.code !== code || state.route.mode === "metrobus") return;
  const current = state.busLineVehicles.get(code);
  const cached = state.busCache.get(`vehicles:${code}`);
  try {
    let data;
    if (!force && cached && Date.now() - cached.at < 15000) {
      data = cached.data;
    } else {
      data = await fetchBusApi({ type: "vehicles", code });
      state.busCache.set(`vehicles:${code}`, { at: Date.now(), data });
    }
    state.busLineVehicles.set(code, { vehicles: data.vehicles || [], at: Date.now(), stale: false, error: null });
  } catch (error) {
    const fallback = current?.vehicles?.length
      ? current
      : cached
        ? { vehicles: cached.data?.vehicles || [], at: cached.at }
        : null;
    state.busLineVehicles.set(code, {
      vehicles: fallback?.vehicles || [],
      at: fallback?.at || 0,
      stale: Boolean(fallback?.vehicles?.length),
      error,
    });
    if (!silent) toast(t("Canlı araç konumu alınamadı", "Could not get live vehicle location"));
  }
  updateBusLineVehiclesView(code);
}

function ensureBusLineVehicles(code) {
  if (state.route.name !== "busLine" || state.route.code !== code || state.route.mode === "metrobus") return;
  const current = state.busLineVehicles.get(code);
  if (!current || Date.now() - current.at > 15000) refreshBusLineVehicles(code, { silent: true });
  else updateBusLineVehiclesView(code);
}

function renderBusLine(code) {
  if (!state.bus.loaded) {
    if (state.bus.error) view.innerHTML = `<div class="empty">${t("Otobüs verisi yüklenemedi.", "Could not load bus data.")}<br><button class="dirchip" onclick="location.reload()">↻ ${t("Tekrar dene", "Try again")}</button></div>`;
    else renderLoading(t("Otobüs verisi yükleniyor…", "Loading bus data…"));
    return;
  }
  const line = state.bus.lineIndex.get(code);
  if (!line) return renderNotFound();
  const isMetro = isMetrobusLine(line) || state.route.mode === "metrobus";
  const scheduleAvailable = !isMetro;
  if (state.busSchedule.code !== code) {
    Object.assign(state.busSchedule, { code, open: false, day: null, dir: null, loading: false, error: null });
  }
  view.innerHTML = `
    <div class="card line-head-card" id="busLineHead"${scheduleAvailable ? ` role="button" tabindex="0" aria-expanded="${state.busSchedule.open}" aria-controls="busSchedulePanel"` : ""}>
      <div class="row between">
        <div class="row" style="gap:10px;min-width:0">
          <div class="badges">${busBadge(code)}</div>
          <div class="grow"><h2>${esc(line.name)}</h2>
            <p class="muted">${esc(line.tariff || t("Otobüs", "Bus"))}${line.duration ? ` · ~${line.duration} ${t("dk", "min")}` : ""}${line.length ? ` · ${line.length} km` : ""}</p>
          </div>
        </div>
        ${scheduleAvailable ? `<div class="line-head-action"><span>${t("Sefer saatleri", "Departure times")}</span><span class="go">›</span></div>` : ""}
      </div>
    </div>
    <div id="busSchedulePanel" hidden></div>
    <div class="card" id="busLineBody">
      <div class="skeleton" style="height:24px;width:55%"></div>
      <div class="skeleton" style="height:44px;margin-top:12px"></div>
      <div class="skeleton" style="height:44px;margin-top:8px"></div>
    </div>
    ${isMetro ? "" : `<p class="footer-note">${t("Durak sırası İETT hat servisinden alınır · araç konumları canlıdır.", "Stop order comes from the İETT line service · vehicle locations are live.")}</p>`}
  `;
  if (scheduleAvailable) {
    const head = $("#busLineHead");
    const toggle = () => toggleBusSchedule(code);
    head?.addEventListener("click", toggle);
    head?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
  }
  renderBusSchedulePanel();
  const cacheKey = `line:${code}`;
  const hit = state.busCache.get(cacheKey);
  if (hit) {
    renderLineStops(hit.data);
    if (!isMetro) ensureBusLineVehicles(code);
  } else {
    refreshBusLine(code);
  }
}

async function refreshBusLine(code) {
  try {
    const data = await fetchLineStopsCached(code);
    if (state.route.name !== "busLine" || state.route.code !== code) return;
    renderLineStops(data);
    ensureBusLineVehicles(code);
  } catch (e) {
    if (state.route.name !== "busLine" || state.route.code !== code) return;
    const body = $("#busLineBody");
    if (!body) return;
    body.innerHTML = `<div class="empty">${t("Hat durakları alınamadı.", "Could not load line stops.")}<br>
      <span class="muted">${t("İnternet bağlantınızı kontrol edin veya tekrar deneyin.", "Check your internet connection or try again.")}</span><br>
      <button class="dirchip" id="lineRetry" style="margin-top:10px">↻ ${t("Tekrar dene", "Try again")}</button></div>`;
    $("#lineRetry")?.addEventListener("click", () => refreshBusLine(code));
  }
}

function renderLineStops(data) {
  const body = $("#busLineBody");
  if (!body) return;
  const dirs = data.directions || [];
  if (!dirs.length) {
    body.innerHTML = `<div class="empty">${t("Bu hat için durak listesi bulunamadı.", "No stop list found for this line.")}</div>`;
    return;
  }
  state.busLineView = { code: data.code, data };
  const selected = Math.min(state.busDirSel[data.code] || 0, dirs.length - 1);
  const dir = dirs[selected];
  const line = state.bus.lineIndex.get(data.code);
  const isMetro = isMetrobusLine(line) || state.route.mode === "metrobus";
  const near = nearestStopInfo(dir.stops);
  const vehicleState = isMetro ? null : state.busLineVehicles.get(data.code);
  const markerData = isMetro ? { byStop: new Map() } : vehicleMarkersForDirection(dir, vehicleState);
  body.innerHTML = `
    <div class="live-head">
      <div><strong>${isMetro ? t("Duraklar", "Stops") : t("Hat durakları", "Line stops")}</strong><p class="muted">${dir.stops.length} ${t("durak", "stops")}${isMetro ? ` · ${t("canlı seferler için bir durağa dokunun", "tap a stop for live departures")}` : " · İETT"}</p></div>
    </div>
    ${dirs.length > 1
      ? `<button type="button" class="schedule-direction-toggle bus-line-direction-toggle" data-bus-dir="${(selected + 1) % dirs.length}" aria-label="${t(`Yönü ${esc(dirLabel(dirs[(selected + 1) % dirs.length]))} olarak değiştir`, `Switch direction to ${esc(dirLabel(dirs[(selected + 1) % dirs.length]))}`)}">
          <span class="schedule-direction-current">${esc(dirLabel(dir))}</span>
          <span class="schedule-direction-action" aria-hidden="true">↔ ${t("Yönü değiştir", "Switch direction")}</span>
        </button>`
      : `<div class="schedule-direction-current schedule-direction-only">${esc(dirLabel(dir))}</div>`}
    ${lineLocationPrompt()}
    ${isMetro ? "" : `<div class="line-vehicles" id="busLineVehicles">${lineVehiclesHtml(dir, vehicleState)}</div>`}
    <div class="line-stop-list">
      ${dir.stops
        .map(
          (s, i) => `<div class="station-row line-stop-row${i === near.index ? " nearest-stop" : ""}" data-bus-stop="${s.code}" data-line-stop-index="${i}" role="button" tabindex="0">
            <div class="line-no">${i + 1}</div>
            <div class="grow">
              <div class="name" style="font-size:14.5px">${esc(s.name)}${i === near.index ? ` ${nearestStopLabel(near)}` : ""}</div>
              ${isMetro && (i === 0 || i === dir.stops.length - 1) ? `<div class="line-stop-hint">${i === 0 ? t("Kalkış", "Start") : t("Varış", "End")}</div>` : ""}
            </div>
            ${isMetro ? "" : `<div class="line-stop-vehicles" data-vehicle-stop="${i}">${(markerData.byStop.get(i) || [])
              .map((vehicleIndex) => vehicleMarkerHtml(vehicleIndex))
              .join("")}</div>`}
            <div class="go">›</div>
          </div>`
        )
        .join("")}
    </div>`;
  body.querySelectorAll("[data-bus-dir]").forEach((el) =>
    el.addEventListener("click", () => {
      state.busDirSel[data.code] = +el.dataset.busDir;
      const scheduleDir = scheduleDirectionFromBus(data.code, state.busDirSel[data.code]);
      if (scheduleDir) state.busSchedule.dir = scheduleDir;
      renderLineStops(data);
    })
  );
  bindLineLocationPrompt();
  bindBusRows(body, () => render(), { mode: state.route.mode || null, line: isMetro ? data.code : null });
  if (!isMetro) {
    $("#busLineRefresh")?.addEventListener("click", () => refreshBusLineVehicles(data.code, { force: true }));
    bindBusLineVehicles(body, dir, vehicleState);
  }
  renderBusSchedulePanel();
}

/* --- otobüs sefer saatleri --- */
const SCHEDULE_DAY_OPTIONS = [
  ["I", "Hafta içi", "Weekdays"],
  ["C", "Cumartesi", "Saturday"],
  ["P", "Pazar", "Sunday"],
];

function todayScheduleDay(date = new Date()) {
  const day = date.getDay();
  return day === 0 ? "P" : day === 6 ? "C" : "I";
}

function scheduleDirectionLabel(dir, line) {
  const directions =
    line && state.busLineView?.code === line.code ? state.busLineView?.data?.directions || [] : [];
  const found = directions.find((d) => String(d.code || "").toLocaleUpperCase("tr") === dir);
  if (found?.from && found?.to) return `${found.from} → ${found.to}`;
  const parts = String(line?.name || "").split(/\s*[-–—]\s*/).filter(Boolean);
  if (parts.length === 2) {
    return dir === "G" ? `${parts[0]} → ${parts[1]}` : `${parts[1]} → ${parts[0]}`;
  }
  return dir === "G" ? t("Gidiş", "Outbound") : t("Dönüş", "Inbound");
}

function busDirectionIndexFromSchedule(code, scheduleDir) {
  const directions = state.busLineView?.code === code ? state.busLineView.data.directions || [] : [];
  if (!directions.length) return null;
  const line = state.bus.lineIndex.get(code);
  const label = norm(scheduleDirectionLabel(scheduleDir, line));
  let index = directions.findIndex((direction) => norm(dirLabel(direction)) === label);
  if (index >= 0) return index;
  const ends = String(line?.name || "").split(/\s*[-–—]\s*/).filter(Boolean);
  const expectedFrom = norm(ends[scheduleDir === "G" ? 0 : 1] || "");
  index = directions.findIndex((direction) => norm(direction.from) === expectedFrom);
  if (index >= 0) return index;
  return Math.min(scheduleDir === "G" ? 0 : 1, directions.length - 1);
}

function scheduleDirectionFromBus(code, directionIndex) {
  const cached = state.busScheduleCache.get(code)?.data;
  if (!cached) return null;
  const directions = state.busLineView?.code === code ? state.busLineView.data.directions || [] : [];
  const direction = directions[directionIndex];
  if (!direction) return null;
  const line = state.bus.lineIndex.get(code);
  const available = ["G", "D"].filter((key) => Object.values(cached.days || {}).some((day) => day?.[key]?.times?.length));
  const label = norm(dirLabel(direction));
  let key = available.find((candidate) => norm(scheduleDirectionLabel(candidate, line)) === label);
  if (key) return key;
  const ends = String(line?.name || "").split(/\s*[-–—]\s*/).filter(Boolean);
  if (ends.length === 2) {
    const from = norm(direction.from);
    key = available.find((candidate) => from === norm(ends[candidate === "G" ? 0 : 1]));
  }
  return key || available[Math.min(directionIndex, available.length - 1)] || null;
}

function updateBusScheduleHead() {
  const head = $("#busLineHead");
  if (!head) return;
  const open = state.busSchedule.code === state.route.code && state.busSchedule.open;
  head.setAttribute("aria-expanded", String(open));
  head.classList.toggle("open", open);
}

function renderBusSchedulePanel() {
  const panel = $("#busSchedulePanel");
  if (!panel) return;
  const s = state.busSchedule;
  if (!s.open || s.code !== state.route.code) {
    panel.hidden = true;
    panel.innerHTML = "";
    updateBusScheduleHead();
    return;
  }

  panel.hidden = false;
  const line = state.bus.lineIndex.get(s.code);
  const cached = state.busScheduleCache.get(s.code);
  const data = cached && Date.now() - cached.at < SCHEDULE_CACHE_TTL ? cached.data : null;

  if (s.loading && !data) {
    panel.innerHTML = `<div class="card schedule-card">
      <div class="live-head"><div><strong>${t("Sefer saatleri", "Departure times")}</strong><p class="muted">${t("Statik tarife verisi yükleniyor…", "Loading static timetable data…")}</p></div></div>
      <div class="skeleton" style="height:38px;margin-top:12px"></div>
      <div class="skeleton" style="height:80px;margin-top:8px"></div>
    </div>`;
    updateBusScheduleHead();
    return;
  }

  if (s.error && !data) {
    panel.innerHTML = `<div class="card schedule-card">
      <div class="live-head">
        <div><strong>${t("Sefer saatleri", "Departure times")}</strong><p class="muted">${t("Statik sefer saatleri yüklenemedi.", "Could not load static departure times.")}</p></div>
      </div>
      <div class="empty" style="padding:18px 4px">${t("Tarife dosyası yüklenemedi.", "Could not load the timetable file.")}<br><span class="muted">${t("Sayfayı yeniden yükleyip tekrar deneyin.", "Reload the page and try again.")}</span><br>
        <button class="dirchip" id="scheduleRetry" style="margin-top:10px">↻ ${t("Tekrar dene", "Try again")}</button>
      </div>
    </div>`;
    $("#scheduleRetry")?.addEventListener("click", () => loadBusSchedule(s.code));
    updateBusScheduleHead();
    return;
  }

  if (!data) {
    panel.innerHTML = "";
    updateBusScheduleHead();
    return;
  }

  const availableDays = SCHEDULE_DAY_OPTIONS.map(([key]) => key).filter(
    (day) => Object.keys(data.days?.[day] || {}).length
  );
  const hasSchedule = availableDays.length > 0;
  let day = s.day;
  if (!availableDays.includes(day)) {
    day = availableDays.includes(todayScheduleDay()) ? todayScheduleDay() : availableDays[0] || null;
  }
  s.day = day;
  const dayData = data.days?.[day] || {};
  const availableDirs = ["G", "D"].filter((dir) => dayData[dir]?.times?.length);
  let dir = s.dir;
  if (!availableDirs.includes(dir)) dir = availableDirs.includes("G") ? "G" : availableDirs[0] || null;
  s.dir = dir;
  if (dir && state.busLineView?.code === s.code) {
    const syncedDirection = busDirectionIndexFromSchedule(s.code, dir);
    if (syncedDirection != null) state.busDirSel[s.code] = syncedDirection;
  }
  const dirData = dayData[dir];

  const dayButtons = SCHEDULE_DAY_OPTIONS.map(([key, trLabel, enLabel]) => {
    const has = Object.keys(data.days?.[key] || {}).length > 0;
    return `<button type="button" class="dirchip schedule-day-chip ${key === "C" ? "schedule-weekend-start" : ""} ${key === day ? "active" : ""}" data-schedule-day="${key}" aria-pressed="${key === day}" ${has ? "" : "disabled"}>${t(trLabel, enLabel)}${key === todayScheduleDay() ? ` · ${t("bugün", "today")}` : ""}</button>`;
  }).join("");

  const reverseDir = availableDirs.find((key) => key !== dir);
  const dirControl = availableDirs.length > 1
    ? `<button type="button" class="schedule-direction-toggle" data-schedule-dir="${reverseDir}" aria-label="${t(`${esc(scheduleDirectionLabel(reverseDir, line))} yönünü göster`, `Show ${esc(scheduleDirectionLabel(reverseDir, line))} direction`)}">
        <span class="schedule-direction-current">${esc(scheduleDirectionLabel(dir, line))}</span>
        <span class="schedule-direction-action" aria-hidden="true">↔ ${t("Yönü değiştir", "Switch direction")}</span>
      </button>`
    : availableDirs.length === 1
      ? `<div class="schedule-direction-current schedule-direction-only">${esc(scheduleDirectionLabel(dir, line))}</div>`
      : "";

  let scheduleBody = "";
  if (dirData) {
    const midnightIsLast = dirData.times.includes("00:00");
    const displayedTimes = midnightIsLast
      ? [...dirData.times.filter((time) => time !== "00:00"), "00:00"]
      : dirData.times;
    const firstDeparture = midnightIsLast
      ? displayedTimes.find((time) => time !== "00:00") || dirData.first
      : dirData.first;
    const lastDeparture = midnightIsLast ? "00:00" : dirData.last;
    const groups = new Map();
    for (const time of displayedTimes) {
      const hour = time.slice(0, 2);
      if (!groups.has(hour)) groups.set(hour, []);
      groups.get(hour).push(time);
    }
    scheduleBody = `
      <div class="schedule-summary">
        <div><span>${t("İlk sefer", "First departure")}</span><strong>${esc(firstDeparture)}</strong></div>
        <div><span>${t("Son sefer", "Last departure")}</span><strong>${esc(lastDeparture)}</strong></div>
        <div><span>${t("Toplam", "Total")}</span><strong>${dirData.count}</strong></div>
      </div>
      <div class="schedule-hours" aria-label="${t("İlk seferden son sefere kadar saatlik tarife", "Hourly timetable from first to last departure")}">
        ${[...groups.entries()]
          .map(
            ([hour, times]) => `<div class="schedule-hour">
              <div class="schedule-hour-label">${esc(hour)}:00</div>
              <div class="schedule-hour-times">${times.map((time) => `<span class="schedule-time">${esc(time)}</span>`).join("")}</div>
            </div>`
          )
          .join("")}
      </div>`;
  } else {
    scheduleBody = `<div class="empty" style="padding:18px 4px">${
      hasSchedule ? t("Bu gün ve yön için planlanan sefer saati bulunamadı.", "No scheduled departure found for this day and direction.") : t("Bu hat için planlanan sefer saati bulunamadı.", "No scheduled departure found for this line.")
    }</div>`;
  }

  panel.innerHTML = `<div class="card schedule-card">
    <div class="live-head">
      <div><strong>${t("Sefer saatleri", "Departure times")}</strong><p class="muted">${esc(data.name || line?.name || s.code)} · ${t("planlanan ana durak kalkışları", "scheduled departures from the main stop")}</p></div>
    </div>
    ${hasSchedule ? `<div class="dirwrap schedule-days">${dayButtons}</div>` : ""}
    ${dirControl}
    ${scheduleBody}
    <p class="muted schedule-note">${t("Saatler İETT’nin planlanan ana durak kalkışlarıdır; ara duraklar için durak sayfasındaki canlı varış sürelerine bakın.", "Times are İETT's scheduled departures from the main stop; for intermediate stops, check the live arrival times on the stop page.")} ${t("Tarife verisi", "Timetable data")}: ${esc(data.fetchedAt ? fmtDate(data.fetchedAt) : t("paketli statik dosya", "bundled static file"))}.</p>
  </div>`;

  panel.querySelectorAll("[data-schedule-day]").forEach((el) =>
    el.addEventListener("click", () => {
      s.day = el.dataset.scheduleDay;
      renderBusSchedulePanel();
    })
  );
  panel.querySelectorAll("[data-schedule-dir]").forEach((el) =>
    el.addEventListener("click", () => {
      s.dir = el.dataset.scheduleDir;
      const syncedDirection = busDirectionIndexFromSchedule(s.code, s.dir);
      if (syncedDirection != null) {
        state.busDirSel[s.code] = syncedDirection;
        const lineData = state.busLineView?.code === s.code ? state.busLineView.data : null;
        if (lineData) renderLineStops(lineData);
      }
      renderBusSchedulePanel();
    })
  );
  updateBusScheduleHead();
}

async function loadBusSchedule(code) {
  const s = state.busSchedule;
  if (s.code !== code) return;
  s.loading = true;
  s.error = null;
  renderBusSchedulePanel();
  try {
    if (!state.busScheduleCatalog) {
      state.busScheduleCatalog = await fetchJson("data/bus-schedules.json", { timeout: 30000 });
    }
    const schedule = state.busScheduleCatalog.lines?.[code];
    if (!schedule) throw new Error(t("Bu hat için statik tarife bulunamadı.", "No static timetable found for this line."));
    const data = { ...schedule, fetchedAt: state.busScheduleCatalog.generatedAt };
    state.busScheduleCache.set(code, { at: Date.now(), data });
  } catch (error) {
    state.busScheduleCatalog = null;
    if (s.code === code) s.error = t("Statik sefer saatleri yüklenemedi.", "Could not load static departure times.");
  } finally {
    if (s.code === code) {
      s.loading = false;
      if (state.route.name === "busLine" && state.route.code === code) {
        const previousDirection = state.busDirSel[code] || 0;
        renderBusSchedulePanel();
        const syncedDirection = s.dir ? busDirectionIndexFromSchedule(code, s.dir) : null;
        const lineData = state.busLineView?.code === code ? state.busLineView.data : null;
        if (lineData && syncedDirection != null && syncedDirection !== previousDirection) {
          state.busDirSel[code] = syncedDirection;
          renderLineStops(lineData);
        }
      }
    }
  }
}

function toggleBusSchedule(code) {
  const s = state.busSchedule;
  if (s.code !== code) {
    Object.assign(s, { code, open: false, day: null, dir: null, loading: false, error: null });
  }
  s.open = !s.open;
  if (s.open) {
    if (!s.day) s.day = todayScheduleDay();
    const cached = state.busScheduleCache.get(code);
    if (!cached || Date.now() - cached.at >= SCHEDULE_CACHE_TTL) loadBusSchedule(code);
  }
  renderBusSchedulePanel();
}

/* --- ayarlar görünümü --- */
function renderSettings() {
  const pref = themePreference();
  const lang = langPreference();
  const hasLocation = Boolean(state.location);
  view.innerHTML = `
    <div class="card stack">
      <div class="setting-row">
        <div class="grow">
          <div class="setting-title">${t("Konum", "Location")}</div>
          <div class="muted">${t("Yakınınızdaki otobüs duraklarını, metro ve metrobüs hatlarını göstermek için kullanılır.", "Used to show nearby bus stops, metro and metrobus lines.")}</div>
        </div>
        <span class="setting-state${hasLocation ? " on" : ""}">${hasLocation ? t("Açık", "On") : t("Kapalı", "Off")}</span>
        <label class="switch">
          <input id="locToggle" type="checkbox" role="switch" aria-label="${t("Konumu aç veya kapat", "Turn location on or off")}" ${hasLocation ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
      <p class="muted setting-note">${t("Konum izni yakınınızdaki otobüs duraklarını, metro ve metrobüs hatlarını göstermek için kullanılır; konumunuz cihazınızda saklanır ve bir sunucuya gönderilmez.", "Location permission is used to show nearby bus stops, metro and metrobus lines; your location is stored on your device and is not sent to a server.")}</p>
    </div>

    <div class="card stack">
      <div>
        <div class="setting-title">${t("Tema", "Theme")}</div>
        <div class="muted">${t("Uygulamanın görünümünü seçin.", "Choose how the app looks.")}</div>
      </div>
      <div class="segmented" role="group" aria-label="${t("Tema", "Theme")}">
        ${[
          ["device", t("Cihaz", "Device")],
          ["light", t("Açık", "Light")],
          ["dark", t("Koyu", "Dark")],
        ]
          .map(
            ([value, label]) =>
              `<button type="button" data-theme-choice="${value}" aria-pressed="${pref === value}" class="${pref === value ? "active" : ""}">${label}</button>`
          )
          .join("")}
      </div>
      <p class="muted" style="font-size:12.5px">${t("Cihaz seçeneği telefonun sistem temasını takip eder.", "The Device option follows your phone's system theme.")}</p>
    </div>

    <div class="card stack">
      <div>
        <div class="setting-title">${t("Dil", "Language")}</div>
        <div class="muted">${t("Uygulama dilini seçin.", "Choose the app language.")}</div>
      </div>
      <div class="segmented" style="grid-template-columns:repeat(2,1fr)" role="group" aria-label="${t("Dil", "Language")}">
        ${[
          ["tr", "Türkçe"],
          ["en", "English"],
        ]
          .map(
            ([value, label]) =>
              `<button type="button" data-lang-choice="${value}" aria-pressed="${lang === value}" class="${lang === value ? "active" : ""}">${label}</button>`
          )
          .join("")}
      </div>
    </div>

    <button class="settings-info" id="settingsInfoBtn" type="button">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10.8v5.4"></path><path d="M12 7.4h.01"></path></svg>
      <span class="grow">
        <span class="settings-info-title">${t("Bilgi", "About")}</span>
        <span class="settings-info-sub">${t("Uygulama, veri kaynakları ve gizlilik", "App, data sources and privacy")}</span>
      </span>
      <span class="go">›</span>
    </button>`;

  $("#locToggle")?.addEventListener("change", (event) => {
    if (event.target.checked) {
      askLocation();
      return;
    }
    state.location = null;
    localStorage.removeItem("sm.loc");
    toast(t("Konum kapatıldı", "Location turned off"));
    render();
  });
  view.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => setThemePreference(button.dataset.themeChoice));
  });
  view.querySelectorAll("[data-lang-choice]").forEach((button) => {
    button.addEventListener("click", () => setLanguagePreference(button.dataset.langChoice));
  });
  $("#settingsInfoBtn")?.addEventListener("click", () => go("#/bilgi"));
}

/* --- bilgi görünümü --- */
function renderAbout() {
  const tariffDate = state.generatedAt ? fmtDate(state.generatedAt) : null;
  const busDate = state.bus.generatedAt ? fmtDate(state.bus.generatedAt) : null;
  view.innerHTML = `
    <div class="card stack">
      <h2>${t("İstanbul Ulaşım nedir?", "What is Istanbul Transit?")}</h2>
      <p class="muted">${t("İstanbul Ulaşım; metro, tramvay, füniküler, teleferik, metrobüs ve otobüs bilgilerini tek yerde sunar. Hat ve durak arayabilir, hatların durak sırasını ve yönlerini inceleyebilir, metro tarifesini ve İETT’den alınan tahmini canlı otobüs/metrobüs varışlarını görebilirsiniz. Konum izniyle yakınınızdaki metro hatları ile en yakın otobüs ve metrobüs durakları listelenir; favorilerinizi ve yolculuk planınızı da uygulama içinden yönetebilirsiniz. Uyarılar ve Türkçe/İngilizce dil seçenekleri de desteklenir.", "Istanbul Transit brings metro, tram, funicular, cable car, metrobus and bus information together. Search for lines and stops, browse stop order and direction, view metro timetables and estimated live bus/metrobus arrivals from İETT. With location permission, you can see nearby metro lines and the closest bus and metrobus stops. You can also manage favorites and plan journeys in the app, with service alerts and Turkish/English language options.")}</p>
      <p class="muted">${t("Uygulamayı telefonunuzun ana ekranına ekleyebilirsiniz. Canlı otobüs ve metrobüs varışları için internet bağlantısı gerekir.", "You can add the app to your phone's home screen. An internet connection is required for live bus and metrobus arrivals.")}</p>
    </div>
    <div class="card stack">
      <h2>${t("Metro, tramvay ve füniküler", "Metro, tram and funicular")}</h2>
      <p class="muted">${t("Ana sayfadaki arama alanından istasyon veya hat arayın. Bir hattı açtığınızda durakları sırasıyla görürsünüz; bir durağa dokunduğunuzda o duraktan kalkacak sonraki seferlerin saatlerini ve kalan dakikayı görürsünüz. Yön düğmeleriyle ters yöndeki seferlere bakabilirsiniz.", "Search for a station or line from the search field on the home page. When you open a line, you see its stops in order; when you tap a stop, you see the times of upcoming departures from that stop and the minutes remaining. Use the direction buttons to view departures in the opposite direction.")}</p>
      <p class="muted">${t("Metro saatleri resmî sefer tarifesine dayanır. Bu nedenle gördüğünüz süre, istasyon ekranındaki anlık araç sayacı değil, tarifedeki kalkış saatine kalan süredir. Hatlarda bir aksama varsa uyarı kartında görünür.", "Metro times are based on the official timetable. So the time you see is not a live vehicle counter from the station screen, but the time remaining until the scheduled departure. If there is a disruption on a line, it appears in the alert card.")}</p>
    </div>
    <div class="card stack">
      <h2>${t("Otobüs", "Bus")}</h2>
      <p class="muted">${t("Konum izni açıksa otobüs sekmesinde 100 metre içindeki duraklar mesafeleriyle listelenir. Bir durağa dokunarak o duraktan geçen hatları ve tahmini varış sürelerini görebilirsiniz. Arama alanına hat numarası veya durak adı yazarak da arama yapabilirsiniz.", "If location permission is on, stops within 100 metres are listed with their distances on the Bus tab. Tap a stop to see the lines passing through it and estimated arrival times. You can also search by typing a line number or stop name.")}</p>
      <p class="muted">${t("Bir otobüs hattını açtığınızda hattın bütün duraklarını ve gidiş/dönüş yönlerini görürsünüz. Canlı araç konumu alınabiliyorsa hangi aracın hangi durağa yakın olduğu numaralı işaretlerle gösterilir. Bu konum, aracın bildirdiği en yakın duraktır; kesin GPS konumu değildir.", "When you open a bus line, you see all its stops and outbound/inbound directions. If live vehicle locations are available, numbered markers show which vehicle is near which stop. This location is the nearest stop reported by the vehicle, not an exact GPS position.")}</p>
    </div>
    <div class="card stack">
      <h2>${t("Metrobüs", "Metrobus")}</h2>
      <p class="muted">${t("Metrobüs sekmesinde hat veya durak arayabilirsiniz. Bir metrobüs hattını açtığınızda hattın bütün duraklarını kalkıştan varışa doğru sırasıyla görürsünüz. Bir durağa dokunduğunuzda o durakta geçen metrobüs hatlarını ve sıradaki seferlerin canlı varış sürelerini görürsünüz.", "On the Metrobus tab you can search for a line or stop. When you open a metrobus line, you see all its stops in order from departure to arrival. When you tap a stop, you see the metrobus lines passing through it and live arrival times for the next departures.")}</p>
      <p class="muted">${t("Metrobüs durağında canlı varış süreleri görüntülenir. Metrobüs araçlarının canlı konumu gösterilmez.", "Live arrival times are shown at metrobus stops. Live locations of metrobus vehicles are not shown.")}</p>
    </div>
    <div class="card stack">
      <h2>${t("Yakındaki duraklar ve konum", "Nearby stops and location")}</h2>
      <p class="muted">${t("Konum izni verdiğinizde otobüs sekmesinde 100 metre içindeki duraklar, metro sayfasında size en yakın üç metro hattı, metrobüs sayfasında ise size en yakın üç metrobüs hattı ve bu hatların en yakın durakları gösterilir. Konum yalnızca bu hesaplama için cihazınızda kullanılır; bir sunucuya gönderilmez.", "When you grant location permission, stops within 100 metres are shown on the Bus tab, the three metro lines nearest to you on the Metro page, and the three metrobus lines nearest to you with their nearest stops on the Metrobus page. Location is used only on your device for this calculation and is not sent to a server.")}</p>
      <p class="muted">${t("Konum iznini Ayarlar ekranından açıp kapatabilirsiniz.", "You can turn location permission on or off from the Settings screen.")}</p>
    </div>
    <div class="card stack">
      <h2>${t("Canlı bilgiler ne kadar güncel?", "How current is live information?")}</h2>
      <p class="muted">${t("Otobüs ve metrobüs varış süreleri İETT’nin tahmini canlı verisidir; trafik ve durak yoğunluğuna göre değişebilir. “B” işareti, aracın henüz sefere başlamadığını veya konum bilgisinin alınamadığını gösterir.", "Bus and metrobus arrival times are İETT's estimated live data; they may vary with traffic and stop density. The “B” marker indicates that the vehicle has not yet started its trip or its location could not be obtained.")}</p>
      <p class="muted">${t("Canlı otobüs bilgileri için internet gerekir. Metro tarifesi ve otobüs hat/durak araması ise cihazda saklanan verilerle çevrimdışı da çalışır. Gece saatlerinde ve resmî tatillerde seferler seyrekleşebilir; gösterilen saatler en yakın gün tipine göre hesaplanır.", "Internet is required for live bus information. The metro timetable and bus line/stop search work offline using data stored on the device. Departures may be less frequent at night and on public holidays; displayed times are calculated according to the nearest day type.")}</p>
      ${
        tariffDate || busDate
          ? `<p class="muted" style="font-size:12px">${tariffDate ? `${t("Metro tarifesi", "Metro timetable")}: ${tariffDate}` : ""}${tariffDate && busDate ? " · " : ""}${busDate ? `${t("Otobüs durak listesi", "Bus stop list")}: ${busDate}` : ""}</p>`
          : ""
      }
    </div>
    <div class="card stack">
      <h2>${t("Uyarıları takip etme", "Following alerts")}</h2>
      <p class="muted">${t("Metro, otobüs ve metrobüs sayfalarındaki uyarı başlıkları kapalı başlar. Başlığa dokunarak uyarı listesini açabilirsiniz. Listede bir uyarıya dokunduğunuzda ayrıntısı açılır; başka bir uyarıya geçtiğinizde önceki kapanır. Başlığa tekrar dokunarak tüm listeyi daraltabilirsiniz.", "Alert headings on the Metro, Bus and Metrobus pages start collapsed. Tap the heading to open the alert list. Tap an alert in the list to expand its details; when you switch to another alert, the previous one closes. Tap the heading again to collapse the whole list.")}</p>
    </div>
    <div class="card stack">
      <h2>${t("Ana ekrana ekle", "Add to home screen")}</h2>
      <p class="muted">${t("iPhone: Paylaş → “Ana Ekrana Ekle”. Android/Chrome: menü → “Uygulamayı yükle”. Ana ekrandan açtığınızda uygulama tam ekran çalışır.", "iPhone: Share → “Add to Home Screen”. Android/Chrome: menu → “Install app”. When opened from the home screen, the app runs full screen.")}</p>
    </div>
    <div class="card stack">
      <h2>${t("Gizlilik", "Privacy")}</h2>
      <p class="muted">${t("Uygulama hesap açmanızı istemez. Konumunuz ve favorileriniz yalnızca cihazınızda saklanır. Uygulama, gösterdiği ulaşım bilgilerini almak dışında kişisel bilgi toplamaz.", "The app does not ask you to create an account. Your location and favorites are stored only on your device. The app does not collect personal information other than fetching the transit information it displays.")}</p>
    </div>`;
}

function renderNotFound() {
  view.innerHTML = `<div class="empty">${t("Aradığınız istasyon veya hat bulunamadı.", "The station or line you were looking for could not be found.")}<br><button class="dirchip" onclick="location.hash='#/ana'">${t("Ana sayfaya dön", "Back to home")}</button></div>`;
}

/* ---------------- yönlendirme ---------------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, query] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query || "");
  if (parts[0] === "istasyon" && parts[1]) return { name: "station", key: decodeURIComponent(parts[1]), line: params.get("hat") };
  if (parts[0] === "hat" && parts[1]) return { name: "line", code: decodeURIComponent(parts[1]) };
  if (parts[0] === "otobus") {
    if (parts[1] === "durak" && parts[2]) return { name: "busStop", code: decodeURIComponent(parts[2]), mode: "bus", line: params.get("hat") };
    if (parts[1] === "hat" && parts[2]) return { name: "busLine", code: decodeURIComponent(parts[2]), mode: "bus" };
    return { name: "bus" };
  }
  if (parts[0] === "metrobus") {
    if (parts[1] === "durak" && parts[2]) return {
      name: "busStop",
      code: decodeURIComponent(parts[2]),
      codes: (params.get("stops") || "").split(",").filter(Boolean).map(Number).filter(Number.isFinite),
      mode: "metrobus",
      line: params.get("hat"),
    };
    if (parts[1] === "hat" && parts[2]) return { name: "busLine", code: decodeURIComponent(parts[2]), mode: "metrobus" };
    return { name: "metrobus" };
  }
  if (parts[0] === "ara") return { name: "search" };
  if (parts[0] === "yolculuk") return { name: "journey" };
  if (parts[0] === "ayarlar") return { name: "settings" };
  if (parts[0] === "bilgi") return { name: "about" };
  return { name: "home" };
}

function parentHash(r = parseHash()) {
  if (r.name === "station") return r.line ? `#/hat/${encodeURIComponent(r.line)}` : "#/ana";
  if (r.name === "line") return "#/ana";
  if (r.name === "busStop") {
    if (r.line) {
      return `${r.mode === "metrobus" ? "#/metrobus" : "#/otobus"}/hat/${encodeURIComponent(r.line)}`;
    }
    return r.mode === "metrobus" ? "#/metrobus" : "#/otobus";
  }
  if (r.name === "busLine") return r.mode === "metrobus" ? "#/metrobus" : "#/otobus";
  if (r.name === "journey") return state.journeyParent || "#/ana";
  if (r.name === "settings") return state.settingsParent || "#/ana";
  if (r.name === "about") return "#/ayarlar";
  if (r.name === "search") return "#/ana";
  return null;
}

function navigate(hash, { replace = false } = {}) {
  if (!hash) return;
  if (replace) {
    if (location.hash === hash) {
      render();
      return;
    }
    history.replaceState(null, "", hash);
    render();
    return;
  }
  if (location.hash === hash) render();
  else location.hash = hash;
}

function go(hash) {
  navigate(hash);
}

function back() {
  const parent = parentHash();
  if (!parent) return;
  navigate(parent, { replace: true });
}

function render() {
  const r = parseHash();
  state.route = r;
  if (r.name !== "journey" && state.journey.activeField) {
    cancelJourneyPlaceRequest();
    state.journey.searchSeq += 1;
    state.journey.activeField = null;
    state.journey.searchLoading = false;
    state.journey.searchError = null;
    state.journey.places = [];
    state.journey.placesField = null;
    state.journey.placesQuery = "";
  }
  if (r.name !== "busStop") state.busStopFocus = null;
  $("#backBtn").hidden = ["home", "bus", "metrobus"].includes(r.name);
  const activeNav =
    r.mode === "metrobus" || r.name === "metrobus"
      ? "metrobus"
      : r.name === "station" || r.name === "line"
        ? "home"
        : r.name === "bus" || r.name === "busStop" || r.name === "busLine"
          ? "bus"
          : r.name;
  const pageTitle =
    {
      bus: t("Otobüs", "Bus"),
      metrobus: t("Metrobüs", "Metrobus"),
      search: t("Ara", "Search"),
      about: t("Bilgi", "About"),
      settings: t("Ayarlar", "Settings"),
      journey: t("Yolculuk", "Trip"),
    }[activeNav] || "Metro";
  $("#brandTitle").textContent = pageTitle;
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.nav === activeNav));
  const journeyBtn = $("#journeyBtn");
  journeyBtn.classList.toggle("active", activeNav === "journey");
  if (activeNav === "journey") journeyBtn.setAttribute("aria-current", "page");
  else journeyBtn.removeAttribute("aria-current");
  const settingsBtn = $("#settingsBtn");
  settingsBtn.classList.toggle("active", activeNav === "settings");
  if (activeNav === "settings") settingsBtn.setAttribute("aria-current", "page");
  else settingsBtn.removeAttribute("aria-current");
  if (!state.timetable) return renderLoading();
  if (r.name === "station") renderStation(r.key, r.line);
  else if (r.name === "line") renderLine(r.code);
  else if (r.name === "bus") renderBusHome();
  else if (r.name === "metrobus") renderMetrobusHome();
  else if (r.name === "busStop") renderBusStop(r.code);
  else if (r.name === "busLine") renderBusLine(r.code);
  else if (r.name === "journey") renderJourney();
  else if (r.name === "search") {
    renderSearchPage();
    setTimeout(() => $("#globalQ")?.focus(), 30);
  } else if (r.name === "settings") renderSettings();
  else if (r.name === "about") renderAbout();
  else renderHome();
}

/* ---------------- boot ---------------- */
async function boot() {
  renderLoading();
  try {
    state.location = JSON.parse(localStorage.getItem("sm.loc") || "null");
  } catch {}
  await Promise.all([loadTimetable(), loadBase(), loadBusData()]);
  // loadBase ve loadTimetable paralel çalıştığı için istasyon dizini ancak
  // ikisi de hazır olduktan sonra kurulmalı; aksi halde yarış koşulu oluşur.
  buildStationIndex();
  render();
  Promise.allSettled([loadStatuses(), loadBusAnnouncements()]).then(() => {
    if (!hasActiveSearch() && state.route.name !== "journey") render();
  });
  setInterval(() => {
    if (state.route.name === "station") render(); // geri sayımı tazele
  }, 15000);
  setInterval(() => {
    if (state.route.name === "busStop") refreshBusStop(state.route.codes?.length ? state.route.codes : state.route.code, { silent: true });
  }, 30000);
  setInterval(() => {
    if (document.visibilityState === "visible" && state.route.name === "busLine" && state.route.mode !== "metrobus") {
      refreshBusLineVehicles(state.route.code, { silent: true, force: true });
    }
  }, 20000);
  setInterval(() => {
    loadStatuses().then(() => {
      if (!hasActiveSearch() && state.route.name !== "journey") render();
    });
  }, 120000);
  setInterval(() => {
    loadBusAnnouncements().then(() => {
      if (!hasActiveSearch() && ["home", "bus", "metrobus"].includes(state.route.name)) render();
    });
  }, 300000);
}

window.addEventListener("hashchange", render);
$("#backBtn").addEventListener("click", back);

/* ---------------- kaydırarak geri ---------------- */
const swipeHint = $("#swipeBack");
let swipeState = null;

function swipeAllowed() {
  return !$("#backBtn").hidden;
}

function updateSwipeHint(progress) {
  if (!swipeHint) return;
  swipeHint.style.opacity = String(0.2 + progress * 0.8);
  swipeHint.style.transform = `translateY(-50%) scale(${0.82 + progress * 0.18})`;
}

function resetSwipeHint() {
  if (!swipeHint) return;
  swipeHint.style.opacity = "0";
  swipeHint.style.transform = "translateY(-50%) scale(.82)";
}

document.addEventListener(
  "touchstart",
  (event) => {
    if (event.touches.length !== 1 || !swipeAllowed()) return;
    const touch = event.touches[0];
    if (touch.clientX > SWIPE_EDGE_PX) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, .dirwrap, .ann-list, #backBtn, [data-no-swipe]")) return;
    swipeState = { id: touch.identifier, x: touch.clientX, y: touch.clientY, active: false };
  },
  { passive: true }
);

document.addEventListener(
  "touchmove",
  (event) => {
    if (!swipeState) return;
    const touch = [...event.touches].find((item) => item.identifier === swipeState.id) || event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - swipeState.x;
    const dy = touch.clientY - swipeState.y;
    if (!swipeState.active) {
      if (Math.abs(dy) > 60) {
        swipeState = null;
        resetSwipeHint();
        return;
      }
      if (dx < 12 || dx < Math.abs(dy) * 1.2) return;
      swipeState.active = true;
    }
    if (event.cancelable) event.preventDefault();
    updateSwipeHint(Math.min(1, Math.max(0, dx / SWIPE_THRESHOLD_PX)));
  },
  { passive: false }
);

function endSwipe(event) {
  if (!swipeState) return;
  const touch = event.changedTouches?.[0];
  const dx = touch ? touch.clientX - swipeState.x : 0;
  const active = swipeState.active;
  swipeState = null;
  resetSwipeHint();
  if (active && dx >= SWIPE_THRESHOLD_PX) back();
}
document.addEventListener("touchend", endSwipe);
document.addEventListener("touchcancel", endSwipe);

const NAV = { bus: "#/otobus", home: "#/ana", metrobus: "#/metrobus" };
$("#journeyBtn").addEventListener("click", () => {
  if (state.route.name !== "journey") state.journeyParent = location.hash || "#/ana";
  if (state.route.name === "journey") window.scrollTo({ top: 0, behavior: "smooth" });
  else go("#/yolculuk");
});
$("#settingsBtn").addEventListener("click", () => {
  if (state.route.name !== "settings") state.settingsParent = location.hash || "#/ana";
  go("#/ayarlar");
});
document.addEventListener("click", (event) => {
  if (!state.journey.activeField) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".journey-card, .journey-suggestions")) return;
  closeJourneySuggestions();
});
document.querySelectorAll(".tabbar button").forEach((b) =>
  b.addEventListener("click", () => go(NAV[b.dataset.nav] || "#/ana"))
);

const isViteDev = location.port === "5173" || location.port === "5174";
if ("serviceWorker" in navigator) {
  if (isViteDev) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
    if ("caches" in window) {
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key.startsWith("siradaki-metro-")).map((key) => caches.delete(key))))
        .catch(() => {});
    }
  } else {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW:", e)));
  }
}

window.addEventListener("online", () => toast(t("Çevrimiçi", "Online")));
window.addEventListener("offline", () => toast(t("Çevrimdışı — tarife paketinden gösteriliyor", "Offline — showing the bundled timetable")));

boot();
