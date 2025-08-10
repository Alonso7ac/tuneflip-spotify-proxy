// /api/itunes-search.js
// Proxy iTunes Search with optional genreId filtering + fallback to RSS Top Songs when q is empty.
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

    // --- 1) Try normal Search API first (works great when a "term" exists)
    const params = new URLSearchParams();
    params.set('country', country);
    params.set('media', 'music');
    params.set('entity', 'song');
    params.set('limit', String(limit || 20));
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
    } catch (_) {
      // ignore, we’ll try RSS fallback below
    }

    // Filter for playable if requested
    if (playable === 'true') {
      items = items.filter((x) => !!x.previewUrl);
    }

    // If we got something (or q was provided), return now
    if (items.length > 0 || q) {
      return res.status(200).json({ ok: true, source: 'itunes', items });
    }

    // --- 2) Fallback: Apple RSS "Top Songs" for a genre (works when q is empty)
    if (genreId) {
      const rssUrl = `https://itunes.apple.com/${country.toLowerCase()}/rss/topsongs/limit=${encodeURIComponent(
        String(Math.max(20, Number(limit) || 20))
      )}/genre=${encodeURIComponent(String(genreId))}/json`;

      const r2 = await fetch(rssUrl);
      const data2 = await r2.json();

      const rssItems = (data2?.feed?.entry || []).map((e) => {
        // RSS structure is different
        const title = e['im:name']?.label;
        const artist = e['im:artist']?.label;
        const album = e['im:collection']?.name?.label || e?.title?.label;
        const art = Array.isArray(e['im:image'])
          ? e['im:image'][e['im:image'].length - 1]?.label
          : undefined;
        const links = e.link;
        // find preview link (type audio/m4a) if present
        let previewUrl;
        if (Array.isArray(links)) {
          const audioLink = links.find(
            (lnk) => lnk?.attributes?.type?.includes('audio')
          );
          previewUrl = audioLink?.attributes?.href;
        } else if (links?.attributes?.type?.includes?.('audio')) {
          previewUrl = links.attributes.href;
        }

        // Fallback: the preview sometimes is under "link[1]"
        if (!previewUrl && Array.isArray(links) && links[1]?.attributes?.href) {
          previewUrl = links[1].attributes.href;
        }

        const storeUrl =
          e.id?.label || (Array.isArray(links) ? links[0]?.attributes?.href : undefined);

        return {
          id: e.id?.attributes?.['im:id'] || title,
          sourceId: e.id?.attributes?.['im:id'] || '',
          title,
          artist,
          album,
          albumArtUrl: art,
          previewUrl,
          storeUrl,
          source: 'itunes-rss',
          albumType: 'album',
          collectionType: 'Album',
        };
      });

      let finalItems = rssItems;
      if (playable === 'true') {
        finalItems = finalItems.filter((x) => !!x.previewUrl);
      }

      return res.status(200).json({ ok: true, source: 'itunes-rss', items: finalItems.slice(0, Number(limit) || 20) });
    }

    // If still nothing…
    return res.status(200).json({ ok: true, source: 'itunes', items: [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
