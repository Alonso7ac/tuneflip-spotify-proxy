// /api/itunes-genres.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const APPLE_GENRES_URL =
  'https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres?cc=US&lang=en-US';

type GenreNode = {
  id: string;
  name: string;
  url?: string;
  [key: string]: any;
};

function flattenMusic(node: GenreNode, path: string[] = []): Array<{ id: string; name: string; path: string[] }> {
  const results: Array<{ id: string; name: string; path: string[] }> = [];
  const children = Object.entries(node || {})
    .filter(([k]) => /^\d+$/.test(k))
    .map(([, v]) => v as GenreNode);

  for (const child of children) {
    const p = [...path, child.name];
    results.push({ id: child.id, name: child.name, path: p });
    results.push(...flattenMusic(child, p));
  }
  return results;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const r = await fetch(APPLE_GENRES_URL, { next: { revalidate: 60 * 60 } as any });
    const json = (await r.json()) as Record<string, GenreNode>;
    let musicRoot: GenreNode | undefined = json['34'];
    if (!musicRoot) {
      musicRoot = Object.values(json).find((n: any) => n?.name?.toLowerCase() === 'music') as GenreNode | undefined;
    }
    if (!musicRoot) {
      return res.status(502).json({ ok: false, error: 'Music root not found' });
    }
    const flat = flattenMusic(musicRoot).map(g => ({
      id: g.id,
      name: g.name,
      path: g.path,
      label: g.path.join(' ▸ ')
    }));
    return res.status(200).json({ ok: true, items: flat });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
