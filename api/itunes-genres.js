// /api/itunes-genres.js
// Returns the iTunes "Music" genres flattened to an array.
// Source: Apple's (undocumented) genres service.

const APPLE_GENRES_URL =
  'https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres?cc=US&lang=en-US';

// Flatten only nodes that are numeric keys (that's how Apple encodes children)
function flattenMusic(node, path = []) {
  const results = [];
  if (!node || typeof node !== 'object') return results;

  const children = Object.entries(node)
    .filter(([k]) => /^\d+$/.test(k))
    .map(([, v]) => v);

  for (const child of children) {
    const p = [...path, child.name];
    results.push({ id: String(child.id), name: child.name, path: p });
    results.push(...flattenMusic(child, p));
  }
  return results;
}

export default async function handler(req, res) {
  // Disable CDN/browser caching completely
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const r = await fetch(APPLE_GENRES_URL, { cache: 'no-store' });
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Upstream HTTP ${r.status}` });
    }
    const json = await r.json();

    // Music root is usually id "34". If missing, fall back by name.
    let musicRoot = json['34'];
    if (!musicRoot) {
      musicRoot = Object.values(json).find(
        (n) => n && typeof n === 'object' && String(n.name).toLowerCase() === 'music'
      );
    }
    if (!musicRoot) {
      return res.status(502).json({ ok: false, error: 'Music root not found' });
    }

    const flat = flattenMusic(musicRoot).map((g) => ({
      id: g.id,
      name: g.name,
      path: g.path,
      label: g.path.join(' ▸ '), // e.g. "Music ▸ Rock ▸ Classic Rock"
    }));

    return res.status(200).json({ ok: true, items: flat });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: String(e?.message ?? e) });
  }
}
