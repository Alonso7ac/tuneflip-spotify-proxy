// /api/itunes-search.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const {
      q = '',
      genreId,
      limit = '20',
      country = 'US',
      playable = 'true'
    } = req.query as Record<string, string>;

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

    const items = (data?.results || [])
      .filter((it: any) => (playable !== 'true') || !!it.previewUrl)
      .map((it: any) => ({
        id: String(it.trackId ?? it.collectionId ?? it.artistId ?? it.trackName),
        sourceId: String(it.trackId ?? ''),
        title: it.trackName,
        artist: it.artistName,
        album: it.collectionName,
        albumArtUrl: it.artworkUrl100?.replace('100x100bb.jpg', '1000x1000bb.jpg') ?? it.artworkUrl100,
        previewUrl: it.previewUrl,
        storeUrl: it.trackViewUrl || it.collectionViewUrl,
        source: 'itunes',
        albumType: (it.collectionType || '').toLowerCase(),
        collectionType: it.collectionType || ''
      }));

    return res.status(200).json({ ok: true, source: 'itunes', items });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
