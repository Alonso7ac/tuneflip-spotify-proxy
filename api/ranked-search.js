// api/ranked-search.js
// Ranked search with iTunes primary, Spotify fallback, then re-ranking using
// recent artist/album penalties + like/dislike + artist affinity.

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// ---- Tunables (server defaults; client can also send these) ----
const DEFAULTS = {
  market: "US",
  limit: 14,
  artistPenalty: 0.5,    // multiply if artist is in recent
  albumPenalty: 0.35,    // multiply if album is in recent
  likeBoost: 1.2,        // multiply when liked
  dislikePenalty: 0.4,   // multiply when disliked (i.e., < 1)
};

// -------- Helpers --------
function ok(res, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.status(200).json(data);
}
function bad(res, code, msg) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(code).json({ ok: false, error: msg });
}
function upscaleArtwork(url) {
  if (!url) return null;
  return url
    .replace(/\/[0-9]+x[0-9]+bb\.(jpg|png)/, "/600x600bb.$1")
    .replace(/100x100/, "600x600");
}
function marketToITunesCountry(market) {
  const allowed = ["US","GB","DE","FR","CA","AU","MX","BR","ES","IT","SE","NL"];
  return allowed.includes(market) ? market : "US";
}
function dedupeByPreview(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.previewUrl) continue;
    if (seen.has(it.previewUrl)) continue;
    seen.add(it.previewUrl);
    out.push(it);
  }
  return out;
}

// -------- Sources --------
async function searchITunes({ q, limit, market }) {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", q);
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("country", marketToITunesCountry(market));
  const r = await fetch(url.toString());
  if (!r.ok) return [];
  const data = await r.json();
  const items = (data.results || [])
    .filter((r) => !!r.previewUrl)
    .map((r) => ({
      title: r.trackName || "",
      artist: r.artistName || "",
      album: r.collectionName || "",
      albumArtUrl: upscaleArtwork(r.artworkUrl100),
      previewUrl: r.previewUrl || null,
      source: "itunes",
      sourceId: String(r.trackId || ""),
    }));
  return items;
}

let cachedToken = null, tokenExp = 0;
async function getSpotifyToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExp - 30_000) return cachedToken;
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  const body = new URLSearchParams({ grant_type: "client_credentials" }).toString();
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!r.ok) return null;
  const json = await r.json();
  cachedToken = json.access_token;
  tokenExp = Date.now() + (json.expires_in || 3600) * 1000;
  return cachedToken;
}
async function searchSpotify({ q, limit, market }) {
  const token = await getSpotifyToken();
  if (!token) return [];
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", `${q}`);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit * 2))));
  url.searchParams.set("include_external", "audio");
  url.searchParams.set("market", market || "US");
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const data = await r.json();
  const tracks = data?.tracks?.items || [];
  return tracks
    .filter((t) => !!t.preview_url)
    .map((t) => ({
      title: t.name || "",
      artist: (t.artists || []).map((a) => a.name).join(", "),
      album: t.album?.name || "",
      albumArtUrl: t.album?.images?.[0]?.url || null,
      previewUrl: t.preview_url || null,
      source: "spotify",
      sourceId: t.id,
    }));
}

// -------- Scoring --------
function scoreItems(items, profile, tunables) {
  const {
    recentArtists = [],
    recentAlbums = [],
    likes = {},               // { trackId: 1 | -1 }
    artistAffinity = {},      // { "Artist Name": number }
  } = profile || {};

  const {
    artistPenalty,
    albumPenalty,
    likeBoost,
    dislikePenalty,
  } = tunables;

  // Basic score with penalties and boosts
  return items.map((it) => {
    let s = 1;

    // Anti-repeat
    if (recentArtists.includes(it.artist)) s *= (1 - artistPenalty);
    if (recentAlbums.includes(it.album))  s *= (1 - albumPenalty);

    // Like / dislike (client uses a synthetic id; fall back to artist-based)
    const likeKey = it.previewUrl || `${it.artist}__${it.title}__${it.album}`.toLowerCase();
    const l = likes[likeKey] || 0;
    if (l > 0) s *= likeBoost;
    if (l < 0) s *= dislikePenalty;

    // Artist affinity
    const aff = artistAffinity[it.artist] || 0;
    s *= (1 + Math.max(-0.4, Math.min(0.6, aff)));

    return { ...it, _score: s };
  })
  .sort((a, b) => b._score - a._score);
}

// -------- Handler --------
module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return ok(res, { ok: true });

  try {
    // Support GET with query or POST with JSON body
    let q = "classic rock";
    let limit = DEFAULTS.limit;
    let market = DEFAULTS.market;
    let sourcePref = "itunes"; // "itunes" | "spotify" | "auto"
    let profile = {};
    let tunables = { ...DEFAULTS };

    if (req.method === "GET") {
      const qs = (req.url || "").split("?")[1] || "";
      const p = new URLSearchParams(qs);
      q = p.get("q") || q;
      limit = Number(p.get("limit") || limit);
      market = (p.get("market") || market).toUpperCase();
      sourcePref = p.get("source") || sourcePref;
      // optional penalties overrides
      if (p.get("artistPenalty")) tunables.artistPenalty = Number(p.get("artistPenalty"));
      if (p.get("albumPenalty")) tunables.albumPenalty = Number(p.get("albumPenalty"));
    } else if (req.method === "POST") {
      const body = await readJson(req);
      q = body.q || q;
      limit = Number(body.limit || limit);
      market = (body.market || market).toUpperCase();
      sourcePref = body.source || sourcePref;
      profile = body.profile || profile;
      tunables = { ...tunables, ...(body.tunables || {}) };
    }

    // 1) Fetch from preferred source (iTunes by default)
    let items = [];
    if (sourcePref === "itunes") {
      items = await searchITunes({ q, limit, market });
      if (items.length === 0) items = await searchSpotify({ q, limit, market });
    } else if (sourcePref === "spotify") {
      items = await searchSpotify({ q, limit, market });
      if (items.length === 0) items = await searchITunes({ q, limit, market });
    } else {
      // auto
      items = await searchITunes({ q, limit, market });
      if (items.length === 0) items = await searchSpotify({ q, limit, market });
    }

    items = dedupeByPreview(items);
    if (items.length === 0) return ok(res, { ok: true, items: [] });

    // 2) Rank with penalties/affinity
    const ranked = scoreItems(items, profile, tunables).slice(0, limit);

    return ok(res, { ok: true, items: ranked, source: ranked[0]?.source || "unknown" });
  } catch (e) {
    return bad(res, 500, e?.message || "Server error");
  }
};

async function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
  });
}
