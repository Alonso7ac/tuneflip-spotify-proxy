import { pool } from "../lib/db";

// weights (tune later)
const W = {
  like: 3.0,
  dwell_ms: 0.001,   // +0.001 per ms played (i.e., +1 per second)
  skip: -2.5,
  nope: -4.0,
  recent_penalty: -1.0,
};

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const userId = (req.query.user_id as string) || "anon";
  const limit = Math.min(parseInt((req.query.limit as string) || "25", 10), 100);

  const client = await pool.connect();
  try {
    // 1) pull user signals (last 30 days), plus global popularity
    const { rows: userSignals } = await client.query(
      `
      with recent as (
        select
          (payload->>'track_id') as track_id,
          type,
          coalesce((payload->>'ms_played_chunk')::int, 0) as ms_played,
          ts
        from public.events
        where user_id = $1
          and (payload->>'track_id') is not null
          and ts > extract(epoch from (now() - interval '30 days'))*1000
      ),
      agg as (
        select
          track_id,
          sum(case when type = 'like' then 1 else 0 end)          as likes,
          sum(case when type = 'nope' then 1 else 0 end)          as nopes,
          sum(case when type in ('skip','dislike') then 1 else 0 end) as skips,
          sum(ms_played)                                          as ms_played,
          max(ts)                                                 as last_ts
        from recent
        group by track_id
      ),
      global_pop as (
        select
          (payload->>'track_id') as track_id,
          count(*) as global_events,
          sum(case when type = 'like' then 1 else 0 end) as global_likes
        from public.events
        where (payload->>'track_id') is not null
          and ts > extract(epoch from (now() - interval '30 days'))*1000
        group by 1
      )
      select
        coalesce(a.track_id, g.track_id)      as track_id,
        coalesce(a.likes,0)                   as likes,
        coalesce(a.nopes,0)                   as nopes,
        coalesce(a.skips,0)                   as skips,
        coalesce(a.ms_played,0)               as ms_played,
        coalesce(a.last_ts,0)                 as last_ts,
        coalesce(g.global_events,0)           as global_events,
        coalesce(g.global_likes,0)            as global_likes
      from agg a
      full outer join global_pop g on g.track_id = a.track_id
      `,
      [userId]
    );

    // 2) simple scoring
    const now = Date.now();
    const seenCutoffMs = 1000 * 60 * 60 * 12; // penalize if seen in last 12h

    const scored = userSignals.map((r) => {
      const recentPenalty = r.last_ts && now - Number(r.last_ts) < seenCutoffMs ? W.recent_penalty : 0;
      const score =
        W.like * Number(r.likes) +
        W.dwell_ms * Number(r.ms_played) +
        W.skip * Number(r.skips) +
        W.nope * Number(r.nopes) +
        recentPenalty +
        // small popularity prior so cold users still get something
        Math.log10(1 + Number(r.global_events)) + 0.5 * Math.log10(1 + Number(r.global_likes));

      return { track_id: r.track_id, score };
    });

    // 3) fallback if user has nothing: use global popularity
    let results = scored
      .filter((x) => x.track_id) // defensive
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (results.length < limit) {
      const { rows: global } = await client.query(
        `
        select (payload->>'track_id') as track_id,
               count(*) as cnt,
               sum(case when type = 'like' then 1 else 0 end) as likes
        from public.events
        where (payload->>'track_id') is not null
          and ts > extract(epoch from (now() - interval '30 days'))*1000
        group by 1
        order by cnt desc, likes desc
        limit $1
        `,
        [limit * 2]
      );
      const have = new Set(results.map((r) => r.track_id));
      for (const g of global) {
        if (!have.has(g.track_id)) results.push({ track_id: g.track_id, score: 0 });
        if (results.length >= limit) break;
      }
    }

    return res.status(200).json({ user_id: userId, count: results.length, tracks: results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "recs_failed" });
  } finally {
    client.release();
  }
}
