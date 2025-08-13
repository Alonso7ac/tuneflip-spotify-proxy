// api/track-perf.js
import { pool } from "../lib/db"; // Neon pool

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // optional lightweight auth via INGEST_KEY
  const wantAuth = !!process.env.INGEST_KEY;
  const okAuth =
    !wantAuth ||
    req.headers.authorization === `Bearer ${process.env.INGEST_KEY}` ||
    req.headers["x-ingest-key"] === process.env.INGEST_KEY;
  if (!okAuth) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

  try {
    const sql = `
      SELECT
        v.track_id,
        t.title,
        t.artist,
        t.album,
        t.art_url,
        v.impressions,
        v.starts,
        v.likes,
        v.nopes,
        v.ms_played,
        v.start_rate,
        v.like_rate,
        v.nope_rate,
        v.avg_play_ratio,
        v.score
      FROM public.v_track_perf_7d v
      LEFT JOIN public.tracks t ON t.track_id::text = v.track_id::text
      ORDER BY v.score DESC
      LIMIT $1
    `;
    const { rows } = await pool.query(sql, [limit]);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ items: rows });
  } catch (err) {
    console.error("track-perf error:", err);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
