// Google Maps Routes API proxy. Keep GOOGLE_MAPS_API_KEY server-side.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: "Google Maps is not configured. Set GOOGLE_MAPS_API_KEY in Vercel environment variables.",
    });
  }

  try {
    const { origin, destination, departureTime, routingPreference } = req.body || {};
    const valid = (point) =>
      point &&
      Number.isFinite(Number(point.lat)) &&
      Number.isFinite(Number(point.lng)) &&
      Number(point.lat) >= -90 &&
      Number(point.lat) <= 90 &&
      Number(point.lng) >= -180 &&
      Number(point.lng) <= 180;

    if (!valid(origin) || !valid(destination)) {
      return res.status(400).json({ error: "origin and destination lat/lng are required" });
    }

    const supportedPreferences = new Set(["LESS_WALKING", "FEWER_TRANSFERS"]);
    const body = {
      origin: { location: { latLng: { latitude: Number(origin.lat), longitude: Number(origin.lng) } } },
      destination: { location: { latLng: { latitude: Number(destination.lat), longitude: Number(destination.lng) } } },
      travelMode: "TRANSIT",
      computeAlternativeRoutes: true,
      languageCode: "tr",
      regionCode: "TR",
      ...(departureTime ? { departureTime } : {}),
      ...(supportedPreferences.has(routingPreference)
        ? { transitPreferences: { routingPreference } }
        : {}),
    };

    const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": [
          "routes.duration",
          "routes.distanceMeters",
          "routes.legs.duration",
          "routes.legs.distanceMeters",
          "routes.legs.startLocation",
          "routes.legs.endLocation",
          "routes.legs.steps.distanceMeters",
          "routes.legs.steps.staticDuration",
          "routes.legs.steps.startLocation",
          "routes.legs.steps.endLocation",
          "routes.legs.steps.navigationInstruction.instructions",
          "routes.legs.steps.travelMode",
          "routes.legs.steps.transitDetails",
        ].join(","),
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        error: payload?.error?.message || "Google Routes API request failed",
        status: payload?.error?.status || null,
      });
    }

    const routes = (payload.routes || []).map((route, index) => {
      const legs = [];
      let transitLegCount = 0;
      let walkDistance = 0;

      for (const leg of route.legs || []) {
        for (const step of leg.steps || []) {
          const isTransit = step.travelMode === "TRANSIT";
          const meters = Number(step.distanceMeters) || 0;
          const seconds = Number.parseFloat(step.staticDuration || "0s") || 0;

          if (!isTransit) {
            walkDistance += meters;
            legs.push({
              kind: "walk",
              mode: "walking",
              from: { name: step.navigationInstruction?.instructions || "Yürüyüş" },
              to: { name: "" },
              durationMin: Math.max(0, Math.round(seconds / 60)),
              walkDistance: meters,
              estimated: false,
            });
            continue;
          }

          transitLegCount += 1;
          const details = step.transitDetails || {};
          const line = details.transitLine || {};
          legs.push({
            kind: "transit",
            mode: line.vehicle?.type || "transit",
            lineId: line.nameShort || line.name || "",
            lineName: line.name || line.nameShort || "Toplu taşıma",
            from: { name: details.stopDetails?.departureStop?.name || "" },
            to: { name: details.stopDetails?.arrivalStop?.name || "" },
            durationMin: Math.max(0, Math.round(seconds / 60)),
            departureTime: details.localizedValues?.departureTime?.time?.text || null,
            arrivalTime: details.localizedValues?.arrivalTime?.time?.text || null,
            estimated: false,
          });
        }
      }

      return {
        id: `google-${index}`,
        durationMin: Math.max(0, Math.round(Number.parseFloat(route.duration || "0s") / 60)),
        transfers: Math.max(0, transitLegCount - 1),
        walkDistance,
        legs,
        source: "google-routes",
        estimated: false,
      };
    });

    return res.status(200).json({
      routes,
      engine: "google-routes",
      appliedPreference: body.transitPreferences?.routingPreference || null,
      disclaimer: "Rotalar Google Maps Routes API tarafından hesaplanmıştır.",
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Unexpected Google Routes API error" });
  }
}
