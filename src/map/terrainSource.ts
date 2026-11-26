import * as maplibregl from 'maplibre-gl';

// High-res terrain built by scripts/build-terrain.ts (GSI DEM10B → Terrarium + AO),
// with Mapzen/AWS Terrarium tiles as fallback wherever we have no local tile.

const AWS_TERRARIUM = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
// Served from ./terrain by the Vite plugin in vite.config.ts
const BASE = `${import.meta.env.BASE_URL}terrain/`;
let ext = 'webp';

export const DEM_TILES = 'snowdem://{z}/{x}/{y}';
export const AO_TILES = 'snowao://{z}/{x}/{y}';

export interface TerrainIndex {
  attribution: string;
  maxzoom: number;
  dem: Set<string>;
  ao: Set<string>;
}

let index: TerrainIndex | null = null;

/** Load public/terrain/index.json if present (null → AWS tiles only, no AO). */
export async function loadTerrainIndex(): Promise<TerrainIndex | null> {
  try {
    const res = await fetch(`${BASE}index.json`, { cache: 'no-cache' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    const j = await res.json();
    index = { attribution: j.attribution, maxzoom: j.maxzoom, dem: new Set(j.dem), ao: new Set(j.ao) };
    ext = j.format ?? 'png';
    return index;
  } catch {
    return null;
  }
}

function parse(url: string): { key: string; z: number; x: number; y: number } {
  const [z, x, y] = url.replace(/^\w+:\/\//, '').split('/').map(Number);
  return { key: `${z}/${x}/${y}`, z, x, y };
}

// 1×1 transparent image for tiles without AO
let empty: ImageBitmap | null = null;
async function emptyTile(): Promise<ImageBitmap> {
  empty ??= await createImageBitmap(new ImageData(1, 1));
  return empty;
}

export function registerTerrainProtocols(): void {
  maplibregl.addProtocol('snowdem', async (params, abort) => {
    const { key, z, x, y } = parse(params.url);
    const url = index?.dem.has(key) ? `${BASE}dem/${key}.${ext}` : AWS_TERRARIUM(z, x, y);
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`DEM ${key}: HTTP ${res.status}`);
    return { data: await res.arrayBuffer() };
  });

  maplibregl.addProtocol('snowao', async (params, abort) => {
    const { key } = parse(params.url);
    if (!index?.ao.has(key)) return { data: await emptyTile() };
    const res = await fetch(`${BASE}ao/${key}.${ext}`, { signal: abort.signal });
    if (!res.ok) return { data: await emptyTile() };
    return { data: await res.arrayBuffer() };
  });
}
