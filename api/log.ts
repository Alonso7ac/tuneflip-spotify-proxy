import { pool } from "../lib/db";
export default async function handler(req: any, res: any) {

  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const wantAuth = !!process.env.INGEST_KEY;
  const okAuth =
    !wantAuth ||
    req.headers.authorization === `Bearer ${process.env.INGEST_KEY}` ||
    req.headers["x-ingest-key"] === process.env.INGEST_KEY;
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });

  const body = req.body;
  const events = Array.isArray(body?.events) ? body.events : Array.isArray(body) ? body : null;
  if (!events || events.length === 0) return res.status(400).json({ error: "No events provided" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const e of events) {
      if (!e?.type || !e?.ts) continue;
      await client.query(
        `insert into public.events (user_id, session_id, type, track_id, ts, payload)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          e.user_id ?? null,
          e.session_id ?? null,
          String(e.type),
          e.track_id ? String(e.track_id) : null,
          Number(e.ts),
          JSON.stringify(e),

        ]
      );
      inserted++;
    }
    await client.query("COMMIT");
    return res.status(200).json({ status: "ok", inserted });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return res.status(500).json({ error: "insert_failed" });
  } finally {
    client.release();
  }
}
