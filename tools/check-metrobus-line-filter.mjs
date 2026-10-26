import { chromium } from "playwright";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  locale: "tr-TR",
  serviceWorkers: "block",
});
const page = await context.newPage();

const mixedArrivals = [
  { line: "34G", destination: "SÖĞÜTLÜÇEŞME - B.SONDURAK", clock: "12:55", minutes: 1, status: "live", note: null },
  { line: "34", destination: "AVCILAR - ZİNCİRLİKUYU", clock: "12:57", minutes: 3, status: "live", note: null },
  { line: "34AS", destination: "AVCILAR - SÖĞÜTLÜÇEŞME", clock: "12:58", minutes: 4, status: "live", note: null },
  { line: "34", destination: "AVCILAR - ZİNCİRLİKUYU", clock: "12:57", minutes: 3, status: "live", note: null },
  { line: "34", destination: "AVCILAR - ZİNCİRLİKUYU", clock: "13:02", minutes: 8, status: "live", note: null },
  { line: "34BZ", destination: "B.SONDURAK - ZİNCİRLİKUYU", clock: "13:03", minutes: 9, status: "live", note: null },
];

await page.route("**/api/bus?type=stop**", async (route) => {
  const url = new URL(route.request().url());
  if (url.searchParams.get("code") !== "900333") return route.continue();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      code: "900333",
      arrivals: mixedArrivals,
      notes: "Test verisi",
      fetchedAt: new Date().toISOString(),
    }),
  });
});

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

try {
  await page.goto("http://127.0.0.1:5173/#/metrobus", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#metrobusExtras [data-bus-line='34']", { timeout: 30000 });
  await page.locator("#metrobusExtras [data-bus-line='34']").click();
  await page.waitForSelector("#busLineBody .line-stop-row", { timeout: 30000 });

  check("34 hattı 27 durağı gösteriyor", (await page.locator("#busLineBody .line-stop-row").count()) === 27);
  check("Metrobüs hattında canlı araç lejantı yok", (await page.locator("#busLineLegend").count()) === 0);
  check("Metrobüs hattında canlı araç durumu yok", (await page.locator("#busLineLiveStatus").count()) === 0);
  check("Metrobüs hattında canlı araç işareti yok", (await page.locator("#busLineBody .line-stop-row.current-stop").count()) === 0);

  await page.locator("#busLineBody .line-stop-row").first().click();
  await page.waitForSelector("#busLive .bus-arrival", { timeout: 30000 });
  const liveText = await page.locator("#busLive").innerText();
  const arrivalCount = await page.locator("#busLive .bus-arrival").count();
  check("Durakta yalnızca 34 hattı başlığı var", /34 · sıradaki seferler/.test(liveText), liveText.split("\n").slice(0, 3).join(" | "));
  check("Durakta yalnızca 34 hattı var", !/34G|34AS|34BZ/.test(liveText), liveText.replace(/\n/g, " | "));
  check("34 varışları tekrarsız gösteriliyor", arrivalCount === 2, `${arrivalCount} satır`);
  check("34 varış dakikaları görünüyor", /\b3 dk\b/.test(liveText) && /\b8 dk\b/.test(liveText), liveText.replace(/\n/g, " | "));
  check("Diğer hatlar için geçiş düğmesi var", (await page.locator("#busAllLines").count()) === 1);

  await page.evaluate(() => localStorage.setItem("sm.loc", JSON.stringify({ lat: 41.038496 + 0.00072, lng: 28.985783 })));
  await page.goto("http://127.0.0.1:5173/#/hat/M2", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#lineStations .station-row", { timeout: 30000 });
  check("Metroda 100 m içindeki durak işaretleniyor", (await page.locator(".near-stop-label").count()) === 1);

  await page.evaluate(() => localStorage.setItem("sm.loc", JSON.stringify({ lat: 41.038496 + 0.0027, lng: 28.985783 })));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#lineStations .station-row", { timeout: 30000 });
  check("Metroda 100 m dışındaki durak işaretlenmiyor", (await page.locator(".near-stop-label").count()) === 0);

  for (const [width, height] of [[390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
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
