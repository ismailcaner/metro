/**
 * Local Istanbul transit router.
 * Builds a graph from data/rail-network.json and coordinate snapshots already
 * loaded by the app. It deliberately labels timetable and interchange estimates.
 */
const norm = (value) => String(value || "")
  .toLocaleLowerCase("tr")
  .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
  .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
  .replace(/[^a-z0-9]+/g, " ").trim();

const haversine = (a, b) => {
  const rad = (v) => v * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(x));
};

const pointOf = (place) => {
  const lat = Number(place?.point?.[0] ?? place?.lat);
  const lng = Number(place?.point?.[1] ?? place?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};

function buildGraph(network, stations) {
  const nodes = new Map();
  const adjacency = new Map();
  const addNode = (node) => {
    nodes.set(node.id, node);
    if (!adjacency.has(node.id)) adjacency.set(node.id, []);
  };
  const addEdge = (from, to, edge) => {
    if (!adjacency.has(from) || !adjacency.has(to)) return;
    adjacency.get(from).push({ to, ...edge });
  };
  const coords = new Map();
  for (const station of stations || []) {
    if (Number.isFinite(Number(station.lat)) && Number.isFinite(Number(station.lng))) {
      const key = `${station.code}:${norm(station.name)}`;
      if (!coords.has(key)) coords.set(key, { lat: Number(station.lat), lng: Number(station.lng), info: station.info || null });
    }
  }
  for (const line of network?.lines || []) {
    const lineStations = [...(line.stations || [])].sort((a, b) => Number(a.order) - Number(b.order));
    for (const station of lineStations) {
      const point = coords.get(`${line.id}:${norm(station.name)}`) || null;
      addNode({
        id: station.id, name: station.name, lineId: line.id,
        lineName: line.name, mode: line.mode || "metro",
        order: Number(station.order) || 0, point, color: line.color || null,
      });
    }
    for (let i = 0; i < lineStations.length - 1; i++) {
      const a = lineStations[i], b = lineStations[i + 1];
      // Adjacent stations are connected in both directions; travel time is an estimate,
      // never represented as an official timetable.
      addEdge(a.id, b.id, { kind: "ride", minutes: 3, lineId: line.id, lineName: line.name, mode: line.mode || "metro", estimated: true });
      addEdge(b.id, a.id, { kind: "ride", minutes: 3, lineId: line.id, lineName: line.name, mode: line.mode || "metro", estimated: true });
    }
  }
  for (const group of network?.transferCandidates || []) {
    const refs = (group.stationRefs || []).filter((ref) => nodes.has(ref.stationId));
    if (refs.length < 2) continue;
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        const a = refs[i], b = refs[j];
        // Only candidates recorded in the repository are used. Their actual walking
        // paths/step-free status are unknown, so transfer edges carry that warning.
        addEdge(a.stationId, b.stationId, { kind: "transfer", minutes: 6, lineId: b.lineId, lineName: nodes.get(b.stationId).lineName, mode: nodes.get(b.stationId).mode, unverified: group.status !== "official_map_transfer_candidate" });
        addEdge(b.stationId, a.stationId, { kind: "transfer", minutes: 6, lineId: a.lineId, lineName: nodes.get(a.stationId).lineName, mode: nodes.get(a.stationId).mode, unverified: group.status !== "official_map_transfer_candidate" });
      }
    }
  }
  return { nodes, adjacency };
}

function shortest(graph, starts, ends, strategy = "balanced") {
  const endSet = new Set(ends.map((x) => x.id));
  const distance = new Map(), previous = new Map(), queue = [];
  for (const start of starts) {
    distance.set(start.id, 0);
    queue.push({ id: start.id, cost: 0 });
  }
  const weight = (edge) => {
    if (strategy === "direct" && edge.kind === "transfer") return Infinity;
    if (strategy === "fewest-transfers") return edge.kind === "transfer" ? 16 : 1;
    if (strategy === "fewest-stops") return edge.kind === "transfer" ? 5 : 1;
    return edge.minutes + (edge.kind === "transfer" ? 4 : 0);
  };
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift();
    if (current.cost !== distance.get(current.id)) continue;
    if (endSet.has(current.id)) {
      const edges = [];
      let cursor = current.id;
      while (previous.has(cursor)) {
        const step = previous.get(cursor);
        edges.push({ from: graph.nodes.get(step.from), to: graph.nodes.get(cursor), edge: step.edge });
        cursor = step.from;
      }
      edges.reverse();
      return { edges, start: starts.find((node) => node.id === cursor) || graph.nodes.get(cursor), end: ends.find((node) => node.id === current.id) || graph.nodes.get(current.id), cost: current.cost };
    }
    for (const edge of graph.adjacency.get(current.id) || []) {
      const nextCost = current.cost + weight(edge);
      if (nextCost < (distance.get(edge.to) ?? Infinity)) {
        distance.set(edge.to, nextCost);
        previous.set(edge.to, { from: current.id, edge });
        queue.push({ id: edge.to, cost: nextCost });
      }
    }
  }
  return null;
}

function nearestNodes(graph, point, maxDistance = 1800) {
  if (!point) return [];
  const found = [...graph.nodes.values()]
    .filter((node) => node.point)
    .map((node) => ({ ...node, accessMeters: haversine(point, node.point) }))
    .filter((node) => node.accessMeters <= maxDistance)
    .sort((a, b) => a.accessMeters - b.accessMeters);
  // Keep the nearest node per line to allow a sensible starting line choice.
  const perLine = new Map();
  for (const node of found) if (!perLine.has(node.lineId)) perLine.set(node.lineId, node);
  return [...perLine.values()].sort((a, b) => a.accessMeters - b.accessMeters).slice(0, 6);
}

function makeRoute(path, origin, destination, index) {
  if (!path) return null;
  const edges = path.edges;
  const transitLegs = [];
  for (const step of edges) {
    if (step.edge.kind === "transfer") {
      transitLegs.push({ kind: "transfer-marker", from: step.from, to: step.to, edge: step.edge });
      continue;
    }
    const last = transitLegs[transitLegs.length - 1];
    if (last && last.kind === "transit" && last.lineId === step.edge.lineId && last.to.id === step.from.id) {
      last.to = step.to;
      last.durationMin += step.edge.minutes;
      last.stops += 1;
    } else {
      transitLegs.push({
        kind: "transit", lineId: step.edge.lineId, lineName: step.edge.lineName, mode: step.edge.mode,
        from: step.from, to: step.to, durationMin: step.edge.minutes, stops: 1, estimated: true,
      });
    }
  }
  const legs = [];
  const accessMeters = Math.round(path.start.accessMeters || 0);
  if (accessMeters > 30) legs.push({
    kind: "walk", mode: "walking", from: { name: origin.name || "Başlangıç" },
    to: { name: path.start.name }, durationMin: Math.max(1, Math.ceil(accessMeters / 75)),
    walkDistance: accessMeters, estimated: true,
  });
  for (const item of transitLegs) {
    if (item.kind === "transfer-marker") {
      legs.push({
        kind: "walk", mode: "walking", from: { name: item.from.name }, to: { name: item.to.name },
        durationMin: item.edge.minutes, walkDistance: 0, estimated: true, transferUnverified: item.edge.unverified,
      });
    } else {
      legs.push({
        kind: "transit", lineId: item.lineId, lineName: item.lineName, mode: item.mode,
        from: { name: item.from.name }, to: { name: item.to.name }, durationMin: item.durationMin,
        departureTime: null, arrivalTime: null, estimated: true, stops: item.stops,
      });
    }
  }
  const egressMeters = Math.round(path.end.accessMeters || 0);
  if (egressMeters > 30) legs.push({
    kind: "walk", mode: "walking", from: { name: path.end.name }, to: { name: destination.name || "Varış" },
    durationMin: Math.max(1, Math.ceil(egressMeters / 75)), walkDistance: egressMeters, estimated: true,
  });
  const rideMinutes = edges.reduce((sum, step) => sum + step.edge.minutes, 0);
  const transfers = edges.filter((step) => step.edge.kind === "transfer").length;
  const walkDistance = accessMeters + egressMeters;
  return {
    id: `local-${index}-${path.start.id}-${path.end.id}`,
    durationMin: legs.reduce((sum, leg) => sum + (Number(leg.durationMin) || 0), 0),
    transfers, walkDistance, totalFee: null, legs,
    estimated: true, source: "local-json",
    notes: ["İstasyonlar arası süreler tahminidir; resmî kalkış saatleri değildir."],
    rideMinutes,
  };
}

export function findLocalRoutes({ network, stations, origin, destination, mode = "mixed" }) {
  const fromPoint = pointOf(origin), toPoint = pointOf(destination);
  if (!fromPoint || !toPoint || !network?.lines?.length) return { routes: [], reason: "missing-coordinates" };
  const graph = buildGraph(network, stations);
  const starts = nearestNodes(graph, fromPoint);
  const ends = nearestNodes(graph, toPoint);
  if (!starts.length || !ends.length) return { routes: [], reason: "no-nearby-station" };
  const strategies = mode === "direct"
    ? ["direct"]
    : mode === "fastest"
      ? ["balanced", "fewest-stops", "fewest-transfers"]
      : ["balanced", "fewest-transfers", "fewest-stops"];
  const routes = [];
  const seen = new Set();
  for (const strategy of strategies) {
    const path = shortest(graph, starts, ends, strategy);
    if (!path) continue;
    const signature = path.edges.map((x) => x.from.id + ">" + x.to.id).join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    const route = makeRoute(path, origin, destination, routes.length);\n    if (mode === "direct" && route.transfers > 0) continue;\n    routes.push(route);
  }
  routes.sort((a, b) => mode === "fastest"
    ? a.durationMin - b.durationMin || a.transfers - b.transfers
    : mode === "direct"
      ? a.transfers - b.transfers || a.durationMin - b.durationMin
      : a.durationMin + a.transfers * 4 - (b.durationMin + b.transfers * 4));
  return {
    routes: routes.slice(0, 3),
    engine: "local-json",
    generatedAt: network.generatedAt || null,
    disclaimer: "Süreler tahminidir; aktarma adaylarının bir kısmı doğrulanmamıştır.",
  };
}
