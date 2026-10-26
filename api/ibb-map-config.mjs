export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const apiKey = process.env.IBB_MAP_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "IBB_MAP_API_KEY is missing. Set it in Vercel Environment Variables.",
    });
  }
  return res.status(200).json({ apiKey });
}
