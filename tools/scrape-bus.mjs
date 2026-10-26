#!/usr/bin/env node
/**
 * Sıradaki Metro — İETT otobüs verisi çekici
 *
 * İBB'nin resmî İETT SOAP servislerinden otobüs hatlarını ve duraklarını
 * indirir; uygulamanın arama yapabilmesi için küçük, sıkıştırılabilir JSON
 * dosyalarına dönüştürür.
 *
 * Çalıştırma:  node tools/scrape-bus.mjs
 *
 * Kaynaklar:
 *   https://api.ibb.gov.tr/iett/UlasimAnaVeri/HatDurakGuzergah.asmx
 *     - GetHat_json   → tüm otobüs hatları
 *     - GetDurak_json → tüm otobüs durakları
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "data");
const SERVICE = "https://api.ibb.gov.tr/iett/UlasimAnaVeri/HatDurakGuzergah.asmx";
const SOURCE = `${SERVICE}?wsdl`;

const l = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function envelope(action, inner) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${inner}</soap:Body>
</soap:Envelope>`;
}

async function soap(action, inner, { timeout = 60000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(SERVICE, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        SOAPAction: `"http://tempuri.org/${action}"`,
        "user-agent": "siradaki-metro/1.0 (+https://github.com/)",
      },
      body: envelope(action, inner),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${action} → HTTP ${res.status}: ${text.slice(0, 180)}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

function resultOf(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) throw new Error(`${tag} sonucu bulunamadı`);
  return m[1];
}

function parsePoint(s) {
  const m = String(s || "").match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  if (!m) return { lat: null, lng: null };
  return { lng: +(+m[1]).toFixed(5), lat: +(+m[2]).toFixed(5) };
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// İETT kaynağında ilçe adları çoğunlukla ASCII yazılıyor (Beyoglu, Besiktas…).
// Arama etkilenmesin diye yalnızca görünen adı düzeltiyoruz; norm() zaten
// Türkçe karakterleri sadeleştiriyor.
const DISTRICT_NAMES = new Map([
  ["adalar", "Adalar"],
  ["arnavutköy", "Arnavutköy"],
  ["atasehir", "Ataşehir"],
  ["avcilar", "Avcılar"],
  ["bagcilar", "Bağcılar"],
  ["bahçelievler", "Bahçelievler"],
  ["bakirköy", "Bakırköy"],
  ["basaksehir", "Başakşehir"],
  ["bayrampasa", "Bayrampaşa"],
  ["besiktas", "Beşiktaş"],
  ["beykoz", "Beykoz"],
  ["beylikdüzü", "Beylikdüzü"],
  ["beyoglu", "Beyoğlu"],
  ["büyükçekmece", "Büyükçekmece"],
  ["çatalca", "Çatalca"],
  ["çayirova", "Çayırova"],
  ["çekmeköy", "Çekmeköy"],
  ["darica", "Darıca"],
  ["esenler", "Esenler"],
  ["esenyurt", "Esenyurt"],
  ["eyüpsultan", "Eyüpsultan"],
  ["fatih", "Fatih"],
  ["gaziosmanpasa", "Gaziosmanpaşa"],
  ["gebze", "Gebze"],
  ["güngören", "Güngören"],
  ["kadiköy", "Kadıköy"],
  ["kagithane", "Kağıthane"],
  ["kartal", "Kartal"],
  ["küçükçekmece", "Küçükçekmece"],
  ["maltepe", "Maltepe"],
  ["pendik", "Pendik"],
  ["sancaktepe", "Sancaktepe"],
  ["sariyer", "Sarıyer"],
  ["sile", "Şile"],
  ["silivri", "Silivri"],
  ["sisli", "Şişli"],
  ["sultanbeyli", "Sultanbeyli"],
  ["sultangazi", "Sultangazi"],
  ["tuzla", "Tuzla"],
  ["ümraniye", "Ümraniye"],
  ["üsküdar", "Üsküdar"],
  ["zeytinburnu", "Zeytinburnu"],
]);

const districtName = (s) => {
  const raw = clean(s);
  return DISTRICT_NAMES.get(raw.toLocaleLowerCase("tr")) || raw;
};

async function withRetry(fn, label, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      l(`${label} denemesi ${i}/${attempts} başarısız: ${e.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw last;
}

async function main() {
  await mkdir(DATA, { recursive: true });

  l("İETT hat listesi alınıyor…");
  const hatXml = await withRetry(
    () => soap("GetHat_json", `<GetHat_json xmlns="http://tempuri.org/"><HatKodu></HatKodu></GetHat_json>`),
    "GetHat_json"
  );
  const hatRaw = JSON.parse(resultOf(hatXml, "GetHat_jsonResult"));

  const lines = hatRaw
    .map((x) => ({
      code: clean(x.SHATKODU),
      name: clean(x.SHATADI),
      tariff: clean(x.TARIFE),
      length: x.HAT_UZUNLUGU != null ? +(+x.HAT_UZUNLUGU).toFixed(2) : null,
      duration: x.SEFER_SURESI != null ? +(+x.SEFER_SURESI).toFixed(0) : null,
    }))
    .filter((x) => x.code)
    .sort((a, b) => a.code.localeCompare(b.code, "tr", { numeric: true }));

  l(`  ${lines.length} hat alındı`);

  l("İETT durak listesi alınıyor (bu biraz sürebilir)…");
  const durakXml = await withRetry(
    () => soap("GetDurak_json", `<GetDurak_json xmlns="http://tempuri.org/"><DurakKodu></DurakKodu></GetDurak_json>`),
    "GetDurak_json"
  );
  const durakRaw = JSON.parse(resultOf(durakXml, "GetDurak_jsonResult"));

  const stops = durakRaw
    .map((x) => {
      const { lat, lng } = parsePoint(x.KOORDINAT);
      return {
        code: Number(x.SDURAKKODU),
        name: clean(x.SDURAKADI),
        district: districtName(x.ILCEADI),
        direction: clean(x.SYON),
        lat,
        lng,
      };
    })
    .filter((x) => Number.isFinite(x.code) && x.name)
    .sort((a, b) => a.code - b.code);

  l(`  ${stops.length} durak alındı`);

  const generatedAt = new Date().toISOString();

  await writeFile(
    join(DATA, "bus-lines.json"),
    JSON.stringify({
      generatedAt,
      source: SOURCE,
      lines: lines.map((x) => [x.code, x.name, x.tariff, x.length, x.duration]),
    })
  );

  await writeFile(
    join(DATA, "bus-stops.json"),
    JSON.stringify({
      generatedAt,
      source: SOURCE,
      stops: stops.map((x) => [x.code, x.name, x.district, x.direction, x.lat, x.lng]),
    })
  );

  l(`data/bus-lines.json ve data/bus-stops.json yazıldı (${lines.length} hat, ${stops.length} durak).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
