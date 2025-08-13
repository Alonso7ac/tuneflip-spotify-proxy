// api/backfill-tracks.js
import { pool } from "../lib/db";

// Helper: upgrade artwork URL (100x100 -> 600x600) if present
function upscaleArt(url) {
  if (!url) return null;
  return url.replace(/\/[0-9]+x[0-9]+bb\.jpg$/i, "/600x600bb.jpg");
}

export default async function handler(req, res) {
  // Require auth (uses same INGEST_KEY you already set)
  const wantAuth = !!process.env.INGEST_KEY;
  const okAuth =
    !wantAuth ||
    req.headers.authorization === `Bearer ${process.env.INGEST_KEY}` ||
    req.headers["x-ingest-key"] === process.env.INGEST_KEY;

  if (!okAuth) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // limit how many we try per call
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

  try {
    // 1) Find track_ids in v_track_perf_7d that are not in public.tracks
    const missingSQL = `
      SELECT v.track_id::text AS track_id
      FROM public.v_track_perf_7d v
      LEFT JOIN public.tracks t ON t.track_id::text = v.track_id::text
      WHERE t.track_id IS NULL
      ORDER BY v.score DESC NULLS LAST
      LIMIT $1
    `;
    const { rows: missingRows } = await pool.query(missingSQL, [limit]);
    const ids = missingRows.map(r => r.track_id);

    if (ids.length === 0) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ added: 0, message: "No missing tracks to backfill." });
    }

    let added = 0;
    let lookedUp = 0;

    // 2) Look up each track via iTunes API and upsert
    for (const id of ids) {
      lookedUp++;
      try {
        const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=song`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) continue;
        const data = await r.json();

        const item = (data?.results || []).find(x => String(x.trackId) === String(id)) || data?.results?.[0];
        if (!item) continue;

        const title = item.trackName || null;
        const artist = item.artistName || null;
        const album = item.collectionName || null;
        const art_url = upscaleArt(item.artworkUrl100 || null);
        const store_url = item.trackViewUrl || null;
        const preview_url = item.previewUrl || null;

        // 3) Upsert. Adjust column list if your table has fewer/more columns.
        const upsertSQL = `
          INSERT INTO public.tracks (track_id, title, artist, album, art_url, store_url, preview_url)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (track_id) DO UPDATE SET
            title = EXCLUDED.title,
            artist = EXCLUDED.artist,
            album = EXCLUDED.album,
            art_url = EXCLUDED.art_url,
            store_url = EXCLUDED.store_url,
            preview_url = EXCLUDED.preview_url
        `;
        await pool.query(upsertSQL, [id, title, artist, album, art_url, store_url, preview_url]);
        added++;
      } catch (e) {
        console.error("backfill error for id", id, e);
        // continue with next id
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ lookedUp, added });
  } catch (err) {
    console.error("backfill-tracks handler error:", err);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
