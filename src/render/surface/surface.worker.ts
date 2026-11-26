/// <reference lib="webworker" />
// Surface tile worker: loads DEM/AO tiles itself, caches static per-tile terrain
// attributes, and shades tiles for the current frame (time/mode/theme).

import type { GridSpec } from '../../data/types';
import { computeStatic, shadeTile, TILE, type Frame, type StaticTile } from './shading';

export interface InitMsg {
  type: 'init';
  grid: GridSpec;
  cells: Int32Array;
  href: Float32Array | null; // per cell
  demKeys: string[];
  aoKeys: string[];
  base: string; // absolute URL of /terrain/
  ext: string;
}
export interface FrameMsg {
  type: 'frame';
  version: number;
  refined: boolean;
  snow: Float32Array; // per cell
  fl: Float32Array | null;
  wx: Float32Array | null;
  wy: Float32Array | null;
  lut: Int32Array;
  lnLo: number;
  lnHi: number;
  theme: Frame['theme'];
}
export interface TileMsg {
  type: 'tile';
  id: number;
  z: number;
  x: number;
  y: number;
}

const AWS = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

let init: (InitMsg & { demSet: Set<string>; aoSet: Set<string> }) | null = null;
let frame: Frame | null = null;
const dense = { snow: new Float32Array(0), fl: new Float32Array(0), wx: new Float32Array(0), wy: new Float32Array(0), href: new Float32Array(0) };

// --- small LRU ---
class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string) {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}
const heights = new Lru<Promise<Float32Array | null>>(64);
const aoTiles = new Lru<Promise<Uint8Array | null>>(48);
const statics = new Lru<Promise<StaticTile>>(64);

const canvas = new OffscreenCanvas(TILE, TILE);
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

async function pixels(url: string): Promise<Uint8ClampedArray | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  // No colour management / premultiplication: DEM bytes must stay exact
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  ctx.clearRect(0, 0, TILE, TILE);
  ctx.drawImage(bmp, 0, 0, TILE, TILE);
  bmp.close();
  return ctx.getImageData(0, 0, TILE, TILE).data;
}

function loadHeights(z: number, x: number, y: number): Promise<Float32Array | null> {
  const k = `${z}/${x}/${y}`;
  let p = heights.get(k);
  if (!p) {
    const url = init!.demSet.has(k) ? `${init!.base}dem/${k}.${init!.ext}` : AWS(z, x, y);
    p = pixels(url)
      .then((px) => {
        if (!px) return null;
        const h = new Float32Array(TILE * TILE);
        for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        return h;
      })
      .catch(() => null);
    heights.set(k, p);
  }
  return p;
}

function loadAo(k: string): Promise<Uint8Array | null> {
  let p = aoTiles.get(k);
  if (!p) {
    p = init!.aoSet.has(k)
      ? pixels(`${init!.base}ao/${k}.${init!.ext}`)
          .then((px) => (px ? Uint8Array.from({ length: TILE * TILE }, (_, i) => px[i * 4 + 3]) : null))
          .catch(() => null)
      : Promise.resolve(null);
    aoTiles.set(k, p);
  }
  return p;
}

/** 258×258 heights: the tile plus a 1 px border taken from its neighbours (edge-clamped if missing) */
async function heightBlock(z: number, x: number, y: number): Promise<Float32Array> {
  const n = 2 ** z;
  const get = (dx: number, dy: number) => loadHeights(z, (x + dx + n) % n, Math.min(n - 1, Math.max(0, y + dy)));
  const [c, nw, nn, ne, w, e, sw, s, se] = await Promise.all([
    get(0, 0), get(-1, -1), get(0, -1), get(1, -1), get(-1, 0), get(1, 0), get(-1, 1), get(0, 1), get(1, 1),
  ]);
  const W = TILE + 2;
  const out = new Float32Array(W * W);
  const center = c ?? new Float32Array(TILE * TILE);
  const at = (t: Float32Array | null, px: number, py: number, fx: number, fy: number) =>
    t ? t[py * TILE + px] : center[Math.min(TILE - 1, Math.max(0, fy)) * TILE + Math.min(TILE - 1, Math.max(0, fx))];
  for (let py = -1; py <= TILE; py++)
    for (let px = -1; px <= TILE; px++) {
      const left = px < 0;
      const right = px >= TILE;
      const top = py < 0;
      const bottom = py >= TILE;
      const t = top ? (left ? nw : right ? ne : nn) : bottom ? (left ? sw : right ? se : s) : left ? w : right ? e : center;
      const lx = left ? TILE - 1 : right ? 0 : px;
      const ly = top ? TILE - 1 : bottom ? 0 : py;
      out[(py + 1) * W + px + 1] = at(t, lx, ly, px, py);
    }
  return out;
}

function staticTile(z: number, x: number, y: number): Promise<StaticTile> {
  const k = `${z}/${x}/${y}`;
  let p = statics.get(k);
  if (!p) {
    p = Promise.all([heightBlock(z, x, y), loadAo(k)]).then(([h, ao]) => computeStatic(h, ao, z, x, y, init!.grid));
    statics.set(k, p);
  }
  return p;
}

function scatter(values: Float32Array | null, target: Float32Array, fill = 0): Float32Array | null {
  if (!values || !init) return null;
  target.fill(fill);
  const cells = init.cells;
  for (let k = 0; k < cells.length; k++) target[cells[k]] = values[k];
  return target;
}

self.onmessage = async (ev: MessageEvent<InitMsg | FrameMsg | TileMsg>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    init = { ...msg, demSet: new Set(msg.demKeys), aoSet: new Set(msg.aoKeys) };
    const n = msg.grid.nx * msg.grid.ny;
    for (const key of Object.keys(dense) as (keyof typeof dense)[]) dense[key] = new Float32Array(n);
    if (msg.href) scatter(msg.href, dense.href);
    return;
  }
  if (msg.type === 'frame') {
    frame = {
      version: msg.version,
      refined: msg.refined,
      snow: scatter(msg.snow, dense.snow)!,
      // Missing freezing level → very high, i.e. no snow-line limit
      fl: scatter(msg.fl, dense.fl, 9999),
      wx: scatter(msg.wx, dense.wx),
      wy: scatter(msg.wy, dense.wy),
      href: init?.href ? dense.href : null,
      lut: msg.lut,
      lnLo: msg.lnLo,
      lnHi: msg.lnHi,
      theme: msg.theme,
    };
    return;
  }
  // tile
  try {
    if (!init || !frame) throw new Error('worker not initialised');
    const t0 = performance.now();
    const st = await staticTile(msg.z, msg.x, msg.y);
    const t1 = performance.now();
    const img = new ImageData(TILE, TILE);
    shadeTile(st, frame, init.grid, img.data);
    const bmp = await createImageBitmap(img);
    const t2 = performance.now();
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(
      { id: msg.id, bitmap: bmp, version: frame.version, staticMs: t1 - t0, shadeMs: t2 - t1 },
      [bmp],
    );
  } catch (e) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id: msg.id, error: String(e) });
  }
};
