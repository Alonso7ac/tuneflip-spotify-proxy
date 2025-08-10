// /api/itunes-search.js
// Proxy iTunes Search with optional genreId filtering + fallback to RSS Top Songs when search returns 0.
// Accepts: q (optional), genreId (optional), limit (default 20), country (default US),
//          playable (default true), seed (optional number for deterministic shuffle)

function seededRand(seed) {
  // xorshift32-ish PRNG, stable for a given seed
  let x = (Number(seed) >>> 0) || (Date.now() >>> 0);
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0xFFFFFFFF;
  };
}
function shuffleInPlace(arr, seed) {
  const rnd = seededRand(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
function isCompilation(it) {
  const t1 = (it.albumType || '').toLowerCase();
  const t2 = (it.collectionType || '').toLowerCase();
  return t1.includes('compilation') || t2.includes('compilation');
}

export default async function handler(req, res) {
  // Disable CDN/browser caching completely
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const {
      q = '',
      genreId,
      limit = '20',
      country = 'US',
      playable = 'true',
      seed,                 // optional; pass from client for per-launch/day randomness
    } = req.query;

    const max = Number(limit) || 20;
    const shuffleSeed = seed ?? Date.now(); // if none provided, use current time

    // --- 1) Try iTunes Search API
    const params = new URLSearchParams();
    params.set('country', country);
    params.set('media', 'music');
    params.set('entity', 'song');
    params.set('limit', String(Math.max(max, 60))); // fetch extra; we'll dedupe and order
    if (q) params.set('term', q);
    if (genreId) params.set('genreId', String(genreId));

    const searchUrl = `https://itunes.apple.com/search?${params.toString()}`;

    let items = [];
    try {
      const r = await fetch(searchUrl, { cache: 'no-store' });
      if (r.ok) {
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
      }
    } catch {
      // ignore, we'll try RSS fallback
    }

    if (playable === 'true') {
      items = items.filter((x) => !!x.previewUrl);
    }

    // If Search API returned something, shuffle + dedupe + deprioritize compilations
    if (items.length > 0) {
      // Dedupe first
      items = uniqueBy(items, (t) =>
        `${(t.title||'').trim()}|${(t.artist||'').trim()}|${(t.album||'').trim()}`.toLowerCase()
      );
      // Split albums vs compilations and shuffle each bucket
      const albums = items.filter((it) => !isCompilation(it));
      const comps  = items.filter((it) =>  isCompilation(it));
      shuffleInPlace(albums, shuffleSeed);
      shuffleInPlace(comps,  shuffleSeed * 101); // different stream

      const ordered = [...albums, ...comps].slice(0, max);
      return res.status(200).json({ ok: true, source: 'itunes', items: ordered });
    }

    // --- 2) Fallback to Apple RSS Top Songs for the genre (works without q OR when search was empty)
    if (genreId) {
      const rssUrl = `https://itunes.apple.com/${country.toLowerCase()}/rss/topsongs/limit=${encodeURIComponent(
        String(Math.max(60, max))
      )}/genre=${encodeURIComponent(String(genreId))}/json`;

      const r2 = await fetch(rssUrl, { cache: 'no-store' });
      const data2 = await r2.json();

      let rssItems = (data2?.feed?.entry || []).map((e) => {
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

      if (playable === 'true') {
        rssItems = rssItems.filter((x) => !!x.previewUrl);
      }

      // Dedupe, shuffle, deprioritize comps (RSS is mostly albums, but keep logic consistent)
      rssItems = uniqueBy(rssItems, (t) =>
        `${(t.title||'').trim()}|${(t.artist||'').trim()}|${(t.album||'').trim()}`.toLowerCase()
      );
      const albums = rssItems.filter((it) => !isCompilation(it));
      const comps  = rssItems.filter((it) =>  isCompilation(it));
      shuffleInPlace(albums, shuffleSeed);
      shuffleInPlace(comps,  shuffleSeed * 101);

      const ordered = [...albums, ...comps].slice(0, max);
      return res.status(200).json({ ok: true, source: 'itunes-rss', items: ordered });
    }

    // If no genre to fall back to, return empty
    return res.status(200).json({ ok: true, source: 'itunes', items: [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
