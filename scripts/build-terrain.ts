// Build high-resolution terrain tiles for the map:
//   - DEM as lossless Terrarium WebP (hillshade, 3D terrain, later the snow shader)
//   - Ambient occlusion (sky-view factor) as black+alpha WebP
//
//   npm run build-terrain                       all regions + Japan overview
//   npm run build-terrain -- --only tomamu      one region
//   npm run build-terrain -- --force            recompute raw tiles (e.g. new dem-src data)
//   npm run build-terrain -- --dry-run          only print tile counts
//
// Sources, best first:
//   1. dem-src/: GSI 基盤地図情報 数値標高モデル downloads (DEM5A 5 m > DEM10B 10 m), zips welcome
//   2. GSI 標高タイル dem_png (DEM10B) – fetched politely and cached in .cache/gsi/
// Pipeline (tile based, so regions and sources can overlap freely):
//   raw  : float32 tiles in .cache/terrain-raw/ at the region's top zoom (GSI + dem-src overlay)
//   up   : parents from their four children (missing children → GSI tile of that zoom)
//   out  : per tile with its 8 neighbours → fill holes, AO, encode → terrain/{dem,ao}/z/x/y.webp
//
// Licence: 国土地理院 (PDL 1.0) – attribution + note that the data was processed.
// NOTE: bulk fetching of GSI tiles is for a local test (agreed with the user); the
// clean route is the official 基盤地図情報 download in dem-src/.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { KibanSource } from './terrain/kiban.ts';

// --- Configuration ---------------------------------------------------------

const REGIONS = [
  { name: 'niseko', bbox: [140.4, 42.6, 141.1, 43.0] },
  { name: 'daisetsu', bbox: [142.15, 43.25, 143.1, 43.85] },
  { name: 'tomamu', bbox: [142.45, 42.98, 142.93, 43.11] },
] as const;
const TOP_Z = 14; // DEM10B native; 5 m data is resampled to this zoom (~7 m/px)
const REGION_MIN_Z = 10;
const OVERVIEW = { bbox: [128.0, 30.0, 146.0, 46.0], z: 9, minZ: 6 } as const;

const GSI_URL = (z: number, x: number, y: number) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;
const REQUESTS_PER_SECOND = 5;
const USER_AGENT = 'snow-map/0.1 (local terrain preprocessing test)';
/** Terrarium precision kept in the output (1/8 m) – smaller files, invisible difference */
const HEIGHT_STEP = 1 / 8;

const ROOT = path.resolve(import.meta.dirname, '..');
const GSI_CACHE = path.join(ROOT, '.cache', 'gsi');
const RAW = path.join(ROOT, '.cache', 'terrain-raw');
const KIBAN_SRC = path.join(ROOT, 'dem-src');
const KIBAN_CACHE = path.join(ROOT, '.cache', 'kiban');
const OUT = path.join(ROOT, 'terrain');
const TILE = 256;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const log = (...a: unknown[]) => console.log('[terrain]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Tile math --------------------------------------------------------------

const lonToTileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToTileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileYToLat = (y: number, z: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z));
const metersPerPixel = (z: number, lat: number) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);

type Key = string; // "z/x/y"
const key = (z: number, x: number, y: number): Key => `${z}/${x}/${y}`;
const unkey = (k: Key) => k.split('/').map(Number) as [number, number, number];

function tilesIn(bbox: readonly number[], z: number): Key[] {
  const [w, s, e, n] = bbox;
  const out: Key[] = [];
  for (let y = latToTileY(n, z); y <= latToTileY(s, z); y++)
    for (let x = lonToTileX(w, z); x <= lonToTileX(e, z); x++) out.push(key(z, x, y));
  return out;
}

// --- GSI tiles -----------------------------------------------------------------

let lastRequest = 0;
let downloaded = 0;

async function gsiPng(z: number, x: number, y: number): Promise<Buffer | null> {
  const file = path.join(GSI_CACHE, `${z}`, `${x}`, `${y}.png`);
  if (existsSync(file)) return readFile(file);
  if (existsSync(file + '.404')) return null;
  const wait = lastRequest + 1000 / REQUESTS_PER_SECOND - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(GSI_URL(z, x, y), { headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
      // network hiccup (reset, DNS, timeout) – back off and retry
      if (attempt >= 6) throw e;
      log(`network error on ${z}/${x}/${y} (${(e as Error).message}), retry ${attempt}...`);
      await sleep(3000 * attempt);
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    if (res.status === 404) {
      await writeFile(file + '.404', '');
      return null;
    }
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(file, buf);
      if (++downloaded % 100 === 0) log(`downloaded ${downloaded} GSI tiles`);
      return buf;
    }
    if (attempt >= 5) throw new Error(`GSI ${z}/${x}/${y}: HTTP ${res.status}`);
    await sleep(5000 * attempt);
  }
}

/** GSI dem_png → metres (NaN = no data). x=R·2^16+G·2^8+B; 2^23 = NA; above = negative. */
async function gsiRaw(z: number, x: number, y: number): Promise<Float32Array> {
  const out = new Float32Array(TILE * TILE).fill(NaN);
  const buf = await gsiPng(z, x, y);
  if (!buf) return out;
  const png = PNG.sync.read(buf);
  for (let i = 0; i < TILE * TILE; i++) {
    const v = png.data[i * 4] * 65536 + png.data[i * 4 + 1] * 256 + png.data[i * 4 + 2];
    out[i] = v === 8388608 ? NaN : v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01;
  }
  return out;
}

// --- Raw tile store (float32) ---------------------------------------------------

const rawFile = (k: Key) => path.join(RAW, `${k}.f32`);
async function readRaw(k: Key): Promise<Float32Array | null> {
  const f = rawFile(k);
  if (!existsSync(f)) return null;
  const b = await readFile(f);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
}
async function writeRaw(k: Key, data: Float32Array) {
  const f = rawFile(k);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}
const allNaN = (d: Float32Array) => d.every((v) => Number.isNaN(v));

/** Top-zoom raw tile: GSI, overlaid with dem-src (5 m/10 m) where available */
async function buildTopRaw(k: Key, kiban: KibanSource): Promise<boolean> {
  if (!FORCE && existsSync(rawFile(k))) return true;
  const [z, x, y] = unkey(k);
  const data = await gsiRaw(z, x, y);
  const w = tileXToLon(x, z);
  const e = tileXToLon(x + 1, z);
  const n = tileYToLat(y, z);
  const s = tileYToLat(y + 1, z);
  const blocks = kiban.blocksIn(w, s, e, n);
  if (blocks.length) {
    const lons = new Float64Array(TILE * TILE);
    const lats = new Float64Array(TILE * TILE);
    for (let py = 0; py < TILE; py++) {
      const lat = tileYToLat(y + (py + 0.5) / TILE, z);
      for (let px = 0; px < TILE; px++) {
        lons[py * TILE + px] = tileXToLon(x + (px + 0.5) / TILE, z);
        lats[py * TILE + px] = lat;
      }
    }
    await kiban.sampleInto(lons, lats, data, blocks);
  }
  if (allNaN(data)) return false;
  await writeRaw(k, data);
  return true;
}

/** Parent from its four children (NaN-aware mean); missing quadrants from GSI */
async function buildParentRaw(k: Key): Promise<boolean> {
  const [z, x, y] = unkey(k);
  const kids = await Promise.all([0, 1, 2, 3].map((q) => readRaw(key(z + 1, 2 * x + (q & 1), 2 * y + (q >> 1)))));
  const data = kids.every(Boolean) ? new Float32Array(TILE * TILE) : await gsiRaw(z, x, y);
  kids.forEach((kid, q) => {
    if (!kid) return;
    const ox = (q & 1) * 128;
    const oy = (q >> 1) * 128;
    for (let py = 0; py < 128; py++)
      for (let px = 0; px < 128; px++) {
        let sum = 0;
        let n = 0;
        for (let d = 0; d < 4; d++) {
          const v = kid[(2 * py + (d >> 1)) * TILE + 2 * px + (d & 1)];
          if (!Number.isNaN(v)) {
            sum += v;
            n++;
          }
        }
        data[(oy + py) * TILE + ox + px] = n ? sum / n : NaN;
      }
  });
  if (allNaN(data)) return false;
  await writeRaw(k, data);
  return true;
}

// --- Raster ops ------------------------------------------------------------

/** Fill NaN holes from surrounding values with a push-pull pyramid (lakes keep shore height). */
function fillHoles(data: Float32Array, w: number, h: number): void {
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
function ambientOcclusion(m: Float32Array, size: number, mpp: number, directions: number): Uint8Array {
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
async function mosaic(k: Key): Promise<Float32Array> {
  const [z, x, y] = unkey(k);
  const size = 3 * TILE;
  const m = new Float32Array(size * size).fill(NaN);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const t = await readRaw(key(z, x + dx, y + dy));
      if (!t) continue;
      for (let py = 0; py < TILE; py++) m.set(t.subarray(py * TILE, (py + 1) * TILE), ((dy + 1) * TILE + py) * size + (dx + 1) * TILE);
    }
  return m;
}

async function writeOutput(k: Key): Promise<void> {
  const [z, , y] = unkey(k);
  const size = 3 * TILE;
  const m = await mosaic(k);
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
  const demFile = path.join(OUT, 'dem', `${k}.webp`);
  const aoFile = path.join(OUT, 'ao', `${k}.webp`);
  await mkdir(path.dirname(demFile), { recursive: true });
  await mkdir(path.dirname(aoFile), { recursive: true });
  await sharp(dem, { raw: { width: TILE, height: TILE, channels: 3 } }).webp({ lossless: true, effort: 4 }).toFile(demFile);
  await sharp(aoPx, { raw: { width: TILE, height: TILE, channels: 4 } }).webp({ quality: 80, alphaQuality: 85 }).toFile(aoFile);
}

async function listTiles(dir: string): Promise<Key[]> {
  const keys: Key[] = [];
  if (!existsSync(dir)) return keys;
  for (const z of await readdir(dir))
    for (const x of await readdir(path.join(dir, z)))
      for (const f of await readdir(path.join(dir, z, x))) if (f.endsWith('.webp')) keys.push(`${z}/${x}/${f.slice(0, -5)}`);
  return keys.sort();
}

// --- Main -------------------------------------------------------------------

interface Plan {
  name: string;
  bbox: readonly number[];
  topZ: number;
  minZ: number;
}

async function main() {
  const plans: Plan[] = [
    ...REGIONS.map((r) => ({ name: r.name, bbox: r.bbox, topZ: TOP_Z, minZ: REGION_MIN_Z })),
    { name: 'overview', bbox: OVERVIEW.bbox, topZ: OVERVIEW.z, minZ: OVERVIEW.minZ },
  ].filter((p) => !ONLY || p.name === ONLY);
  if (!plans.length) throw new Error(`unknown region ${ONLY}`);

  const kiban = await KibanSource.open(KIBAN_SRC, KIBAN_CACHE);
  const kb = kiban.bbox();
  log(`dem-src: ${kiban.count} blocks${kb ? ` covering ${kb.map((v) => v.toFixed(3)).join(', ')}` : ''}`);
  for (const p of plans) log(`${p.name}: ${tilesIn(p.bbox, p.topZ).length} tiles at z${p.topZ}, pyramid to z${p.minZ}`);
  if (DRY) return;

  const touched = new Set<Key>();
  for (const p of plans) {
    const t0 = Date.now();
    let level = new Set<Key>();
    for (const k of tilesIn(p.bbox, p.topZ)) if (await buildTopRaw(k, kiban)) level.add(k);
    log(`${p.name} z${p.topZ}: ${level.size} raw tiles (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    kiban.release();
    level.forEach((k) => touched.add(k));
    for (let z = p.topZ - 1; z >= p.minZ; z--) {
      const parents = new Set([...level].map((k) => {
        const [, x, y] = unkey(k);
        return key(z, x >> 1, y >> 1);
      }));
      level = new Set();
      for (const k of parents) if (await buildParentRaw(k)) level.add(k);
      level.forEach((k) => touched.add(k));
    }
  }

  log(`writing ${touched.size} tiles (fill + AO + WebP)...`);
  const t0 = Date.now();
  let n = 0;
  for (const k of touched) {
    // Resumable: skip tiles already written by an interrupted run (use --force to redo)
    const done = existsSync(path.join(OUT, 'dem', `${k}.webp`)) && existsSync(path.join(OUT, 'ao', `${k}.webp`));
    if (FORCE || !done) await writeOutput(k);
    if (++n % 250 === 0) log(`  ${n}/${touched.size} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }

  const index = {
    version: 2,
    format: 'webp',
    attribution: '国土地理院 標高タイル・基盤地図情報 数値標高モデルを加工して作成',
    maxzoom: TOP_Z,
    dem: await listTiles(path.join(OUT, 'dem')),
    ao: await listTiles(path.join(OUT, 'ao')),
  };
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  log(`done: ${index.dem.length} tiles in ${path.relative(ROOT, OUT)} (${((Date.now() - t0) / 1000).toFixed(0)} s output)`);

  // Old PNG output from the first pipeline version (now superseded)
  const legacy = path.join(ROOT, 'public', 'terrain');
  if (existsSync(legacy)) {
    await rm(legacy, { recursive: true, force: true });
    log('removed legacy public/terrain');
  }
}

main().catch((e) => {
  console.error('[terrain] failed:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
