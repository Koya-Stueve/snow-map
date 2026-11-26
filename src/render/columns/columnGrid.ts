// Geometry for the snow column view: each forecast cell is split into SUB×SUB
// columns. Per column we need its position, the terrain height at its centre
// and the lowest terrain under its footprint (so it never floats on a slope),
// plus precomputed bilinear sampling positions into the coarse grid.

import type { GridSpec } from '../../data/types';

export const SUB = 4; // 0.1° / 4 ≈ 2.5 km columns
const DEM_Z = 9;
const TILE = 256;

export interface ColumnGrid {
  count: number;
  lon: Float64Array;
  lat: Float64Array;
  ground: Float32Array; // m at the centre
  groundMin: Float32Array; // m, lowest under the footprint
  /** Coarse grid sampling: SW cell index (dense) + weights; -1 = outside */
  cellIdx: Int32Array;
  tx: Float32Array;
  ty: Float32Array;
  dLon: number;
  dLat: number;
}

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z * TILE;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * TILE;
};

async function decodeTerrarium(url: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(TILE, TILE);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = ctx.getImageData(0, 0, TILE, TILE).data;
    const h = new Float32Array(TILE * TILE);
    for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    return h;
  } catch {
    return null;
  }
}

/**
 * Build the column grid for all stored forecast cells (land + coastal buffer);
 * columns whose centre is at/below sea level are dropped.
 */
export async function buildColumnGrid(
  grid: GridSpec,
  cells: Int32Array,
  demUrl: (z: number, x: number, y: number) => string,
): Promise<ColumnGrid> {
  const dLon = grid.dLon / SUB;
  const dLat = grid.dLat / SUB;
  // candidate column centres
  const lons: number[] = [];
  const lats: number[] = [];
  for (const d of cells) {
    const cx = grid.lon0 + (d % grid.nx) * grid.dLon;
    const cy = grid.lat0 + Math.floor(d / grid.nx) * grid.dLat;
    for (let sy = 0; sy < SUB; sy++)
      for (let sx = 0; sx < SUB; sx++) {
        lons.push(cx + (sx - (SUB - 1) / 2) * dLon);
        lats.push(cy + (sy - (SUB - 1) / 2) * dLat);
      }
  }

  // DEM tiles needed (zoom 9 ≈ 250 m/px)
  const need = new Set<string>();
  for (let i = 0; i < lons.length; i++) need.add(`${Math.floor(lonToX(lons[i], DEM_Z) / TILE)}/${Math.floor(latToY(lats[i], DEM_Z) / TILE)}`);
  const tiles = new Map<string, Float32Array | null>();
  await Promise.all(
    [...need].map(async (k) => {
      const [x, y] = k.split('/').map(Number);
      tiles.set(k, await decodeTerrarium(demUrl(DEM_Z, x, y)));
    }),
  );
  const height = (lon: number, lat: number) => {
    const px = lonToX(lon, DEM_Z);
    const py = latToY(lat, DEM_Z);
    const t = tiles.get(`${Math.floor(px / TILE)}/${Math.floor(py / TILE)}`);
    if (!t) return 0;
    const ix = Math.min(TILE - 1, Math.floor(px) % TILE);
    const iy = Math.min(TILE - 1, Math.floor(py) % TILE);
    return t[iy * TILE + ix];
  };

  const keep: number[] = [];
  const ground: number[] = [];
  const groundMin: number[] = [];
  for (let i = 0; i < lons.length; i++) {
    const g = height(lons[i], lats[i]);
    if (g <= 1) continue; // sea / coast
    let m = g;
    for (const [ox, oy] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45], [0, -0.45], [0, 0.45], [-0.45, 0], [0.45, 0]])
      m = Math.min(m, height(lons[i] + ox * dLon, lats[i] + oy * dLat));
    keep.push(i);
    ground.push(g);
    groundMin.push(Math.max(0, m));
  }

  const n = keep.length;
  const cg: ColumnGrid = {
    count: n,
    lon: new Float64Array(n),
    lat: new Float64Array(n),
    ground: Float32Array.from(ground),
    groundMin: Float32Array.from(groundMin),
    cellIdx: new Int32Array(n),
    tx: new Float32Array(n),
    ty: new Float32Array(n),
    dLon,
    dLat,
  };
  keep.forEach((src, k) => {
    const lon = lons[src];
    const lat = lats[src];
    cg.lon[k] = lon;
    cg.lat[k] = lat;
    const fx = (lon - grid.lon0) / grid.dLon;
    const fy = (lat - grid.lat0) / grid.dLat;
    const x0 = Math.min(Math.max(Math.floor(fx), 0), grid.nx - 2);
    const y0 = Math.min(Math.max(Math.floor(fy), 0), grid.ny - 2);
    cg.cellIdx[k] = fx < 0 || fy < 0 || fx > grid.nx - 1 || fy > grid.ny - 1 ? -1 : y0 * grid.nx + x0;
    cg.tx[k] = fx - x0;
    cg.ty[k] = fy - y0;
  });
  return cg;
}
