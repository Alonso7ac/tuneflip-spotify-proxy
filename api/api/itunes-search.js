// /api/itunes-search.js

export default async function handler(req, res) {
  try {
    const {
      q = '',
      genreId,
      limit = '20',
      country = 'US',
      playable = 'true'
    } = req.query;

    const params = new URLSearchParams();
    params.set('country', country);
    params.set('media', 'music');
    params.set('entity', 'song');
    params.set('limit', String(limit || 20));
    if (q) params.set('term', q);
    if (genreId) params.set('genreId', String(genreId));

    const url = `https://itunes.apple.com/search?${params.toString()}`;
    const r = await fetch(url);
    const data = await r.json();

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

