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
  { networkId: "m1-a", code: "M1", name: "Alpha (API label differs)", lat: 41, lng: 29 },
  { networkId: "m1-x", code: "M1", name: "Central (API label differs)", lat: 41.03, lng: 29 },
  { networkId: "m2-x", code: "M2", name: "Central (API label differs)", lat: 41.03, lng: 29 },
  { networkId: "m2-b", code: "M2", name: "Bravo (API label differs)", lat: 41.06, lng: 29 },
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


test("does not route through unverified name-match transfers", () => {
  const unverifiedNetwork = {
    ...network,
    transferCandidates: network.transferCandidates.map((candidate) => ({
      ...candidate,
      status: "name_match_unverified",
    })),
  };
  const result = findLocalRoutes({
    network: unverifiedNetwork,
    stations,
    origin,
    destination,
    mode: "mixed",
  });
  assert.equal(result.routes.length, 0);
});

test("considers multiple nearby stations on the same line at the destination", () => {
  const nearbyNetwork = {
    generatedAt: "test",
    lines: [{
      id: "M1",
      name: "Test line",
      mode: "metro",
      stations: [
        { id: "a", name: "Start", order: 1 },
        { id: "b", name: "Near but far access", order: 2 },
        { id: "c", name: "Better access", order: 3 },
      ],
    }],
    transferCandidates: [],
  };
  const nearbyStations = [
    { networkId: "a", code: "M1", name: "Start", lat: 41, lng: 29 },
    { networkId: "b", code: "M1", name: "Near but far access", lat: 41.009, lng: 29 },
    { networkId: "c", code: "M1", name: "Better access", lat: 41.006, lng: 29 },
  ];
  const result = findLocalRoutes({
    network: nearbyNetwork,
    stations: nearbyStations,
    origin: { name: "Start", point: [41, 29] },
    destination: { name: "Destination", point: [41.01, 29] },
    mode: "fastest",
  });
  assert.ok(result.routes.length > 0);
  assert.ok(result.routes[0].legs.some((leg) => leg.to?.name === "Better access"));
});
