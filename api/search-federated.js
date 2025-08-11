// File: /api/search-federated.js
// Purpose: Wide-coverage search that fans out to Spotify, iTunes, YouTube, and MusicBrainz,
// then merges/dedupes results by normalized title+artist. Designed for discovery coverage.
//
// Env vars (optional but recommended):
//   SPOTIFY_CLIENT_ID
//   SPOTIFY_CLIENT_SECRET
//   YOUTUBE_API_KEY
//
// Notes:
// - We avoid Apple Music API (JWT) to keep setup simple; iTunes Search requires no keys.
// - YouTube Data API is used only for links/coverage (no in-app audio).
// - MusicBrainz is rate-limited; we keep calls light and set a UA header.
// - All responses are Cache-Control: no-store to avoid stale results.

const fetchJson = async (url, options = {}) => {
  const res = await fetch(url, { ...options });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

const norm = (s = '') => s
  .toLowerCase()
  .replace(/\([^)]*\)/g, ' ') // remove parentheses content
  .replace(/\[[^\]]*\]/g, ' ') // remove bracketed
  .replace(/[^a-z0-9]+/g, ' ') // non-alnum to space
  .replace(/\s+/g, ' ') // collapse
  .trim();

const makeKey = (title, artist) => `${norm(title)}__${norm(artist)}`;

async function searchSpotify(q, limit = 10) {
  const cid = process.env.SPOTIFY_CLIENT_ID;
  const sec = process.env.SPOTIFY_CLIENT_SECRET;
  if (!cid || !sec) return [];

  // Client Credentials token
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cid, client_secret: sec })
  });
  if (!tokenRes.ok) throw new Error(`Spotify token: ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();

  const url = `https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: 'track', limit: String(Math.min(limit, 20)), market: 'US' })}`;
  const json = await fetchJson(url, { headers: { Authorization: `Bearer ${access_token}` } });
  const items = (json.tracks?.items || []).map(t => {
    const primaryArtist = t.artists?.[0]?.name || '';
    const artwork = t.album?.images?.[0]?.url || '';
    return {
      source: 'spotify',
      title: t.name,
      artist: primaryArtist,
      album: t.album?.name || '',
      artwork,
      links: { spotify: t.external_urls?.spotify },
      ids: { spotify: t.id },
      // ISRC may be absent in search payloads; we keep undefined if not present
      isrc: t.external_ids?.isrc
    };
  });
  return items;
}

async function searchITunes(q, limit = 10) {
  const params = new URLSearchParams({ term: q, entity: 'song', limit: String(Math.min(limit, 25)) });
  const url = `https://itunes.apple.com/search?${params.toString()}`;
  const json = await fetchJson(url);
  return (json.results || []).map(r => ({
    source: 'itunes',
    title: r.trackName || r.collectionName || '',
    artist: r.artistName || '',
    album: r.collectionName || '',
    artwork: r.artworkUrl100 || r.artworkUrl60 || '',
    links: { itunes: r.trackViewUrl || r.collectionViewUrl },
    ids: { itunesTrackId: r.trackId, itunesCollectionId: r.collectionId },
    previewUrl: r.previewUrl // sometimes present
  }));
}

async function searchYouTube(q, limit = 6) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: String(Math.min(limit, 10)), q });
  const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}&key=${key}`;
  const json = await fetchJson(url);
  return (json.items || []).map(item => ({
    source: 'youtube',
    title: item.snippet?.title || '',
    artist: item.snippet?.channelTitle || '',
    album: '',
    artwork: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
    links: { youtube: `https://www.youtube.com/watch?v=${item.id?.videoId}` },
    ids: { youtubeVideoId: item.id?.videoId }
  }));
}

async function searchMusicBrainz(q, limit = 6) {
  const params = new URLSearchParams({ query: q, fmt: 'json', limit: String(Math.min(limit, 10)) });
  const url = `https://musicbrainz.org/ws/2/recording?${params.toString()}`;
  const json = await fetch(url, { headers: { 'User-Agent': 'TuneFlip/1.0 (contact@tuneflip.example)' } }).then(r => r.json());
  const recs = json.recordings || [];
  return recs.map(r => ({
    source: 'musicbrainz',
    title: r.title || '',
    artist: (r['artist-credit']?.[0]?.name) || (r.artists?.[0]?.name) || '',
    album: r.releases?.[0]?.title || '',
    artwork: '',
    links: { musicbrainz: r.id ? `https://musicbrainz.org/recording/${r.id}` : undefined },
    ids: { musicbrainzId: r.id },
    isrc: (r.isrcs && r.isrcs[0]) || undefined
  }));
}

function dedupeMerge(lists) {
  const map = new Map();
  const push = (item) => {
    const key = makeKey(item.title || '', item.artist || '');
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, item);
      return;
    }
    // merge fields from different sources
    const prev = map.get(key);
    map.set(key, {
      ...prev,
      artwork: prev.artwork || item.artwork,
      album: prev.album || item.album,
      isrc: prev.isrc || item.isrc,
      previewUrl: prev.previewUrl || item.previewUrl,
      links: { ...(prev.links || {}), ...(item.links || {}) },
      ids: { ...(prev.ids || {}), ...(item.ids || {}) }
    });
  };
  lists.flat().forEach(push);
  return Array.from(map.values());
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = (req.query.q || '').toString().trim();
    const limit = parseInt(req.query.limit || '20', 10);
    if (!q) return res.status(400).json({ error: 'Missing q' });

    const [sp, it, yt, mb] = await Promise.allSettled([
      searchSpotify(q, limit),
      searchITunes(q, limit),
      searchYouTube(q, Math.min(6, limit)),
      searchMusicBrainz(q, Math.min(6, limit))
    ]);

    const results = dedupeMerge([
      sp.status === 'fulfilled' ? sp.value : [],
      it.status === 'fulfilled' ? it.value : [],
      yt.status === 'fulfilled' ? yt.value : [],
      mb.status === 'fulfilled' ? mb.value : []
    ]).slice(0, limit);

    res.status(200).json({ q, results });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
};
