export default async function handler(req, res) {
  const { q: query, limit = 10 } = req.query;

  if (!query) {
    return res.status(400).json({ ok: false, error: "Missing query parameter" });
  }

  try {
    // Get access token from Spotify
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(
          process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
        ).toString("base64"),
      },
      body: "grant_type=client_credentials",
    });

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Search request with market filter
    const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&market=US`;

    const data = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then(res => res.json());

    // Include tracks even if preview_url is null
    const items = (data.tracks?.items || []).map(track => ({
      title: track.name,
      artist: track.artists.map(a => a.name).join(", "),
      album: track.album.name,
      albumArtUrl: track.album.images[0]?.url,
      previewUrl: track.preview_url || null
    }));

    res.status(200).json({ ok: true, items });

  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}

