#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "data/osm/turkey-latest.osm.pbf");
const destination = join(root, "data/osm/turkey-places.json.gz");
const expressions = [
  "nwr/amenity", "nwr/shop", "nwr/tourism", "nwr/leisure", "nwr/office",
  "nwr/healthcare", "nwr/education", "nwr/craft", "nwr/club", "nwr/place",
  "nwr/historic", "nwr/attraction", "nwr/landmark",
  "nwr/public_transport=station,stop_position,platform",
  "nwr/railway=station,halt", "nwr/aeroway=aerodrome,terminal", "nwr/addr:housenumber",
  "w/highway",
];
const bounds = { minLat: 40.802, maxLat: 41.700, minLng: 27.971, maxLng: 29.959 };
const GRID_LAT = 0.004;
const GRID_LNG = 0.005;
const ROAD_SEARCH_METERS = 250;
const metersPerLat = 111_320;

function clean(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function pointFor(geometry) {
  if (!geometry) return null;
  let coordinates = geometry.coordinates;
  if (geometry.type === "Point") return coordinates;
  const points = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push(value);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(coordinates);
  if (!points.length) return null;
  return [
    points.reduce((sum, point) => sum + Number(point[0]), 0) / points.length,
    points.reduce((sum, point) => sum + Number(point[1]), 0) / points.length,
  ];
}

function addressFor(tags) {
  const street = clean(tags["addr:street"] || tags["addr:place"]);
  const number = clean(tags["addr:housenumber"]);
  return [...new Set([
    [street, number].filter(Boolean).join(" "),
    tags["addr:suburb"], tags["addr:neighbourhood"], tags["addr:district"],
    tags["addr:city"], tags["addr:postcode"],
  ].map(clean).filter(Boolean))].join(", ");
}

function shortAddressFor(tags) {
  const street = clean(tags["addr:street"] || tags["addr:place"]);
  const number = clean(tags["addr:housenumber"]);
  const area = clean(tags["addr:neighbourhood"] || tags["addr:suburb"] || tags["addr:district"]);
  return [ [street, number].filter(Boolean).join(" "), area ].filter(Boolean).join(", ");
}

function aliasesFor(tags, name) {
  const values = [name, tags["name:tr"], tags["name:en"], tags.int_name, tags.official_name, tags.short_name, tags.brand, tags.operator, tags.alt_name];
  return [...new Set(values.flatMap((value) => clean(value).split(/[;,]/).map(clean)).filter((value) => value && value !== name))].slice(0, 8);
}

function gridKey(lat, lng) {
  return `${Math.floor(lat / GRID_LAT)}:${Math.floor(lng / GRID_LNG)}`;
}

function nearestNamedRoad(point, grid) {
  const [lat, lng] = point;
  const latRadius = ROAD_SEARCH_METERS / metersPerLat;
  const lngRadius = ROAD_SEARCH_METERS / (metersPerLat * Math.cos(lat * Math.PI / 180));
  const latCellRadius = Math.ceil(latRadius / GRID_LAT);
  const lngCellRadius = Math.ceil(lngRadius / GRID_LNG);
  const segments = new Set();
  for (let dy = -latCellRadius; dy <= latCellRadius; dy++) {
    for (let dx = -lngCellRadius; dx <= lngCellRadius; dx++) {
      for (const segment of grid.get(`${Math.floor(lat / GRID_LAT) + dy}:${Math.floor(lng / GRID_LNG) + dx}`) || []) segments.add(segment);
    }
  }

  const latScale = metersPerLat;
  const lngScale = metersPerLat * Math.cos(lat * Math.PI / 180);
  let best = null;
  for (const segment of segments) {
    const x1 = (segment.lng1 - lng) * lngScale;
    const y1 = (segment.lat1 - lat) * latScale;
    const x2 = (segment.lng2 - lng) * lngScale;
    const y2 = (segment.lat2 - lat) * latScale;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lengthSquared)) : 0;
    const distance = Math.hypot(x1 + t * dx, y1 + t * dy) + segment.priority;
    if (distance <= ROAD_SEARCH_METERS && (!best || distance < best.distance)) best = { name: segment.name, distance };
  }
  return best?.name || "";
}

const temp = await mkdtemp(join(tmpdir(), "siradaki-metro-osm-"));
const istanbul = join(temp, "istanbul.osm.pbf");
const tagged = join(temp, "places.osm.pbf");
const exported = join(temp, "places.geojsonseq");

try {
  await access(source);
  console.log("Türkiye PBF’sinden İstanbul bölgesi ayrılıyor…");
  await run("osmium", ["extract", "--no-progress", "--strategy=smart", "--bbox=27.971,40.802,29.959,41.700", source, `--output=${istanbul}`], { maxBuffer: 2 * 1024 * 1024 });
  console.log("İstanbul mekân ve yol verisi hazırlanıyor…");
  await run("osmium", ["tags-filter", "--no-progress", "--remove-tags", istanbul, ...expressions, `--output=${tagged}`], { maxBuffer: 2 * 1024 * 1024 });
  await run("osmium", ["export", "--no-progress", "--index-type=flex_mem", "--add-unique-id=type_id", `--output=${exported}`, "--output-format=geojsonseq", tagged], { maxBuffer: 2 * 1024 * 1024 });

  const places = [];
  const roads = [];
  const seen = new Set();
  const lines = createInterface({ input: createReadStream(exported), crlfDelay: Infinity });
  for await (const line of lines) {
    const text = line.trim().replace(/^\u001e/, "");
    if (!text) continue;
    let feature;
    try { feature = JSON.parse(text); } catch { continue; }
    const tags = feature.properties || {};
    const point = pointFor(feature.geometry);
    if (!point || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) continue;
    const roadName = clean(tags["name:tr"] || tags.name || tags["name:en"] || "");
    if (tags.highway && roadName && feature.geometry?.type === "LineString") {
      const coordinates = feature.geometry.coordinates || [];
      for (let index = 1; index < coordinates.length; index++) {
        const [lng1, lat1] = coordinates[index - 1].map(Number);
        const [lng2, lat2] = coordinates[index].map(Number);
        if (![lng1, lat1, lng2, lat2].every(Number.isFinite)) continue;
        if (Math.max(lat1, lat2) < bounds.minLat || Math.min(lat1, lat2) > bounds.maxLat || Math.max(lng1, lng2) < bounds.minLng || Math.min(lng1, lng2) > bounds.maxLng) continue;
        const highway = String(tags.highway);
        const priority = highway === "motorway" ? 70 : highway === "trunk" ? 35 : highway === "primary" ? 12 : highway === "secondary" ? 5 : highway === "footway" || highway === "path" ? 15 : 0;
        roads.push({ lng1, lat1, lng2, lat2, name: roadName, priority });
      }
      continue;
    }
    const name = clean(tags["name:tr"] || tags.name || tags["name:en"] || tags.brand || "");
    const address = addressFor(tags);
    const shortAddress = shortAddressFor(tags);
    const label = name || address;
    if (label.length < 2) continue;
    const id = String(feature.id || tags["@id"] || `${label}:${point[0].toFixed(6)}:${point[1].toFixed(6)}`);
    const dedupeKey = `${id}|${label}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const category = ["amenity", "shop", "tourism", "leisure", "office", "healthcare", "education", "craft", "club", "historic", "place", "public_transport", "railway", "aeroway"]
      .filter((key) => tags[key]).map((key) => `${key}=${tags[key]}`).join(";");
    places.push({ id: `osm:${id}`, name: label, address, shortAddress, point: [Number(point[1]), Number(point[0])], aliases: aliasesFor(tags, label), category });
  }

  const roadGrid = new Map();
  const latBuffer = ROAD_SEARCH_METERS / metersPerLat;
  for (const road of roads) {
    const midLat = (road.lat1 + road.lat2) / 2;
    const lngBuffer = ROAD_SEARCH_METERS / (metersPerLat * Math.cos(midLat * Math.PI / 180));
    const minY = Math.floor((Math.min(road.lat1, road.lat2) - latBuffer) / GRID_LAT);
    const maxY = Math.floor((Math.max(road.lat1, road.lat2) + latBuffer) / GRID_LAT);
    const minX = Math.floor((Math.min(road.lng1, road.lng2) - lngBuffer) / GRID_LNG);
    const maxX = Math.floor((Math.max(road.lng1, road.lng2) + lngBuffer) / GRID_LNG);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = `${y}:${x}`;
        if (!roadGrid.has(key)) roadGrid.set(key, []);
        roadGrid.get(key).push(road);
      }
    }
  }
  for (const place of places) {
    if (!place.shortAddress) place.shortAddress = nearestNamedRoad(place.point, roadGrid);
  }

  places.sort((a, b) => a.name.localeCompare(b.name, "tr"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, gzipSync(Buffer.from(JSON.stringify(places)), { level: 9 }));
  console.log(`İndeks hazır: ${places.length.toLocaleString("tr-TR")} yer → ${destination}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
