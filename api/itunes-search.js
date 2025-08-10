// /api/itunes-search.js
// Proxy iTunes Search with optional genreId filtering + fallback to RSS Top Songs when search returns 0.
// Accepts: q (optional), genreId (optional), limit (default 20), country (default US), playable (default true)

export default async function handler(req, res) {
  try {
    const {
      q = '',
      genreId,
      limit = '20',
      country = 'US',
      playable = 'true',
    } = req.query;

    const max = Number(limit) || 20;

    // --- 1) Try iTunes Search API
    const params = new URLSearchParams();
    params.set('country', country);
    params.set('media', 'music');
    params.set('entity', 'song');
    params.set('limit', String(max));
    if (q) params.set('term', q);
    if (genreId) params.set('genreId', String(genreId));

    const searchUrl = `https://itunes.apple.com/search?${params.toString()}`;

    let items = [];
    try {
      const r = await fetch(searchUrl);
      const data = await r.json();
      items = (data?.results || []).map((it) => ({
        id: String(it.trackId ?? it.collectionId ?? it.artistId ?? it.trackName),
        sourceId: String(it.trackId ?? ''),
        title: it.trackName,
        artist: it.artistName,
        album: it.collectionName,
        albumArtUrl:
          it.artworkUrl100?.replace('100x100bb.jpg', '1000x1000bb.jpg') ||
          it.artworkUrl100,
        previewUrl: it.previewUrl,
        storeUrl: it.trackViewUrl || it.collectionViewUrl,
        source: 'itunes',
        albumType: (it.collectionType || '').toLowerCase(),
        collectionType: it.collectionType || '',
      }));
    } catch {
      // ignore, we'll try RSS fallback
    }

    if (playable === 'true') {
      items = items.filter((x) => !!x.previewUrl);
    }

    // If Search API returned something, we’re done
    if (items.length > 0) {
      return res.status(200).json({ ok: true, source: 'itunes', items });
    }

    // --- 2) Fallback to Apple RSS Top Songs for the genre (works without q OR when search was empty)
    if (genreId) {
      const rssUrl = `https://itunes.apple.com/${country.toLowerCase()}/rss/topsongs/limit=${encodeURIComponent(
        String(Math.max(20, max))
      )}/genre=${encodeURIComponent(String(genreId))}/json`;

      const r2 = await fetch(rssUrl);
      const data2 = await r2.json();

      const rssItems = (data2?.feed?.entry || []).map((e) => {
        const title = e['im:name']?.label;
        const artist = e['im:artist']?.label;
        const album = e['im:collection']?.name?.label || e?.title?.label;
        const images = Array.isArray(e['im:image']) ? e['im:image'] : [];
        const albumArtUrl = images.length ? images[images.length - 1]?.label : undefined;

        // Try to find an audio preview
        let previewUrl;
        const links = e.link;
        if (Array.isArray(links)) {
          const audioLink = links.find((lnk) => lnk?.attributes?.type?.includes('audio'));
          previewUrl = audioLink?.attributes?.href || links[1]?.attributes?.href;
        } else if (links?.attributes?.type?.includes?.('audio')) {
          previewUrl = links.attributes.href;
        }

        const storeUrl =
          e.id?.label || (Array.isArray(links) ? links[0]?.attributes?.href : undefined);

        return {
          id: e.id?.attributes?.['im:id'] || title,
          sourceId: e.id?.attributes?.['im:id'] || '',
          title,
          artist,
          album,
          albumArtUrl,
          previewUrl,
          storeUrl,
          source: 'itunes-rss',
          albumType: 'album',
          collectionType: 'Album',
        };
      });

      const out = playable === 'true' ? rssItems.filter((x) => !!x.previewUrl) : rssItems;
      return res
        .status(200)
        .json({ ok: true, source: 'itunes-rss', items: out.slice(0, max) });
    }

    // If no genre to fall back to, return empty
    return res.status(200).json({ ok: true, source: 'itunes', items: [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
