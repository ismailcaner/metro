import { handleMetroRequest } from "../../lib/metro.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("allow", "GET, HEAD");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Yöntem desteklenmiyor" }));
    return;
  }

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

  const out = await handleMetroRequest(url);
  res.statusCode = out.status;
  res.setHeader("cache-control", "no-store");
  for (const [key, value] of Object.entries(out.headers)) {
    if (value != null) res.setHeader(key, value);
  }
  res.end(out.text);
}
