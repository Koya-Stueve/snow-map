// Build high-resolution terrain tiles from GSI (国土地理院) elevation tiles:
//   - DEM as Terrarium PNG (for hillshade / 3D terrain / snow shader)
//   - Ambient occlusion (sky-view factor) as black+alpha PNG
//
//   npm run build-terrain                 build pilot regions + Japan overview
//   npm run build-terrain -- --dry-run    only print tile counts
//
// Output: public/terrain/{dem,ao}/{z}/{x}/{y}.png + public/terrain/index.json (not in git).
// Source tiles are cached in .cache/gsi/.
//
// Data: 国土地理院 標高タイル (DEM10B), PDL 1.0 – attribution required, and processed
// data must say so ("国土地理院の標高タイルを加工して作成").
// NOTE: bulk download is used here for a local test only (agreed with the user); a
// clean solution (official 基盤地図情報 download / GSI inquiry) is a later TODO.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

// --- Configuration ---------------------------------------------------------

/** High-res pilot regions [west, south, east, north], built from MAX_Z down to REGION_MIN_Z */
const REGIONS = [
  { name: 'niseko', bbox: [140.4, 42.6, 141.1, 43.0] },
  { name: 'daisetsu', bbox: [142.15, 43.25, 143.1, 43.85] },
] as const;
const MAX_Z = 14; // DEM10B native
const REGION_MIN_Z = 10;
/** Overview for all of Japan, built at OVERVIEW_Z and downsampled to OVERVIEW_MIN_Z */
const OVERVIEW = { bbox: [128.0, 30.0, 146.0, 46.0], z: 9, minZ: 6 } as const;

const GSI_URL = (z: number, x: number, y: number) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;
const REQUESTS_PER_SECOND = 5;
const USER_AGENT = 'snow-map/0.1 (local terrain preprocessing test)';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'gsi');
const OUT = path.join(ROOT, 'public', 'terrain');
const DRY = process.argv.includes('--dry-run');
const TILE = 256;

const log = (...a: unknown[]) => console.log('[terrain]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Tile math --------------------------------------------------------------

const lonToTileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToTileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const tileYToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};
/** Ground metres per pixel at zoom z and latitude */
const metersPerPixel = (z: number, lat: number) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);

interface TileRange {
  z: number;
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number;
}

/** Tile range covering bbox at zoom z, aligned to whole tiles of zoom `alignZ` */
function rangeFor(bbox: readonly number[], z: number, alignZ = z): TileRange {
  const [w, s, e, n] = bbox;
  const f = 2 ** (z - alignZ);
  return {
    z,
    x0: lonToTileX(w, alignZ) * f,
    y0: latToTileY(n, alignZ) * f,
    x1: (lonToTileX(e, alignZ) + 1) * f - 1,
    y1: (latToTileY(s, alignZ) + 1) * f - 1,
  };
}
const tileCount = (r: TileRange) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

// --- GSI download + decode ---------------------------------------------------

let lastRequest = 0;
let downloaded = 0;

/** Returns the PNG bytes, or null if GSI has no tile there (sea) */
async function gsiTile(z: number, x: number, y: number): Promise<Buffer | null> {
  const file = path.join(CACHE, `${z}`, `${x}`, `${y}.png`);
  const missing = file + '.404';
  if (existsSync(file)) return readFile(file);
  if (existsSync(missing)) return null;

  const wait = lastRequest + 1000 / REQUESTS_PER_SECOND - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(GSI_URL(z, x, y), { headers: { 'User-Agent': USER_AGENT } });
    await mkdir(path.dirname(file), { recursive: true });
    if (res.status === 404) {
      await writeFile(missing, '');
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

/**
 * GSI dem_png: x = R·2^16 + G·2^8 + B; x < 2^23 → h = x·0.01 m; x = 2^23 → NA;
 * x > 2^23 → h = (x − 2^24)·0.01 m. NA (incl. most water) becomes NaN.
 */
function decodeGsi(buf: Buffer, out: Float32Array, stride: number, ox: number, oy: number) {
  const png = PNG.sync.read(buf);
  for (let py = 0; py < TILE; py++)
    for (let px = 0; px < TILE; px++) {
      const i = (py * TILE + px) * 4;
      const v = png.data[i] * 65536 + png.data[i + 1] * 256 + png.data[i + 2];
      const h = v === 8388608 ? NaN : v < 8388608 ? v * 0.01 : (v - 16777216) * 0.01;
      out[(oy + py) * stride + ox + px] = h;
    }
}

// --- Raster helpers ----------------------------------------------------------

interface Mosaic {
  range: TileRange;
  w: number;
  h: number;
  data: Float32Array; // metres, NaN = no data
}

async function downloadMosaic(range: TileRange): Promise<Mosaic> {
  const w = (range.x1 - range.x0 + 1) * TILE;
  const h = (range.y1 - range.y0 + 1) * TILE;
  const data = new Float32Array(w * h).fill(NaN);
  for (let y = range.y0; y <= range.y1; y++)
    for (let x = range.x0; x <= range.x1; x++) {
      const buf = await gsiTile(range.z, x, y);
      if (buf) decodeGsi(buf, data, w, (x - range.x0) * TILE, (y - range.y0) * TILE);
    }
  return { range, w, h, data };
}

/**
 * Fill NaN holes (sea, lakes) smoothly from their surroundings ("push-pull"):
 * build a NaN-aware averaged pyramid, then fill each level's holes from the
 * coarser level. Lakes get their shore height instead of a pit at 0 m.
 */
function fillHoles(data: Float32Array, w: number, h: number): void {
  let hasHole = false;
  for (let i = 0; i < data.length; i++)
    if (Number.isNaN(data[i])) {
      hasHole = true;
      break;
    }
  if (!hasHole) return;
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
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const xx = 2 * x + dx;
          const yy = 2 * y + dy;
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
      // bilinear from the coarse level for smooth fills
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

/** 2×2 average → next lower zoom (ranges are aligned, so sizes halve exactly) */
function downsample(m: Mosaic): Mosaic {
  const w = m.w / 2;
  const h = m.h / 2;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = 2 * y * m.w + 2 * x;
      data[y * w + x] = (m.data[i] + m.data[i + 1] + m.data[i + m.w] + m.data[i + m.w + 1]) / 4;
    }
  const r = m.range;
  return { range: { z: r.z - 1, x0: r.x0 / 2, y0: r.y0 / 2, x1: (r.x1 + 1) / 2 - 1, y1: (r.y1 + 1) / 2 - 1 }, w, h, data };
}

/**
 * Sky-view factor ambient occlusion. For each pixel and direction, march outwards
 * (exponentially growing steps) and track the highest horizon angle; occlusion is
 * the mean sine of those angles. Returns occlusion 0 (open) … 1 (fully enclosed).
 */
function ambientOcclusion(m: Mosaic, directions: number): Uint8Array {
  const { w, h, data } = m;
  const STEPS = [1, 2, 3, 5, 8, 12, 18, 27, 40, 60];
  const nS = STEPS.length;
  const out = new Uint8Array(w * h);
  const latMid = (tileYToLat(m.range.y0, m.range.z) + tileYToLat(m.range.y1 + 1, m.range.z)) / 2;
  const mpp = metersPerPixel(m.range.z, latMid);

  // Precompute integer offsets and 1/distance for every (direction, step)
  const offX = new Int32Array(directions * nS);
  const offY = new Int32Array(directions * nS);
  const invDist = new Float64Array(directions * nS);
  for (let d = 0; d < directions; d++) {
    const a = (2 * Math.PI * d) / directions;
    for (let k = 0; k < nS; k++) {
      const ox = Math.round(Math.cos(a) * STEPS[k]);
      const oy = Math.round(Math.sin(a) * STEPS[k]);
      offX[d * nS + k] = ox;
      offY[d * nS + k] = oy;
      invDist[d * nS + k] = 1 / (Math.hypot(ox, oy) * mpp);
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const h0 = data[y * w + x];
      let occ = 0;
      for (let d = 0; d < directions; d++) {
        let maxTan = 0;
        const base = d * nS;
        for (let k = 0; k < nS; k++) {
          const xx = x + offX[base + k];
          const yy = y + offY[base + k];
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          const t = (data[yy * w + xx] - h0) * invDist[base + k];
          if (t > maxTan) maxTan = t;
        }
        occ += maxTan / Math.sqrt(1 + maxTan * maxTan); // sin(atan(t))
      }
      out[y * w + x] = Math.min(255, Math.round((occ / directions) * 255));
    }
  }
  return out;
}

// --- Writing ---------------------------------------------------------------

async function writeTiles(m: Mosaic, ao: Uint8Array) {
  const { range, w } = m;
  for (let ty = range.y0; ty <= range.y1; ty++)
    for (let tx = range.x0; tx <= range.x1; tx++) {
      const ox = (tx - range.x0) * TILE;
      const oy = (ty - range.y0) * TILE;
      const dem = new PNG({ width: TILE, height: TILE });
      const aoPng = new PNG({ width: TILE, height: TILE });
      for (let py = 0; py < TILE; py++)
        for (let px = 0; px < TILE; px++) {
          const src = (oy + py) * w + ox + px;
          const i = (py * TILE + px) * 4;
          // Terrarium: h = R·256 + G + B/256 − 32768
          const v = Math.min(Math.max(m.data[src] + 32768, 0), 65535.99);
          dem.data[i] = Math.floor(v / 256);
          dem.data[i + 1] = Math.floor(v) % 256;
          dem.data[i + 2] = Math.floor((v - Math.floor(v)) * 256);
          dem.data[i + 3] = 255;
          aoPng.data[i] = aoPng.data[i + 1] = aoPng.data[i + 2] = 0;
          aoPng.data[i + 3] = ao[src];
        }
      for (const [kind, png, opts] of [
        ['dem', dem, { colorType: 2 }],
        ['ao', aoPng, { colorType: 6 }],
      ] as const) {
        const file = path.join(OUT, kind, `${range.z}`, `${tx}`, `${ty}.png`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, PNG.sync.write(png, opts));
      }
    }
}

async function buildPyramid(name: string, top: Mosaic, minZ: number) {
  let m = top;
  for (;;) {
    const t0 = Date.now();
    const ao = ambientOcclusion(m, m.range.z >= 13 ? 8 : 16);
    await writeTiles(m, ao);
    log(`${name} z${m.range.z}: ${tileCount(m.range)} tiles (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (m.range.z <= minZ) break;
    m = downsample(m);
  }
}

/** "z/x/y" keys of all PNG tiles below dir */
async function listTiles(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const keys: string[] = [];
  if (!existsSync(dir)) return keys;
  for (const z of await readdir(dir))
    for (const x of await readdir(path.join(dir, z)))
      for (const f of await readdir(path.join(dir, z, x))) if (f.endsWith('.png')) keys.push(`${z}/${x}/${f.slice(0, -4)}`);
  return keys.sort();
}

// --- Main -------------------------------------------------------------------

async function main() {
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg >= 0 ? process.argv[onlyArg + 1] : null;
  const plans = [
    ...REGIONS.map((r) => ({ name: r.name, range: rangeFor(r.bbox, MAX_Z, REGION_MIN_Z), minZ: REGION_MIN_Z })),
    { name: 'overview', range: rangeFor(OVERVIEW.bbox, OVERVIEW.z, OVERVIEW.minZ), minZ: OVERVIEW.minZ },
  ].filter((p) => !only || p.name === only);
  let total = 0;
  for (const p of plans) {
    total += tileCount(p.range);
    log(`${p.name}: z${p.range.z} ${tileCount(p.range)} source tiles (${p.range.x1 - p.range.x0 + 1}x${p.range.y1 - p.range.y0 + 1}), pyramid down to z${p.minZ}`);
  }
  log(`total ${total} GSI tiles to fetch (cached ones are skipped; ~${Math.ceil(total / REQUESTS_PER_SECOND / 60)} min uncached)`);
  if (DRY) return;

  for (const p of plans) {
    log(`${p.name}: downloading...`);
    const m = await downloadMosaic(p.range);
    fillHoles(m.data, m.w, m.h);
    await buildPyramid(p.name, m, p.minZ);
  }

  // Index = everything on disk (also tiles from earlier runs)
  const index = {
    version: 1,
    attribution: '国土地理院 標高タイル（DEM10B）を加工して作成',
    maxzoom: MAX_Z,
    dem: await listTiles(path.join(OUT, 'dem')),
    ao: await listTiles(path.join(OUT, 'ao')),
  };
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  log(`done: ${index.dem.length} DEM + ${index.ao.length} AO tiles in ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error('[terrain] failed:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
