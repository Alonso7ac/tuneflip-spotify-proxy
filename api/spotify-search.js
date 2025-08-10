// /api/spotify-search.js
export default async function handler(req, res) {
  try {
    // Parse query string safely (works on Vercel without a full URL)
    const qs = (req?.url || '').split('?')[1] || '';
    const params = new URLSearchParams(qs);

    const q = params.get('q') || 'classic rock';
    const limit = Number(params.get('limit') || 12);
    const market = (params.get('market') || 'US').toUpperCase();
    const playableOnly = params.get('playable') === 'true';

    // 1) Try SPOTIFY first
    const spotifyItems = await searchSpotify({ q, limit, market, playableOnly });
    if (spotifyItems.length > 0) {
      return res.status(200).json({ ok: true, source: 'spotify', items: spotifyItems });
    }

    // 2) Fall back to iTUNES if Spotify gave us nothing playable
    const itunesItems = await searchITunes({ q, limit, country: marketToITunesCountry(market) });
    if (itunesItems.length > 0) {
      return res.status(200).json({ ok: true, source: 'itunes', items: itunesItems });
    }

    return res.status(200).json({ ok: true, source: 'none', items: [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// ---------- Helpers ----------

async function searchSpotify({ q, limit, market, playableOnly }) {
  const token = await getSpotifyToken();
  if (!token) return [];

  // Broaden the query a bit to classic-rock era and allow external audio
  const fullQ = `${q} year:1960-1990`;
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('type', 'track');
  url.searchParams.set('q', fullQ);
  url.searchParams.set('limit', String(Math.min(50, Math.max(1, limit * 2))));
  url.searchParams.set('include_external', 'audio');
  if (market) url.searchParams.set('market', market);

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return [];
  const data = await r.json();
  const tracks = data?.tracks?.items || [];

  let items = tracks.map((t) => ({
    title: t?.name || '',
    artist: (t?.artists || []).map((a) => a.name).join(', '),
    album: t?.album?.name || '',
    albumArtUrl: pickAlbumImage(t?.album?.images),
    previewUrl: t?.preview_url || null,
    sourceId: t?.id,
  }));

  if (playableOnly) {
    items = items.filter((x) => !!x.previewUrl);
  }

  // Keep first `limit` items
  return items.slice(0, limit);
}

function pickAlbumImage(images) {
  // pick medium/large if available
  if (!images || !images.length) return null;
  const bySize = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  return bySize[Math.min(bySize.length - 1, 1)]?.url || bySize[0]?.url || null;
}

async function getSpotifyToken() {
  try {
    const cid = process.env.SPOTIFY_CLIENT_ID;
    const secret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!cid || !secret) return null;

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');

    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${cid}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.access_token || null;
  } catch {
    return null;
  }
}

// -------- iTunes fallback --------

async function searchITunes({ q, limit, country }) {
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', q);
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('country', country || 'US');

  const r = await fetch(url.toString());
  if (!r.ok) return [];
  const data = await r.json();
  const results = data?.results || [];

  const items = results
    .filter((r) => !!r?.previewUrl) // playable
    .map((r) => ({
      title: r?.trackName || '',
      artist: r?.artistName || '',
      album: r?.collectionName || '',
      albumArtUrl: upscaleArtwork(r?.artworkUrl100),
      previewUrl: r?.previewUrl || null,
      sourceId: String(r?.trackId || ''),
    }));

  return items.slice(0, limit);
}

function upscaleArtwork(url) {
  if (!url) return null;
  // 100x100 -> 600x600
  return url.replace(/\/[0-9]+x[0-9]+bb\.(jpg|png)/, '/600x600bb.$1').replace(/100x100/, '600x600');
}

function marketToITunesCountry(market) {
  // iTunes uses country codes; many overlap. Fallback to US.
  const allowed = ['US', 'GB', 'DE', 'FR', 'CA', 'AU', 'MX', 'BR', 'ES', 'IT', 'SE', 'NL'];
  return allowed.includes(market) ? market : 'US';
}
