# İstanbul Ulaşım

İstanbul metro, tramvay, füniküler, teleferik, **metrobüs** ve **İETT otobüsleri** için “sıradaki sefer kaç dakika sonra?” sorusunu yanıtlayan, kurulabilir (PWA) ve çevrimdışı çalışabilen bir uygulama.

Alt menüde üç sekme vardır: **Otobüs**, **Metro**, **Metrobüs**. Üç sekmedeki arama da yalnızca kendi modunun sonuçlarını gösterir; Metrobüs sekmesinde hat veya durak araması yapılabilir. Konum izni verildiğinde Otobüs sekmesinde size en yakın **üç otobüs durağı**, Metro ve Metrobüs sekmelerinde ise size en yakın üç hat ve bu hatların en yakın durakları gösterilir. Otobüs durağına dokunduğunuzda duraktan geçen hatlar ve canlı varış süreleri listelenir; bir hatta dokunduğunuzda o hattın tüm durakları açılır. Hat sayfasındaki başlık kartına dokunarak **planlanan sefer saatlerini** (ilk/son sefer ve saat saat kalkışlar) görebilirsiniz. Sağ üstteki **Yolculuğa çık** düğmesi iki nokta arasındaki **planlanan yolculuk rotasını** açar; **⚙** düğmesi ise **Ayarlar** ekranına götürür. Konum izni ve tema Ayarlar’dan yönetilir, **Bilgi** ekranına da bu ekranın altındaki düğmeyle geçilir.

Yolculuğa çık ekranında:

- Konum izni varsa başlangıç otomatik olarak mevcut konumunuz olur; yoksa **Başlangıç** alanına nereden yola çıkacağınızı yazarsınız.
- Başlangıç ve varış alanlarında duraklar yerel katalogda; İstanbul’daki semt, adres ve mekânlar projedeki yerel OpenStreetMap arama indeksinde aranır (ör. **Kadıköy**, **Taksim Meydanı**, **Nişantaşı kahve**). Mekân aramak için semt ile mekân türünü birlikte yazabilirsiniz.
- İki nokta seçildiğinde İETT **Nasıl Giderim** planlayıcısından gelen seçenekler; binilecek hatlar, iniş/aktarma noktaları, yürüyüşler, planlanan kalkış–varış saatleri ve aktarma sayısıyla gösterilir.
- Duraklar ve mekânlar yerel veriden aranır; yer araması internet servisine çıkmaz.
- Bu ekrandaki saatler **planlanan tarifeye** dayanır; canlı araç konumu veya gerçek zamanlı varış tahmini değildir.

Ayarlar ekranında:

- Konum iznini aç/kapat
- Tema seçimi: **Cihaz**, **Açık**, **Koyu**
- En altta **Bilgi** ekranına geçiş düğmesi

```
┌────────────────────────────┐
│  Metro                     │
│  İstanbul metro, metrobüs… │
│                            │
│  Yenikapı        M1A M1B M2│
│  M2 · sıradaki seferler    │
│  ▸ Hacıosman               │
│  Kalkış          19:45     │
│  7 dk            19:52     │
└────────────────────────────┘
```

## Teknoloji

- Vanilla JS + CSS (aktif arayüz)
- Vite 8 geliştirme/build
- Node.js tabanlı `/api/bus` köprüsü
- Vite build + service worker ile PWA

React/Vite arayüzü `react-ui-backup/` altında yedek olarak saklanır. Aktif giriş noktası kök `index.html`; uygulama kodu `public/app.js` ve `public/styles.css` içindedir.

## Hızlı başlangıç

Node 20.19+ ya da 22.12+ (Vite 8 için) gerekir.

```bash
npm install
npm run dev
```

`npm run dev`, iki süreci birlikte başlatır:

- Vite geliştirme sunucusu → `http://localhost:5173`
- İETT `/api/bus` köprüsü → `http://127.0.0.1:4173`

Vite, `/api` isteklerini 4173’teki API sunucusuna yönlendirir. Geliştirme sırasında tarayıcıda **5173** adresini açın.

Üretim derlemesi:

```bash
npm run build     # dist/ üretir, data/ kataloğunu da dist/data içine kopyalar
npm start         # dist/ + /api/bus → http://127.0.0.1:4173
```

`npm start`, önce `npm run build` yapılmasını bekler. Service worker, Vite geliştirme portlarında (5173/5174) devre dışıdır; üretim sunucusunda devreye girer.

Telefondan aynı ağ üzerinden denemek için: `npm run dev:lan` (Vite’ı `0.0.0.0` üzerinde açar; güvenlik duvarınızı açık bırakmayın).

## Nereden besleniyor?

| Veri | Kaynak | Canlı mı? |
|---|---|---|
| Raylı sistem hatları ve istasyon sıraları | `data/rail-network.json` (Metro İstanbul ağ haritasından derlenen yerel katalog) | 📦 Statik dosya; metro API çağrısı yok |
| Metro istasyon koordinatları ve erişilebilirlik bilgisi | `data/stations.json` yerel koordinat anlık görüntüsü; ağ kataloğuyla ad/hat kodu üzerinden eşleştirilir | 📦 Statik dosya; bazı yeni veya yeniden adlandırılmış istasyonlarda koordinat olmayabilir |
| Metro hat durumu / arızalar | Bu projede kullanılmıyor | — |
| Metro kalkış saatleri | Metro İstanbul “Sefer Tarifeleri” ekranının arka plan servisi | 📦 `data/timetable.json` paketi |
| Otobüs hatları | İBB İETT SOAP: `HatDurakGuzergah.asmx` → `GetHat_json` | 📦 `data/bus-lines.json` paketi |
| Otobüs durakları | İBB İETT SOAP: `HatDurakGuzergah.asmx` → `GetDurak_json` | 📦 `data/bus-stops.json` paketi |
| Otobüs hattının durakları | `api.ibb.gov.tr/iett/ibb/ibb.asmx` → `DurakDetay_GYY` | ✅ `/api/bus?type=line` (1 saat önbellek) |
| Otobüs planlanan sefer saatleri | İETT SOAP verisinden oluşturulan yerel `data/bus-schedules.json` | 📦 Statik dosya; tarayıcı uygulaması açarken API çağırmaz |
| Otobüs canlı durak varışları | `iett.istanbul/tr/RouteStation/GetStationInfo` | ✅ `/api/bus?type=stop` (20 sn önbellek) |
| Otobüs canlı araç konumu / yakın durak (normal hatlar) | İBB İETT SOAP: `FiloDurum/SeferGerceklesme.asmx` → `GetHatOtoKonum_json` | ✅ `/api/bus?type=vehicles` (30 sn önbellek) |
| İETT duyuruları (otobüs/metrobüs) | `iett.istanbul/tr/Announcement` | ✅ `/api/bus?type=announcements` (5 dk önbellek) |
| İETT duyuru metni | `iett.istanbul/Announcement/Detail/…` | ✅ `/api/bus?type=announcement&id=…` (1 saat önbellek) |
| Yolculuk araması | Duraklar `data/bus-stops.json` ve `data/rail-network.json` ile yerel istasyon koordinatlarından; mekân/adresler `data/osm/turkey-places.json.gz` yerel indeksinden (`/api/bus?type=place`) | Yer araması çevrimdışı; API anahtarı gerekmez |

Yerel mekân indeksini Türkiye PBF kaynağından yeniden oluşturmak için Osmium aracı kurulu olmalı ve `npm run osm:index` çalıştırılmalıdır. Hem PBF hem üretilen indeks Türkiye verisini içerir; arama ekranı sonuçları İstanbul coğrafi alanında sınırlar. Yer verileri OpenStreetMap’ten gelir; uygulamada [OpenStreetMap katkıcılarına atıf](https://www.openstreetmap.org/copyright) gösterilir.
| Planlanan yolculuk rotası | `nasilgiderim.iett.gov.tr/router` | ✅ `/api/bus?type=journey&from=lat,lng&to=lat,lng` (60 sn önbellek) |

### Metro tarafındaki sınır

Metro hat kataloğu ve istasyon sıraları `data/rail-network.json` dosyasından okunur; İBB Metro API'si çağrılmaz. Bu ağ dosyası sefer saati, canlı araç konumu veya canlı arıza bilgisi içermez. Tarife bilgisi varsa `data/timetable.json` içindeki planlanan seferlere dayanır. Katalogda olup tarife dosyasında bulunmayan hatlarda yalnızca ağ haritası ve istasyon sırası gösterilir.

Tarife; hafta içi, cumartesi ve pazar olmak üzere üç gün tipi için saklanır. Cuma–cumartesi gece metrosu seferleri cumartesi/pazar listelerinde yer alır.

### Otobüs ve metrobüs tarafındaki sınır

- Otobüs **hat/durak araması** cihazdaki katalogdan çalışır; internet gerekmez.
- **Hat durakları** ve **canlı durak varışları** İETT servislerinden okunur; çevrimiçi olmayı gerektirir. Gece saatlerinde pano boş olabilir.
- Panodaki `B` işareti, aracın henüz sefere başlamadığını veya sinyal sorunu olduğunu gösterir; süre yerine `B` gösterilir.
- Süreler İETT’nin tahmini varış verisidir; trafik ve durak yoğunluğuna göre değişebilir.
- Normal otobüs durak sayfası yalnızca hattı, varış yönünü, canlı süreyi ve saati gösterir; bu sayfada araç konumu yer almaz. Bir varış satırına dokunmak o hattın tüm duraklarını açar. Canlı araç konumu, hattın tüm duraklarının listelendiği hat sayfasında gösterilir. Araç konumu İBB’nin `GetHatOtoKonum_json` servisinden gelir; servis yanıt vermezse bu alan gizlenir, durak listesi çalışmaya devam eder. Metrobüste canlı araç konumu gösterilmez.
- Normal otobüs hat sayfasındaki başlık kartı **Sefer saatleri** panelini açar. Saatler `data/bus-schedules.json` statik kataloğundan gelir; katalog `npm run scrape:bus:schedules` komutuyla İETT’den güncellenebilir; hafta içi/cumartesi/pazar ve gidiş/dönüş sekmeleriyle, ilk–son sefer ve toplam sefer sayısıyla birlikte gösterilir. Bu servis yalnızca **ana durak kalkışlarını** yayınlar; ara durakların planlanan saatleri yoktur, ara duraklar için durak sayfasındaki canlı varış süreleri kullanılır. Metrobüste bu panel gösterilmez.
- Metrobüs ana sayfası metro ana sayfasıyla aynı düzendedir: **Metrobüs Uyarıları**, arama, **Yakınındaki metrobüs hatları**, favori metrobüs durakları ve **Tüm metrobüs hatları**. Hat sayfası seçilen yönün tüm duraklarını **kalkış → varış** sırasıyla gösterir; canlı araç işareti veya konum takibi yoktur. Bir durağa dokununca metro istasyon sayfasına benzer durak sayfası açılır: hat rozetleri, hat seçim çipleri, seçilen hattın canlı “sıradaki seferler” listesi ve “Bu duraktaki hatlar” bölümü bulunur.
- Metro ve metrobüs ana sayfalarında size en yakın üç hat ve bu hatların en yakın durakları listelenir; otobüs ana sayfasında size en yakın üç durak gösterilir. Metro hat sayfasında **100 m**, otobüs ve metrobüs hat sayfalarında **500 m** içindeki en yakın durak, durağın hemen üstünde **“Tahmini konumunuz”** etiketi ve mesafeyle vurgulanır. Konum izni yoksa hat sayfasında küçük bir “Konumumu kullan” istemi gösterilir.
- Otobüs ve metrobüs sayfalarındaki üst duyuru kartı İETT’nin genel duyuru listesinden beslenir; metrobüs kartında yalnızca metrobüs hatlarıyla ilgili duyurular gösterilir. Duyuru başlığına dokununca metin uygulamanın içinde açılır; dış bağlantıya gidilmez. Aynı anda yalnızca bir duyuru açık kalır.
- Metro duyuruları da aynı açılır kart düzenini kullanır. Durak sayfasındaki hat duyuruları canlı pano verisinden gelir ve varışların üstünde gösterilir.

### Yolculuk planlayıcı sınırı

- Başlangıç/varış araması durakları ve yerleri yerel veriden listeler; POI araması internet servisine çıkmaz. Yolculuk rotaları İETT’nin **Nasıl Giderim** servisinden alınır; sonuçlarda metro, otobüs, vapur ve taksi dolmuş gibi İETT’nin döndürdüğü tüm ulaşım türleri gösterilebilir.
- Yolculuk haritası OpenStreetMap altlıklarını internetten yükler; harita çevrimdışı görünmez. Harita üzerinde OpenStreetMap katkısı belirtilir.
- Saatler ve aktarma noktaları **planlanan tarifeye** dayanır. Canlı araç konumu, anlık trafik veya gerçek zamanlı varış tahmini değildir; sefer iptalleri ve gecikmeler için durak sayfasındaki canlı varışlara bakın.
- Rota sorgusu sunucuda İstanbul saatine göre yapılır ve kısa süre önbelleğe alınır. Yolculuğa çık ekranındaki **↻** düğmesi planı yeniden sorgular.
- İETT planlayıcısı her başlangıç–varış çifti için rota döndürmeyebilir; bu durumda ekranda “Bu saat için rota bulunamadı” mesajı gösterilir. Servis geçici olarak yanıt vermezse arama ve rota istekleri bir kez otomatik yeniden denenir.

### Neden `/api/bus` gerekiyor?

`iett.istanbul` ve `api.ibb.gov.tr/iett` yanıtlarında `Access-Control-Allow-Origin` başlığı yok. Tarayıcıdan doğrudan çağrılırsa CORS hatası oluşur. Bu yüzden uygulama aynı origin’deki `/api/bus` adresine gider:

- Yerelde: `server.mjs`
- Vercel’de: `api/bus.mjs` (Node fonksiyonu, Frankfurt `fra1`)
- Ortak ayrıştırma/önbellek: `lib/iett.mjs`

## Proje düzeni

```
index.html                 Vite giriş HTML’i (aktif vanilla arayüz)
public/app.js              aktif uygulama mantığı (vanilla JS)
public/styles.css          aktif stiller
public/                    manifest, service worker, ikonlar, aktif JS/CSS
data/                      metro tarifesi + otobüs hat/durak paketleri
server.mjs                 yerel üretim sunucusu + /api/bus köprüsü
api/bus.mjs                İETT Vercel serverless fonksiyonu
lib/iett.mjs               İETT HTML/SOAP ayrıştırıcıları ve önbellek
tools/                     veri çekicileri ve ikon üretici
react-ui-backup/           React/Vite arayüzünün yedeği
vite.config.js             Vite, veri kopyalama, dev proxy
vercel.json                Vite build + serverless fonksiyon ayarları
```

## Veriyi yenileme

Metro tarifesi:

```bash
npm run scrape
# → data/timetable.json  (~1,8 MB, gzip ~130 KB)
# → data/lines.json, data/stations.json, data/meta.json
```

Otobüs hat ve durak kataloğu:

```bash
npm run scrape:bus
# → data/bus-lines.json  (~53 KB, 784 hat)
# → data/bus-stops.json  (~1,0 MB, 15.185 durak; gzip ~267 KB)
```

Metro tarifesi sezonluk değiştiğinde (yaz/kış tarifesi), yeni hat açıldığında veya İETT kataloğu güncellendiğinde ilgili komutu çalıştırıp dosyaları yeniden yayınlamak yeterli.

## Yayınlama

### Vercel (canlı otobüs dahil)

`vercel.json` Vite build’ini (`npm run build` → `dist`) ve `api/bus.mjs` fonksiyonunu birlikte yayınlar. `data/` dosyaları build sırasında `dist/data` içine kopyalanır. `/assets/*` uzun süreli, `/data/*.json` kısa süreli önbellek başlıklarıyla sunulur.

### Yalnızca statik hosting (GitHub Pages, Netlify, Cloudflare Pages…)

Metro özellikleri ve otobüs hat/durak araması çalışır; ancak **hat durakları** ve **canlı otobüs varışları** için ayrıca bir `/api/bus` proxy’si gerekir. Proxy yoksa durak sayfası “canlı varış bilgisi alınamadı”, hat sayfası “hat durakları alınamadı” mesajı gösterir.

`manifest.webmanifest` göreli yollar kullandığı için alt dizinde de çalışabilir; service worker kaydı kök `/sw.js` üzerinden yapılır. HTTPS gerekir (localhost istisna).

## Bilinen notlar

- Saatler cihazın yerel saatine göre yorumlanır; İstanbul dışında kullanımda kayma olur.
- Resmî tatil tarifeleri ayrıca modellenmez; en yakın gün tipi kullanılır.
- M7 gibi hatlarda “mekik işletme” gibi bilgiler hat durumu metninde görünür; tarife tek parça kabul edilir.
- Tarife saatleri 00:30 gibi ertesi güne sarkan seferleri de içerir; uygulama gece yarısını doğru şekilde köprüler.
- İETT canlı durak panosu ve duyuru listesi resmî olarak belgelenmiş bir JSON API değildir; HTML yapısı değişirse `lib/iett.mjs` içindeki ayrıştırıcılar güncellenmelidir.
- `GetHatOtoKonum_json` da resmî olarak belgelenmiş bir JSON sözleşmesi değildir; alan adları değişebilir. Normal otobüs hat sayfasındaki canlı araç işaretleri için kullanılır; durak sayfasında gösterilmez. “Şu an” olarak gösterilen durak, aracın son ölçülen **en yakın durağıdır**; kesin GPS konumu değildir.
- Metrobüs ile otobüs ayrımı İETT hat kataloğundaki `METROBÜS` tarifesine göre yapılır. Metrobüs aramasında yalnızca metrobüs hatlarının durak verisinde (`data/bus-line-stops.json`) geçen gerçek platform durakları listelenir; adında veya yönünde “metrobüs” geçen normal otobüs durakları listelenmez.
