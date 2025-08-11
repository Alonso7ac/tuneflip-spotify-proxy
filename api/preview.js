// File: /api/preview.js
// Purpose: Resolve an in-app 30s audio preview URL for a given track.
// Strategy: Deezer (preview) -> Napster (previewURL) -> iTunes (previewUrl)
// Inputs: isrc (optional), artist (optional), title (optional), album (optional)
// Env vars (optional): NAPSTER_API_KEY

const tryDeezer = async ({ artist, title }) => {
  const queries = [];
  if (artist && title) {
    queries.push(`track:"${title}" artist:"${artist}"`);
    queries.push(`${artist} ${title}`);
  } else if (title) {
    queries.push(title);
  }
  for (const q of queries) {
    const url = `https://api.deezer.com/search?${new URLSearchParams({ q })}`;
    const json = await fetchJson(url);
    const hit = (json.data || []).find(t => t?.preview);
    if (hit?.preview) return { url: hit.preview, source: 'deezer', format: 'audio/mpeg' };
  }
  return null;
};

const tryNapster = async ({ artist, title }) => {
  const key = process.env.NAPSTER_API_KEY;
  if (!key) return null;
  const q = [artist, title].filter(Boolean).join(' ');
  const base = 'https://api.napster.com/v2.2/search/verbose';
  const url = `${base}?${new URLSearchParams({ apikey: key, query: q, type: 'track', per_type_limit: '3' })}`;
  const json = await fetchJson(url);
  const tracks = json.search?.data?.tracks || json.tracks || [];
  const hit = tracks.find(t => t.previewURL);
  if (hit?.previewURL) return { url: hit.previewURL, source: 'napster', format: 'audio/mpeg' };
  return null;
};

const tryITunes = async ({ artist, title }) => {
  const term = [artist, title].filter(Boolean).join(' ');
  if (!term) return null;
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term, entity: 'song', limit: '5' })}`;
  const json = await fetchJson(url);
  const hit = (json.results || []).find(r => r.previewUrl);
  if (hit?.previewUrl) return { url: hit.previewUrl, source: 'itunes', format: 'audio/aac' };
  return null;
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const title = (req.query.title || '').toString().trim();
    const artist = (req.query.artist || '').toString().trim();
    const album = (req.query.album || '').toString().trim();
    const isrc = (req.query.isrc || '').toString().trim();

    if (!title && !artist && !isrc) {
      return res.status(400).json({ error: 'Provide at least title or artist or isrc' });
    }

    // Try chain
    const ctx = { title, artist, album, isrc };
    const order = [tryDeezer, tryNapster, tryITunes];
    for (const fn of order) {
      try {
        const r = await fn(ctx);
        if (r && r.url) return res.status(200).json(r);
      } catch (_) { /* continue */ }
    }

    res.status(404).json({ error: 'No preview found' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
};


// ------- Client integration notes (React Native / Expo) -------
// 1) When you render a search result or a feed item that lacks previewUrl,
//    call GET /api/preview?artist=...&title=... (and album if helpful) to resolve a snippet.
// 2) Cache previews per track key locally to reduce latency and API calls.
// 3) Keep using expo-av for playback; previews from Deezer/Napster/iTunes are simple MP3/AAC URLs.
