import { handleBusRequest } from "../lib/iett.mjs";

export default async function handler(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || "localhost";
  let url;
  try {
    url = new URL(req.url, `${proto}://${host}`);
  } catch {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Geçersiz istek" }));
    return;
  }

  const out = await handleBusRequest(url);
  res.statusCode = out.status;
  for (const [key, value] of Object.entries(out.headers)) {
    if (value != null) res.setHeader(key, value);
  }
  res.end(JSON.stringify(out.body));
}
