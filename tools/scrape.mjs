#!/usr/bin/env node
/**
 * Sıradaki Metro — veri çekici
 *
 * Metro İstanbul'un kendi sitesindeki "Sefer Tarifeleri" ekranının arka plan
 * servisinden (AJAXSeferGetir) tüm hat/istasyon/yön kombinasyonları için
 * günlük kalkış saatlerini çeker; resmî API'den hat + istasyon verisini alır.
 *
 * Çalıştırma:  node tools/scrape.mjs [--headed]
 *
 * Not: Metro İstanbul sitesi bir WAF (Corpowid) arkasında. Tarife uç noktası
 * yalnızca gerçek bir tarayıcı oturumunda çalıştığı için Playwright kullanılır.
 */
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "data");

const API = "https://api.ibb.gov.tr/MetroIstanbul/api/MetroMobile/V2";
const PAGE = "https://www.metro.istanbul/SeferDurumlari/SeferDetaylari";
const CONCURRENCY = 6;

const l = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Örnek gün seçimi: bugünden ileriye doğru ilk uygun (hafta içi / cumartesi / pazar) */
function sampleDates(from = new Date()) {
  const d = (offset) => {
    const x = new Date(from);
    x.setDate(x.getDate() + offset);
    return x;
  };
  const fmt = (x) =>
    `${String(x.getDate()).padStart(2, "0")}.${String(x.getMonth() + 1).padStart(2, "0")}.${x.getFullYear()}`;
  let wd = null, sat = null, sun = null;
  for (let i = 0; i <= 8 && !(wd && sat && sun); i++) {
    const x = d(i);
    const day = x.getDay(); // 0 Pazar, 6 Cumartesi
    if (day === 6 && !sat) sat = fmt(x);
    else if (day === 0 && !sun) sun = fmt(x);
    else if (day >= 1 && day <= 4 && !wd) wd = fmt(x); // Pazartesi-Perşembe
  }
  return { wd, sat, sun };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const j = await r.json();
  if (!j.Success) throw new Error(`${url} -> Success=false: ${JSON.stringify(j.Error)}`);
  return j.Data;
}

/** Sayfa içinde toplu tarife çekimi (tarayıcı oturumu + WAF çerezleri ile) */
async function scrapeTimeTables(page, jobs, dates, onProgress) {
  return page.evaluate(
    async ({ jobs, dates, concurrency }) => {
      // WAF'ı geçmiş oturumdan taze "kod" değerini al
      const html = await (await fetch(location.href)).text();
      const m = html.match(/formData\.append\("kod",\s*'([^']+)'\)/);
      const kod = m ? m[1] : "108f477a-4026-433a-a6ec-53ee00d4a7c5";

      const call = async (job) => {
        const out = { ...job, times: {} };
        for (const [dayType, date] of Object.entries(dates)) {
          const fd = new FormData();
          const fields = {
            secim: "3",
            saat: "",
            dakika: "",
            tarih1: "",
            tarih2: date,
            station: String(job.stationId),
            route: String(job.seferId),
            kod,
          };
          for (const [k, v] of Object.entries(fields)) fd.append(k, v);
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const r = await fetch("/SeferDurumlari/AJAXSeferGetir", { method: "POST", body: fd });
              const j = await r.json();
              if (j.durum !== "0") throw new Error(j.bilgi || "durum!=0");
              out.times[dayType] = (j.sefer || []).map((s) => s.zaman);
              break;
            } catch (err) {
              if (attempt === 2) out.times[dayType] = { error: String(err) };
              else await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            }
          }
        }
        return out;
      };

      const results = [];
      let i = 0, done = 0;
      const worker = async () => {
        while (i < jobs.length) {
          const job = jobs[i++];
          results.push(await call(job));
          done++;
          window.__scrapeProgress = done;
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      return results;
    },
    { jobs, dates, concurrency: CONCURRENCY }
  ).then(async (res) => {
    // ilerleme raporu sayfa içinden okunur
    return res;
  });
}

async function main() {
  const headed = process.argv.includes("--headed");
  await mkdir(DATA, { recursive: true });

  l("Resmî API'den hatlar ve istasyonlar alınıyor…");
  const [linesRaw, stationsRaw] = await Promise.all([fetchJson(`${API}/GetLines`), fetchJson(`${API}/GetStations`)]);
  const lines = linesRaw.map((x) => {
    const c = x.Color;
    const rgb = c && typeof c === "object" ? [c.Color_R, c.Color_G, c.Color_B] : String(c || "").match(/\d+/g);
    return {
      id: Number(x.Id),
      code: x.Name,
      name: x.LongDescription,
      short: x.ShortDescription,
      color: rgb && rgb.length >= 3 ? `rgb(${+rgb[0]},${+rgb[1]},${+rgb[2]})` : null,
      first: x.FirstTime,
      last: x.LastTime,
    };
  });
  const stations = stationsRaw.map((s) => ({
    id: Number(s.Id),
    code: s.LineName, // hat kodu
    name: s.Description,
    line: s.LineName,
    order: s.Order,
    lat: s.DetailInfo ? Number(s.DetailInfo.Latitude) : null,
    lng: s.DetailInfo ? Number(s.DetailInfo.Longitude) : null,
    info: s.DetailInfo || null,
  }));
  l(`  ${lines.length} hat, ${stations.length} istasyon`);

  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage({ locale: "tr-TR" });
  l("Tarife sayfası açılıyor…");
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !!document.querySelector('select[id^="istasyonlar_"]'), null, { timeout: 60000 });

  // Sayfadaki gizli seçimlerden hat / istasyon / yön haritasını çıkar
  const map = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[onclick^="changeTheElements("]')];
    const hatIds = [];
    links.forEach((a) => {
      const id = Number((a.getAttribute("onclick").match(/\d+/) || [0])[0]);
      if (id && !hatIds.includes(id)) hatIds.push(id);
    });
    const lines = hatIds.map((hatId) => {
      const code = (links.find((a) => a.getAttribute("onclick") === `changeTheElements(${hatId});`)?.textContent || "")
        .trim()
        .replace(/\s+/g, " ");
      const stationSel = document.getElementById("istasyonlar_" + hatId);
      const routeSel = document.getElementById("seferler_" + hatId);
      const stopSel = document.getElementById("seferduraklari_" + hatId);
      return {
        hatId,
        code,
        stations: stationSel ? [...stationSel.options].filter((o) => o.value).map((o) => ({ id: Number(o.value), name: o.textContent.trim() })) : [],
        routes: routeSel ? [...routeSel.options].filter((o) => o.value).map((o) => ({ id: Number(o.value), name: o.textContent.trim() })) : [],
        stops: stopSel
          ? [...stopSel.options].filter((o) => o.dataset.seferid).map((o) => ({ seferId: Number(o.dataset.seferid), stationId: Number(o.dataset.istasyonid) }))
          : [],
      };
    });
    return lines;
  });

  const uniqueStops = new Map();
  for (const ln of map) for (const s of ln.stops) uniqueStops.set(`${ln.hatId}|${s.seferId}|${s.stationId}`, { hatId: ln.hatId, ...s });
  const jobs = [...uniqueStops.values()];
  const dates = sampleDates();
  l(`Örnek günler: hafta içi=${dates.wd}, cumartesi=${dates.sat}, pazar=${dates.sun}`);
  l(`${jobs.length} durak-yön kombinasyonu × 3 gün tipi çekiliyor…`);

  const t0 = Date.now();
  const results = await scrapeTimeTables(page, jobs, dates);
  l(`Tarifeler alındı (${((Date.now() - t0) / 1000).toFixed(0)} sn)`);

  // Sonuçları hat/istasyon/yön ağacına dönüştür
  const out = {};
  for (const ln of map) {
    const entry = { code: ln.code, stations: {} };
    for (const st of ln.stations) {
      const dirs = {};
      for (const r of ln.routes) {
        const key = `${ln.hatId}|${r.id}|${st.id}`;
        const res = results.find((x) => `${x.hatId}|${x.seferId}|${x.stationId}` === key);
        if (!res) continue;
        const times = {};
        for (const [dt, v] of Object.entries(res.times)) if (Array.isArray(v) && v.length) times[dt] = v;
        if (Object.keys(times).length) {
          dirs[r.id] = { to: r.name.split("-->>").pop().trim(), from: r.name.split("-->>")[0].trim(), times };
        }
      }
      if (Object.keys(dirs).length) entry.stations[st.id] = { name: st.name, dirs };
    }
    if (Object.keys(entry.stations).length) out[ln.code] = entry;
  }

  const errors = results.filter((r) => Object.values(r.times).some((t) => !Array.isArray(t))).length;
  const totalStops = Object.values(out).reduce((n, l2) => n + Object.values(l2.stations).reduce((m, s) => m + Object.keys(s.dirs).length, 0), 0);
  l(`Özet: ${Object.keys(out).length} hat, ${totalStops} durak-yön, ${errors} hatalı istek`);

  await writeFile(join(DATA, "lines.json"), JSON.stringify({ generatedAt: new Date().toISOString(), source: `${API}/GetLines`, lines }, null, 1));
  await writeFile(join(DATA, "stations.json"), JSON.stringify({ generatedAt: new Date().toISOString(), source: `${API}/GetStations`, stations }, null, 1));
  await writeFile(
    join(DATA, "timetable.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), dayTypes: dates, source: "https://www.metro.istanbul/SeferDurumlari/SeferDetaylari", lines: out })
  );
  await writeFile(
    join(DATA, "meta.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), dayTypes: dates, lineCount: Object.keys(out).length, stopCount: totalStops, errors }, null, 1)
  );
  l("data/timetable.json, data/lines.json, data/stations.json yazıldı.");
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
