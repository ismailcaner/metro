/* İstanbul Ulaşım — service worker: kabuk önbellek + akıllı veri stratejisi */
const VERSION = "v44-route-metrics-inline";
const CACHE = `siradaki-metro-${VERSION}`;

const scope = self.registration.scope;
const shell = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "route-engine.js",
  "manifest.webmanifest",
  "manifest.en.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "data/timetable.json",
  "data/lines.json",
  "data/stations.json",
  "data/bus-lines.json",
  "data/bus-stops.json",
  "data/bus-line-stops.json",
  "data/bus-schedules.json",
].map((p) => new URL(p, scope).toString());

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(shell)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scopeOrigin = new URL(scope).origin;

  // Resmî İBB Metro API artık kendi origin'imizdeki /api/metro üzerinden
  // sunucu tarafında çağrılır; aşağıdaki /api/ kuralı devreye girer.

  if (url.origin !== scopeOrigin) return;

  // Canlı İETT köprüsü: her zaman ağdan; önbelleğe alma
  if (url.pathname.includes("/api/")) return;

  // Tarife/istasyon verisi: önce önbellek, arka planda tazele
  if (url.pathname.includes("/data/")) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const fresh = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
          .catch(() => hit);
        return hit || fresh;
      })
    );
    return;
  }

  // Kabuk ve diğer statik dosyalar: önbellekten ver, arka planda tazele
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit || caches.match(new URL("index.html", scope).toString()));
      return hit || fresh;
    })
  );
});
