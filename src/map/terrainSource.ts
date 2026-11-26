import * as maplibregl from 'maplibre-gl';

// High-res terrain built by scripts/build-terrain.ts (GSI → Terrarium DEM + AO),
// with Mapzen/AWS Terrarium tiles as fallback wherever we have no local tile.
// The 3D mesh uses snowdem://; the surface workers load DEM/AO tiles directly.

const AWS_TERRARIUM = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
// Served from ./terrain by the Vite plugin in vite.config.ts
const BASE = `${import.meta.env.BASE_URL}terrain/`;
let ext = 'webp';

export const DEM_TILES = 'snowdem://{z}/{x}/{y}';

export interface TerrainIndex {
  attribution: string;
  maxzoom: number;
  dem: Set<string>;
  ao: Set<string>;
}

let index: TerrainIndex | null = null;

/** Load terrain/index.json if present (null → AWS tiles only, no AO). */
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

/** What the surface workers need to find DEM/AO tiles themselves */
export function terrainInfoForWorkers() {
  return {
    demKeys: index ? [...index.dem] : [],
    aoKeys: index ? [...index.ao] : [],
    base: new URL(BASE, location.href).href,
    ext,
  };
}

export function registerTerrainProtocols(): void {
  maplibregl.addProtocol('snowdem', async (params, abort) => {
    const [z, x, y] = params.url.replace(/^\w+:\/\//, '').split('/').map(Number);
    const key = `${z}/${x}/${y}`;
    const url = index?.dem.has(key) ? `${BASE}dem/${key}.${ext}` : AWS_TERRARIUM(z, x, y);
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`DEM ${key}: HTTP ${res.status}`);
    return { data: await res.arrayBuffer() };
  });
}
