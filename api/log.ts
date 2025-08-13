// api/log.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { pool } from "../lib/db";

// Normalize artwork to higher‑res if possible
function upscaleArt(url?: string | null) {
  if (!url) return null;
  return url.replace(/\/[0-9]+x[0-9]+bb\.jpg$/i, "/600x600bb.jpg");
}

// Extract track metadata from flexible payload shapes
function extractTrackMeta(body: any) {
  const src = body?.track ?? body ?? {};
  const track_id = String(src.track_id ?? src.trackId ?? src.id ?? "").trim() || null;

  const title = src.title ?? src.trackName ?? src.name ?? null;
  const artist = src.artist ?? src.artistName ?? null;
  const album = src.album ?? src.collectionName ?? null;
  const art_url = upscaleArt(
    src.art_url ?? src.artUrl ?? src.artworkUrl600 ?? src.artworkUrl100 ?? null
  );

  return { track_id, title, artist, album, art_url };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Cache-Control", "no-store");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // lightweight auth via INGEST_KEY (same as other endpoints)
    const wantAuth = !!process.env.INGEST_KEY;
    const okAuth =
      !wantAuth ||
      req.headers.authorization === `Bearer ${process.env.INGEST_KEY}` ||
      (typeof req.headers["x-ingest-key"] === "string" &&
        req.headers["x-ingest-key"] === process.env.INGEST_KEY);

    if (!okAuth) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Body should already be JSON if Content-Type: application/json
    const body: any = req.body || {};
    const meta = extractTrackMeta(body);

    // Upsert minimal metadata into public.tracks (only columns that exist)
    if (meta.track_id) {
      const upsertSQL = `
        INSERT INTO public.tracks (track_id, title, artist, album, art_url)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (track_id) DO UPDATE SET
          title = COALESCE(EXCLUDED.title, public.tracks.title),
          artist = COALESCE(EXCLUDED.artist, public.tracks.artist),
          album = COALESCE(EXCLUDED.album, public.tracks.album),
          art_url = COALESCE(EXCLUDED.art_url, public.tracks.art_url)
      `;
      await pool.query(upsertSQL, [
        meta.track_id,
        meta.title,
        meta.artist,
        meta.album,
        meta.art_url,
      ]);
    }

    // Insert event (adjust columns/types only if your schema differs)
    const insertEventSQL = `
      INSERT INTO public.events (ts, type, session_id, track_id, payload)
      VALUES (NOW(), $1, $2, $3, $4)
    `;
    await pool.query(insertEventSQL, [
      body.type ?? "unknown",
      body.session_id ?? body.sessionId ?? null,
      meta.track_id,
      body, // stored as JSONB
    ]);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("log error:", err?.message, err?.stack);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

