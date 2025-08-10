export default async function handler(req, res) {
  try {
    const { q = '', genre = '', limit = '25' } = req.query;

    const token = await getToken();
    const searchQ = q ? q : `genre:"${genre}"`;
    const url =
      `https://api.spotify.com/v1/search?type=track&limit=${encodeURIComponent(limit)}&q=${encodeURIComponent(searchQ)}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();

    const items = (d?.tracks?.items || [])
      .map((t) => ({
        id: t.id,
        title: t.name,
        artist: t.artists?.map((a) => a.name).join(', '),
        album: t.album?.name,
        year: t.album?.release_date?.slice(0, 4) || null,
        albumArtUrl: t.album?.images?.[0]?.url || null,
        previewUrl: t.preview_url || null,
        spotifyUrl: t.external_urls?.spotify || null,
      }))
      .filter((x) => x.previewUrl);

    res.status(200).json({ ok: true, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
}

async function getToken() {
  const creds = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const j = await r.json();
  if (!j.access_token) throw new Error('Spotify token error');
  return j.access_token;
}
