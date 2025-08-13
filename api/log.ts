// api/log.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { pool } from "../lib/db";

// Normalize artwork to higher-res if possible
function upscaleArt(url?: string | null) {
  if (!url) return null;
  return url.replace(/\/[0-9]+x[0-9]+bb\.jpg$/i, "/600x600bb.jpg");
}

// Try to read track metadata from common shapes
function extractTrackMeta(body: any) {
  const src = body?.track ?? body ?? {};
  const track_id =
    String(src.track_id ?? src.trackId ?? src.id ?? "").trim() || null;

  // Accept a wide set of field names from app/client
  const title =
    src.title ?? src.trackName ?? src.name ?? null;
  const artist =
    src.artist ?? src.artistName ?? null;
  const album =
    src.album ?? src.collectionName ?? null;
  const art_url = upscaleArt(
    src.art_url ?? src.artUrl ?? src.artworkUrl600 ?? src.artworkUrl100 ?? null
  );
  const store_url =
    src.store_url ?? src.trackViewUrl ?? src.url ?? null;
  const preview_url =
    src.preview_url ?? src.previewUrl ?? null;

  return { track_id, title, artist, album, art_url, store_url, preview_url };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Cache-Control", "no-store");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // light auth reuse (optional)
    const wantAuth = !!process.env.INGEST_KEY;
    const okAuth =
      !wantAuth ||
      req.headers.authorization === `Bearer ${process.env.INGEST_KEY}` ||
      req.headers["x-ingest-key"] === process.env.INGEST_KEY;
    if (!okAuth) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};

    // ---- NEW: Upsert track metadata if present ----
    const meta = extractTrackMeta(body);
    if (meta.track_id) {
      const upsertSQL = `
        INSERT INTO public.tracks (track_id, title, artist, album, art_url, store_url, preview_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (track_id) DO UPDATE SET
          title = COALESCE(EXCLUDED.title, public.tracks.title),
          artist = COALESCE(EXCLUDED.artist, public.tracks.artist),
          album = COALESCE(EXCLUDED.album, public.tracks.album),
          art_url = COALESCE(EXCLUDED.art_url, public.tracks.art_url),
          store_url = COALESCE(EXCLUDED.store_url, public.tracks.store_url),
          preview_url = COALESCE(EXCLUDED.preview_url, public.tracks.preview_url)
      `;
      await pool.query(upsertSQL, [
        meta.track_id,
        meta.title,
        meta.artist,
        meta.album,
        meta.art_url,
        meta.store_url,
        meta.preview_url,
      ]);
    }
    // ---- /NEW ----

    // Existing event insert (keep whatever you already had; example below)
    const insertEventSQL = `
      INSERT INTO public.events (ts, type, session_id, track_id, payload)
      VALUES (NOW(), $1, $2, $3, $4)
    `;
    await pool.query(insertEventSQL, [
      body.type ?? "unknown",
      body.session_id ?? body.sessionId ?? null,
      meta.track_id,
      body, // store full payload as JSONB
    ]);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("log error:", err);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

