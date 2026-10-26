import test from "node:test";
import assert from "node:assert/strict";
import { findLocalRoutes } from "../public/route-engine.js";

const network = {
  generatedAt: "test",
  lines: [
    { id: "M1", name: "Test line 1", mode: "metro", stations: [
      { id: "m1-a", name: "Alpha", order: 1 },
      { id: "m1-x", name: "Central", order: 2 },
    ] },
    { id: "M2", name: "Test line 2", mode: "tram", stations: [
      { id: "m2-x", name: "Central", order: 1 },
      { id: "m2-b", name: "Bravo", order: 2 },
    ] },
  ],
  transferCandidates: [{
    stationName: "central",
    stationRefs: [
      { lineId: "M1", stationId: "m1-x" },
      { lineId: "M2", stationId: "m2-x" },
    ],
    status: "official_map_transfer_candidate",
  }],
};
const stations = [
  { code: "M1", name: "Alpha", lat: 41, lng: 29 },
  { code: "M1", name: "Central", lat: 41.03, lng: 29 },
  { code: "M2", name: "Central", lat: 41.03, lng: 29 },
  { code: "M2", name: "Bravo", lat: 41.06, lng: 29 },
];
const origin = { name: "Alpha", point: [41, 29] };
const destination = { name: "Bravo", point: [41.06, 29] };

test("finds a multimodal route through a recorded transfer candidate", () => {
  const result = findLocalRoutes({ network, stations, origin, destination, mode: "mixed" });
  assert.ok(result.routes.length > 0);
  assert.equal(result.engine, "local-json");
  assert.equal(result.routes[0].source, "local-json");
  assert.equal(result.routes[0].transfers, 1);
  assert.ok(result.routes[0].legs.some((leg) => leg.lineId === "M1"));
  assert.ok(result.routes[0].legs.some((leg) => leg.lineId === "M2"));
});

test("direct mode does not return a route that requires a transfer", () => {
  const result = findLocalRoutes({ network, stations, origin, destination, mode: "direct" });
  assert.equal(result.routes.length, 0);
});

test("returns a useful empty result when coordinates are missing", () => {
  const result = findLocalRoutes({ network, stations, origin: { name: "Unknown" }, destination, mode: "mixed" });
  assert.equal(result.routes.length, 0);
  assert.equal(result.reason, "missing-coordinates");
});
