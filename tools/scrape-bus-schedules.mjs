#!/usr/bin/env node
/**
 * İETT planlanan otobüs sefer saatlerini statik JSON kataloğuna indirir.
 * Çalıştırma: node tools/scrape-bus-schedules.mjs [--concurrency=6]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const SERVICE = "https://api.ibb.gov.tr/iett/UlasimAnaVeri/PlanlananSeferSaati.asmx";
const ACTION = "GetPlanlananSeferSaati_json";
const concurrency = Math.max(1, Math.min(12, Number(process.argv.find((arg) => arg.startsWith("--concurrency="))?.split("=")[1]) || 6));

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const decodeEntities = (value) => String(value ?? "")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function parseSchedule(xml, code) {
  const result = xml.match(/<GetPlanlananSeferSaati_jsonResult>([\s\S]*?)<\/GetPlanlananSeferSaati_jsonResult>/i)?.[1];
  if (result == null) throw new Error("Sefer saati sonucu bulunamadı");
  const raw = JSON.parse(decodeEntities(result));
  const sets = { I: { G: new Set(), D: new Set() }, C: { G: new Set(), D: new Set() }, P: { G: new Set(), D: new Set() } };
  let name = "";
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!name) name = clean(item.HATADI || "");
    const day = String(item.SGUNTIPI || "").toUpperCase();
    const direction = String(item.SYON || "").toUpperCase();
    const time = clean(item.DT);
    if (sets[day]?.[direction] && /^\d{1,2}:\d{2}$/.test(time)) sets[day][direction].add(time.padStart(5, "0"));
  }
  const days = { I: {}, C: {}, P: {} };
  for (const day of Object.keys(days)) for (const direction of ["G", "D"]) {
    const times = [...sets[day][direction]].sort();
    if (times.length) days[day][direction] = { times, count: times.length, first: times[0], last: times.at(-1) };
  }
  return { code, name: name || code, days };
}

async function fetchSchedule(code) {
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${ACTION} xmlns="http://tempuri.org/"><HatKodu>${code.replace(/[<>&"']/g, "")}</HatKodu></${ACTION}></soap:Body></soap:Envelope>`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(SERVICE, {
        method: "POST",
        headers: { "content-type": "text/xml; charset=utf-8", SOAPAction: `"http://tempuri.org/${ACTION}"`, "user-agent": "siradaki-metro/1.0" },
        body,
        signal: controller.signal,
      });
      const xml = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseSchedule(xml, code);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function main() {
  const catalog = JSON.parse(await readFile(join(DATA, "bus-lines.json"), "utf8"));
  const lines = (catalog.lines || []).map(([code]) => String(code)).filter(Boolean);
  if (!lines.length) throw new Error("data/bus-lines.json içinde hat yok; önce npm run scrape:bus çalıştırın.");
  const schedules = {};
  const errors = [];
  let next = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, lines.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= lines.length) return;
      const code = lines[index];
      try { schedules[code] = await fetchSchedule(code); }
      catch (error) { errors.push({ code, error: String(error?.message || error) }); }
      completed++;
      if (completed % 25 === 0 || completed === lines.length) console.log(`${completed}/${lines.length} hat işlendi; ${errors.length} hata`);
    }
  });
  await Promise.all(workers);
  if (!Object.keys(schedules).length) throw new Error("Hiçbir hat için sefer saati alınamadı; mevcut dosya korunuyor.");
  const output = { generatedAt: new Date().toISOString(), source: SERVICE, lineCount: lines.length, scheduleCount: Object.keys(schedules).length, errors, lines: schedules };
  await writeFile(join(DATA, "bus-schedules.json"), JSON.stringify(output));
  console.log(`data/bus-schedules.json yazıldı (${output.scheduleCount}/${lines.length} hat, ${errors.length} hata).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
