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
  /** Output pixels per tile side = 256 · scale (2 = hi-dpi / export quality) */
  scale: number;
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
const heights = new Lru<Promise<Float32Array | null>>(80);
const aoTiles = new Lru<Promise<Float32Array | null>>(80);
let statics = new Lru<Promise<StaticTile>>(64);

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

function loadAo(k: string): Promise<Float32Array | null> {
  let p = aoTiles.get(k);
  if (!p) {
    p = init!.aoSet.has(k)
      ? pixels(`${init!.base}ao/${k}.${init!.ext}`)
          .then((px) => (px ? Float32Array.from({ length: TILE * TILE }, (_, i) => px[i * 4 + 3]) : null))
          .catch(() => null)
      : Promise.resolve(null);
    aoTiles.set(k, p);
  }
  return p;
}

const MAX_DEM_Z = 14;

/**
 * Bilinearly sample tiles of zoom zd at the pixel centres of an output block for
 * tile (z, x, y): side = size + 2·border pixels. With zd = z + 1 and size 512 this
 * hits the pixels of the finer tiles exactly (real extra detail); otherwise it upsamples.
 * Missing tiles fall back to the nearest sample inside the tile's own area.
 */
async function sampleBlock(
  z: number,
  x: number,
  y: number,
  zd: number,
  size: number,
  border: number,
  load: (z: number, x: number, y: number) => Promise<Float32Array | null>,
): Promise<Float32Array | null> {
  const f = 2 ** (zd - z);
  const side = size + 2 * border;
  // global pixel coordinate (zoom zd) of output pixel i
  const g = (t: number, i: number) => (t + (i - border + 0.5) / size) * f * TILE - 0.5;
  const t0x = Math.floor(g(x, 0) / TILE);
  const t1x = Math.floor((g(x, side - 1) + 1) / TILE);
  const t0y = Math.floor(g(y, 0) / TILE);
  const t1y = Math.floor((g(y, side - 1) + 1) / TILE);
  const n = 2 ** zd;
  const tiles = new Map<string, Float32Array | null>();
  const jobs: Promise<void>[] = [];
  for (let ty = t0y; ty <= t1y; ty++)
    for (let tx = t0x; tx <= t1x; tx++) {
      const yy = Math.min(n - 1, Math.max(0, ty));
      const xx = ((tx % n) + n) % n;
      jobs.push(load(zd, xx, yy).then((d) => void tiles.set(`${tx}/${ty}`, d)));
    }
  await Promise.all(jobs);
  if (![...tiles.values()].some(Boolean)) return null;
  // own area, for clamping when a neighbour tile is missing
  const cx0 = x * f * TILE;
  const cx1 = (x + 1) * f * TILE - 1;
  const cy0 = y * f * TILE;
  const cy1 = (y + 1) * f * TILE - 1;
  const read = (px: number, py: number) => {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    const t = tiles.get(`${tx}/${ty}`);
    return t ? t[(py - ty * TILE) * TILE + (px - tx * TILE)] : undefined;
  };
  const at = (px: number, py: number): number =>
    read(px, py) ?? read(Math.min(cx1, Math.max(cx0, px)), Math.min(cy1, Math.max(cy0, py))) ?? 0;
  const out = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    const gy = g(y, j);
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    for (let i = 0; i < side; i++) {
      const gx = g(x, i);
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      out[j * side + i] =
        fx === 0 && fy === 0
          ? at(x0, y0)
          : (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    }
  }
  return out;
}

function staticTile(z: number, x: number, y: number): Promise<StaticTile> {
  const k = `${z}/${x}/${y}`;
  let p = statics.get(k);
  if (!p) {
    const size = TILE * init!.scale;
    const zd = Math.min(MAX_DEM_Z, z + Math.log2(init!.scale));
    p = Promise.all([
      sampleBlock(z, x, y, zd, size, 1, loadHeights),
      sampleBlock(z, x, y, zd, size, 0, (zz, xx, yy) => loadAo(`${zz}/${xx}/${yy}`)),
    ]).then(([h, ao]) =>
      computeStatic(h ?? new Float32Array((size + 2) ** 2), ao ? Uint8Array.from(ao, (v) => Math.round(v)) : null, z, x, y, init!.grid, size),
    );
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
    // Static tiles are ~0.45 MB at 256 px, ~1.8 MB at 512 px
    statics = new Lru<Promise<StaticTile>>(msg.scale > 1 ? 32 : 64);
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
    const img = new ImageData(st.size, st.size);
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
