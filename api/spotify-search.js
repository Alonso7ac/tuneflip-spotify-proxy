
// api/spotify-search.js
// Vercel Serverless function (Node.js). Finds tracks with playable previews.

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 30_000) return cachedToken;

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization":
        "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token error ${res.status}: ${text}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return cachedToken;
}

function ok(res, data) {
  // CORS + CDN cache (5 min) for your production domain/app
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.status(200).json(data);
}

function bad(res, code, msg) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(code).json({ ok: false, error: msg });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return ok(res, { ok: true });

  try {
    const q = (req.query.q || "classic rock").toString();
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 20);
    const market = (req.query.market || "US").toString();

    const token = await getToken();

    // Random offset (0..1000) to avoid always hitting the same first page
    const offset = Math.floor(Math.random() * 20) * 50; // 0,50,100,...,950

    const params = new URLSearchParams({
      q,
      type: "track",
      limit: String(limit),
      market,
      include_external: "audio",
      offset: String(offset),
    });

    const sres = await fetch(`https://api.spotify.com/v1/search?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (sres.status === 429) {
      // Rate limited – tell client to fall back
      return ok(res, { ok: true, items: [] });
    }
    if (!sres.ok) {
      const text = await sres.text().catch(() => "");
      return bad(res, sres.status, `Spotify search failed: ${text}`);
    }

    const data = await sres.json();
    const items = (data.tracks?.items ?? []).map((t) => {
      // Prefer album image, fall back to artist image if any
      const albumImg = t.album?.images?.[0]?.url || null;
      const artistImg = t.artists?.[0]?.images?.[0]?.url || null;
      return {
        title: t.name,
        artist: t.artists?.map((a) => a.name).join(", ") || "",
        album: t.album?.name || "",
        albumArtUrl: albumImg || artistImg || null,
        previewUrl: t.preview_url || null,
      };
    });

    // Only return playable items (preview_url present)
    const playable = items.filter((i) => !!i.previewUrl);

    return ok(res, { ok: true, items: playable });
  } catch (e) {
    return bad(res, 500, e.message || "Unknown error");
  }
};
