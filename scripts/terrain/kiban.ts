// Reader for GSI 基盤地図情報 数値標高モデル (JPGIS GML) downloads placed in dem-src/.
// Zips (also nested) are extracted into .cache/kiban/; XML headers are indexed
// up front, the (large) value lists are loaded lazily per block.
//
// Each XML file holds one block: an envelope (lat/lon, JGD2011/2024 ≈ WGS84),
// a grid size and a tuple list "class,height" in +x−y order (rows from north).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface KibanBlock {
  file: string;
  /** 5 = DEM5A/B/C (5 m), 10 = DEM10A/B (10 m) */
  res: 5 | 10;
  /** Preference, lower = better: 5A (laser) < 5B < 5C (photogrammetry) < 10A < 10B */
  rank: number;
  south: number;
  west: number;
  north: number;
  east: number;
  nx: number;
  ny: number;
  data?: Float32Array; // row 0 = north, NaN = no data
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Extract every zip below srcDir (recursively, incl. zips inside zips) into cacheDir. */
async function extractAll(srcDir: string, cacheDir: string): Promise<void> {
  // Windows' bsdtar (System32) reads zip files; GNU tar from Git Bash does not
  const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';
  const pending = (await walk(srcDir)).filter((f) => f.toLowerCase().endsWith('.zip'));
  while (pending.length) {
    const zip = pending.pop()!;
    const dest = path.join(cacheDir, path.basename(zip, path.extname(zip)));
    if (!existsSync(path.join(dest, '.done'))) {
      await mkdir(dest, { recursive: true });
      execFileSync(tar, ['-xf', zip, '-C', dest]);
      await (await open(path.join(dest, '.done'), 'w')).close();
    }
    for (const f of await walk(dest)) if (f.toLowerCase().endsWith('.zip')) pending.push(f);
  }
}

const num = (s: string | undefined) => (s == null ? NaN : Number(s));
const PRODUCT_RANK = ['5A', '5B', '5C', '10A', '10B'];

/** Parse only the header (first few KB) of a DEM XML file. */
async function readHeader(file: string): Promise<KibanBlock | null> {
  const fh = await open(file, 'r');
  const buf = Buffer.alloc(8192);
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  await fh.close();
  const head = buf.subarray(0, bytesRead).toString('utf8');
  const type = head.match(/<type>([^<]+)<\/type>/)?.[1] ?? '';
  const lower = head.match(/<gml:lowerCorner>([^<]+)</)?.[1].trim().split(/\s+/);
  const upper = head.match(/<gml:upperCorner>([^<]+)</)?.[1].trim().split(/\s+/);
  const high = head.match(/<gml:high>([^<]+)</)?.[1].trim().split(/\s+/);
  if (!lower || !upper || !high || !/メッシュ（標高）/.test(type)) return null;
  const res = type.startsWith('5m') ? 5 : 10;
  const product = path.basename(file).match(/DEM(5A|5B|5C|10A|10B)/i)?.[1].toUpperCase() ?? '';
  const rank = PRODUCT_RANK.indexOf(product);
  return {
    file,
    res,
    rank: rank >= 0 ? rank : res === 5 ? 2 : 4, // unknown product: treat like 5C / 10B
    south: num(lower[0]),
    west: num(lower[1]),
    north: num(upper[0]),
    east: num(upper[1]),
    nx: num(high[0]) + 1,
    ny: num(high[1]) + 1,
  };
}

// Keep at most ~240 MB of parsed values in memory (least recently loaded evicted first)
const MAX_LOADED_VALUES = 60_000_000;
const loaded: KibanBlock[] = [];
let loadedValues = 0;

async function loadData(b: KibanBlock): Promise<Float32Array> {
  if (b.data) return b.data;
  while (loaded.length && loadedValues + b.nx * b.ny > MAX_LOADED_VALUES) {
    const old = loaded.shift()!;
    if (old.data) loadedValues -= old.data.length;
    delete old.data;
  }
  const text = await readFile(b.file, 'utf8');
  const data = new Float32Array(b.nx * b.ny).fill(NaN);
  const start = text.match(/<gml:startPoint>(\d+)\s+(\d+)</);
  let i = start ? Number(start[2]) * b.nx + Number(start[1]) : 0;
  const t0 = text.indexOf('<gml:tupleList>');
  const t1 = text.indexOf('</gml:tupleList>', t0);
  for (const line of text.slice(t0 + 15, t1).split('\n')) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const v = Number(line.slice(comma + 1));
    if (i < data.length) data[i] = v > -9000 ? v : NaN; // -9999 = データなし
    i++;
  }
  b.data = data;
  loaded.push(b);
  loadedValues += data.length;
  return data;
}

export class KibanSource {
  readonly blocks: KibanBlock[];
  // (no parameter properties: Node's type stripping doesn't support them)
  private constructor(blocks: KibanBlock[]) {
    this.blocks = blocks;
  }

  static async open(srcDir: string, cacheDir: string): Promise<KibanSource> {
    await extractAll(srcDir, cacheDir);
    const files = [...(await walk(srcDir)), ...(await walk(cacheDir))].filter((f) => f.toLowerCase().endsWith('.xml'));
    const seen = new Set<string>();
    const blocks: KibanBlock[] = [];
    for (const f of files) {
      const key = path.basename(f).toLowerCase();
      if (seen.has(key)) continue; // same file extracted and also present unpacked
      seen.add(key);
      const b = await readHeader(f);
      if (b) blocks.push(b);
    }
    blocks.sort((a, b) => a.rank - b.rank); // laser 5 m first, 10 m last
    return new KibanSource(blocks);
  }

  get count() {
    return this.blocks.length;
  }

  /** Union bbox [w, s, e, n] of all blocks, or null */
  bbox(): [number, number, number, number] | null {
    if (!this.blocks.length) return null;
    return [
      Math.min(...this.blocks.map((b) => b.west)),
      Math.min(...this.blocks.map((b) => b.south)),
      Math.max(...this.blocks.map((b) => b.east)),
      Math.max(...this.blocks.map((b) => b.north)),
    ];
  }

  /** Blocks intersecting a bbox, best resolution first */
  blocksIn(w: number, s: number, e: number, n: number): KibanBlock[] {
    return this.blocks.filter((b) => b.west < e && b.east > w && b.south < n && b.north > s);
  }

  /**
   * Sample heights at the given lon/lat points into `out` where data exists
   * (bilinear between grid points; points are at cell centres). Returns how many were set.
   */
  async sampleInto(lons: Float64Array, lats: Float64Array, out: Float32Array, blocks: KibanBlock[]): Promise<number> {
    let set = 0;
    const done = new Uint8Array(out.length);
    for (const b of blocks) {
      const data = await loadData(b);
      const dLon = (b.east - b.west) / b.nx;
      const dLat = (b.north - b.south) / b.ny;
      for (let i = 0; i < out.length; i++) {
        if (done[i]) continue;
        const lon = lons[i];
        const lat = lats[i];
        if (lon < b.west || lon >= b.east || lat <= b.south || lat > b.north) continue;
        const fx = Math.min(Math.max((lon - b.west) / dLon - 0.5, 0), b.nx - 1);
        const fy = Math.min(Math.max((b.north - lat) / dLat - 0.5, 0), b.ny - 1);
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, b.nx - 1);
        const y1 = Math.min(y0 + 1, b.ny - 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const v =
          (data[y0 * b.nx + x0] * (1 - tx) + data[y0 * b.nx + x1] * tx) * (1 - ty) +
          (data[y1 * b.nx + x0] * (1 - tx) + data[y1 * b.nx + x1] * tx) * ty;
        if (Number.isFinite(v)) {
          out[i] = v;
          done[i] = 1;
          set++;
        }
      }
    }
    return set;
  }

  /** Free loaded value lists (keeps headers) */
  release() {
    for (const b of this.blocks) delete b.data;
    loaded.length = 0;
    loadedValues = 0;
  }
}
