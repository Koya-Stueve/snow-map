// Output stage of the terrain pipeline, shared by the main thread and the
// worker threads: 3×3 raw mosaic → fill holes → ambient occlusion → WebP tiles.
// Pure function of the raw tile store, so it can run in any order / in parallel.

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const TILE = 256;
/** Terrarium precision kept in the output (1/8 m) – smaller files, invisible difference */
const HEIGHT_STEP = 1 / 8;

export type Key = string; // "z/x/y"
export const key = (z: number, x: number, y: number): Key => `${z}/${x}/${y}`;
export const unkey = (k: Key) => k.split('/').map(Number) as [number, number, number];
export const tileYToLat = (y: number, z: number) =>
  (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z));
export const metersPerPixel = (z: number, lat: number) =>
  (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);

export interface Dirs {
  raw: string; // float32 tile store
  out: string; // terrain/ output root
}

export async function readRaw(rawDir: string, k: Key): Promise<Float32Array | null> {
  const f = path.join(rawDir, `${k}.f32`);
  if (!existsSync(f)) return null;
  const b = await readFile(f);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
}

/** Fill NaN holes from surrounding values with a push-pull pyramid (lakes keep shore height). */
export function fillHoles(data: Float32Array, w: number, h: number): void {
  if (!data.some((v) => Number.isNaN(v))) return;
  if (w <= 1 && h <= 1) {
    if (Number.isNaN(data[0])) data[0] = 0;
    return;
  }
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const coarse = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let s = 0;
      let n = 0;
      for (let d = 0; d < 4; d++) {
        const xx = 2 * x + (d & 1);
        const yy = 2 * y + (d >> 1);
        if (xx < w && yy < h) {
          const v = data[yy * w + xx];
          if (!Number.isNaN(v)) {
            s += v;
            n++;
          }
        }
      }
      coarse[y * cw + x] = n ? s / n : NaN;
    }
  fillHoles(coarse, cw, ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!Number.isNaN(data[i])) continue;
      const fx = Math.min(Math.max((x - 0.5) / 2, 0), cw - 1);
      const fy = Math.min(Math.max((y - 0.5) / 2, 0), ch - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, cw - 1);
      const y1 = Math.min(y0 + 1, ch - 1);
      const tx = fx - x0;
      const ty = fy - y0;
      data[i] =
        (coarse[y0 * cw + x0] * (1 - tx) + coarse[y0 * cw + x1] * tx) * (1 - ty) +
        (coarse[y1 * cw + x0] * (1 - tx) + coarse[y1 * cw + x1] * tx) * ty;
    }
}

const AO_STEPS = [1, 2, 3, 5, 8, 12, 18, 27, 40, 60];

/**
 * Sky-view factor ambient occlusion for the centre tile of a 3×3 mosaic:
 * per direction, march outwards and keep the steepest horizon; occlusion is the
 * mean sine of those angles (0 = open sky, 1 = enclosed).
 */
export function ambientOcclusion(m: Float32Array, size: number, mpp: number, directions: number): Uint8Array {
  const nS = AO_STEPS.length;
  const offX = new Int32Array(directions * nS);
  const offY = new Int32Array(directions * nS);
  const inv = new Float64Array(directions * nS);
  for (let d = 0; d < directions; d++) {
    const a = (2 * Math.PI * d) / directions;
    for (let k = 0; k < nS; k++) {
      const ox = Math.round(Math.cos(a) * AO_STEPS[k]);
      const oy = Math.round(Math.sin(a) * AO_STEPS[k]);
      offX[d * nS + k] = ox;
      offY[d * nS + k] = oy;
      inv[d * nS + k] = 1 / (Math.hypot(ox, oy) * mpp);
    }
  }
  const out = new Uint8Array(TILE * TILE);
  for (let py = 0; py < TILE; py++) {
    for (let px = 0; px < TILE; px++) {
      const x = px + TILE;
      const y = py + TILE;
      const h0 = m[y * size + x];
      let occ = 0;
      for (let d = 0; d < directions; d++) {
        let maxTan = 0;
        const base = d * nS;
        for (let k = 0; k < nS; k++) {
          const t = (m[(y + offY[base + k]) * size + x + offX[base + k]] - h0) * inv[base + k];
          if (t > maxTan) maxTan = t;
        }
        occ += maxTan / Math.sqrt(1 + maxTan * maxTan);
      }
      out[py * TILE + px] = Math.min(255, Math.round((occ / directions) * 255));
    }
  }
  return out;
}

/** 3×3 mosaic of raw tiles around k (missing → NaN) */
async function mosaic(rawDir: string, k: Key): Promise<Float32Array> {
  const [z, x, y] = unkey(k);
  const size = 3 * TILE;
  const m = new Float32Array(size * size).fill(NaN);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const t = await readRaw(rawDir, key(z, x + dx, y + dy));
      if (!t) continue;
      for (let py = 0; py < TILE; py++)
        m.set(t.subarray(py * TILE, (py + 1) * TILE), ((dy + 1) * TILE + py) * size + (dx + 1) * TILE);
    }
  return m;
}

export const outputFiles = (outDir: string, k: Key) => ({
  dem: path.join(outDir, 'dem', `${k}.webp`),
  ao: path.join(outDir, 'ao', `${k}.webp`),
});

/** Compute and write the DEM + AO WebP tiles for one key. */
export async function writeOutput(k: Key, dirs: Dirs): Promise<void> {
  const [z, , y] = unkey(k);
  const size = 3 * TILE;
  const m = await mosaic(dirs.raw, k);
  fillHoles(m, size, size);
  const lat = tileYToLat(y + 0.5, z);
  const ao = ambientOcclusion(m, size, metersPerPixel(z, lat), z >= 13 ? 8 : 16);

  const dem = Buffer.alloc(TILE * TILE * 3);
  const aoPx = Buffer.alloc(TILE * TILE * 4);
  for (let py = 0; py < TILE; py++)
    for (let px = 0; px < TILE; px++) {
      const i = py * TILE + px;
      const h = m[(py + TILE) * size + px + TILE];
      // Terrarium: h = R·256 + G + B/256 − 32768, quantised to HEIGHT_STEP
      const v = Math.min(Math.max(Math.round((h + 32768) / HEIGHT_STEP) * HEIGHT_STEP, 0), 65535.875);
      dem[i * 3] = Math.floor(v / 256);
      dem[i * 3 + 1] = Math.floor(v) % 256;
      dem[i * 3 + 2] = Math.round((v - Math.floor(v)) * 256);
      aoPx[i * 4 + 3] = ao[i]; // black, occlusion as alpha
    }
  const files = outputFiles(dirs.out, k);
  await mkdir(path.dirname(files.dem), { recursive: true });
  await mkdir(path.dirname(files.ao), { recursive: true });
  await sharp(dem, { raw: { width: TILE, height: TILE, channels: 3 } }).webp({ lossless: true, effort: 4 }).toFile(files.dem);
  await sharp(aoPx, { raw: { width: TILE, height: TILE, channels: 4 } }).webp({ quality: 80, alphaQuality: 85 }).toFile(files.ao);
}
