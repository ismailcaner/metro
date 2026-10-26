import { chromium } from "playwright";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  locale: "tr-TR",
  serviceWorkers: "block",
});

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

async function setLocation(loc) {
  await page.evaluate((value) => localStorage.setItem("sm.loc", JSON.stringify(value)), loc);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
}

async function clearLocation() {
  await page.evaluate(() => localStorage.removeItem("sm.loc"));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
}

try {
  await page.goto("http://127.0.0.1:5173/#/ana", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#homeExtras", { timeout: 30000 });
  check("Metro ana sayfasında yakınımdakiler yok", !/Yakınımdaki/i.test(await page.locator("body").innerText()));
  await page.screenshot({ path: "screenshots/metro-home-no-nearby.png" });

  await page.goto("http://127.0.0.1:5173/#/otobus", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#busExtras", { timeout: 30000 });
  check("Otobüs ana sayfasında yakınımdakiler yok", !/Yakınımdaki/i.test(await page.locator("body").innerText()));
  check("Otobüs araması korunuyor", (await page.locator("#busQ").count()) === 1);
  await page.screenshot({ path: "screenshots/otobus-home-no-nearby.png" });

  await page.goto("http://127.0.0.1:5173/#/metrobus", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#metrobusExtras", { timeout: 30000 });
  check("Metrobüs ana sayfasında yakınımdakiler yok", !/Yakınımdaki/i.test(await page.locator("body").innerText()));
  check("Metrobüs araması kaldırılmış", (await page.locator("#metrobusQ").count()) === 0);
  await page.screenshot({ path: "screenshots/metrobus-home-no-nearby.png" });

  await page.goto("http://127.0.0.1:5173/#/hat/M7", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(() => localStorage.setItem("sm.loc", JSON.stringify({ lat: 41.0661411, lng: 28.9945802 })));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".near-stop-label", { timeout: 30000 });
  const metroNearest = await page.evaluate(() => {
    const label = document.querySelector(".near-stop-label");
    const row = label?.nextElementSibling;
    return {
      label: label?.textContent?.trim() || "",
      row: row?.innerText?.replace(/\n/g, " | ") || "",
      rowClass: row?.className || "",
    };
  });
  check("M7 listesinde tahmini konum etiketi var", /Tahmini konumunuz/i.test(metroNearest.label), metroNearest.label);
  check("Etiket en yakın durağın hemen üstünde", /Mecidiyeköy/i.test(metroNearest.row) && /nearest-stop/.test(metroNearest.rowClass), metroNearest.row);
  check("M7 listesinde eski yakınımdakiler yok", !/Yakınımdaki/i.test(await page.locator("body").innerText()));
  await page.screenshot({ path: "screenshots/metro-line-nearest.png" });

  await page.goto("http://127.0.0.1:5173/#/metrobus/hat/34", { waitUntil: "domcontentloaded", timeout: 60000 });
  await setLocation({ lat: 40.992322, lng: 28.834679 });
  await page.waitForSelector("#busLineBody .near-stop-label", { timeout: 30000 });
  const metroBusNearest = await page.evaluate(() => {
    const label = document.querySelector("#busLineBody .near-stop-label");
    const row = label?.nextElementSibling;
    return {
      label: label?.textContent?.trim() || "",
      row: row?.innerText?.replace(/\n/g, " | ") || "",
    };
  });
  check("Metrobüs hattında tahmini konum etiketi var", /Tahmini konumunuz/i.test(metroBusNearest.label), metroBusNearest.label);
  check("Metrobüs etiketi en yakın durağın üstünde", /YENİBOSNA/i.test(metroBusNearest.row), metroBusNearest.row);
  check("Metrobüs hattında canlı araç işareti yok", (await page.locator("#busLineBody .line-stop-row.current-stop").count()) === 0);
  check("Metrobüs hattında canlı araç lejantı yok", (await page.locator("#busLineLegend, #busLineLiveStatus").count()) === 0);
  await page.screenshot({ path: "screenshots/metrobus-line-nearest-no-live.png" });

  await page.goto("http://127.0.0.1:5173/#/hat/M7", { waitUntil: "domcontentloaded", timeout: 60000 });
  await clearLocation();
  await page.waitForSelector(".line-location-prompt", { timeout: 30000 });
  check("Konum yokken hat sayfasında konum istemi var", (await page.locator("#lineLocBtn").count()) === 1);
  check("Konum yokken tahmini konum etiketi yok", (await page.locator(".near-stop-label").count()) === 0);

  await page.goto("http://127.0.0.1:5173/#/ayarlar", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#locToggle", { timeout: 30000 });
  const settingsText = await page.locator("body").innerText();
  check("Ayarlar metni yeni konum amacını anlatıyor", /en yakın durağı (göstermek|işaretlemek)/i.test(settingsText));
  check("Ayarlarda yakınımdakiler ifadesi yok", !/Yakınımdaki/i.test(settingsText));

  for (const width of [390, 320]) {
    await page.goto("http://127.0.0.1:5173/#/hat/M7", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.setViewportSize({ width, height: width === 320 ? 700 : 844 });
    await page.waitForSelector("#lineStations", { timeout: 30000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${width}px yatay taşma yok`, overflow <= 1, `${overflow}px`);
  }

  check("Konsol / sayfa hatası yok", errors.length === 0, errors.join(" || "));
} catch (err) {
  check("Test çalıştı", false, err.stack || String(err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} kontrol başarılı`);
if (failed.length) process.exitCode = 1;
