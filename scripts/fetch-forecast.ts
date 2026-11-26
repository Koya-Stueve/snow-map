// Fetch the latest DWD ICON forecast for Japan from Open-Meteo and write compact
// binary files for the web app.
//
//   npm run fetch                 full fetch
//   npm run fetch -- --dry-run    only compute the cell list and API budget
//   npm run fetch -- --limit 300  fetch only the first N cells (testing)
//
// Output: public/data/<model>/<run>/{meta.json,cells.i32,<variable>.u16} and
// public/data/latest.json pointing at the newest run. Old runs are pruned.
//
// Data: Open-Meteo.com (CC BY 4.0), model data DWD ICON. Free tier is for
// non-commercial use only; set OPEN_METEO_API_KEY to use a paid plan.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { FETCH_REGIONS, JAPAN_GRID } from '../src/data/japanGrid.ts';
import { RESORTS } from '../src/data/resorts.ts';

// --- Configuration ---------------------------------------------------------

const MODEL = {
  id: 'icon_global',
  apiModel: 'icon_global',
  label: 'DWD ICON',
  metaUrl: 'https://api.open-meteo.com/data/dwd_icon/static/meta.json',
};

/**
 * Variables to fetch (≤ 10 keeps it at one API call per location).
 * Stored as uint16 = round((value − offset) / scale); 65535 = missing.
 * Display value = stored · scale·toDisplay + offset·toDisplay.
 */
const VARIABLES = [
  { name: 'snowfall', scale: 0.01, offset: 0, toDisplay: 1, displayUnit: 'cm', kind: 'sum' },
  { name: 'snow_depth', scale: 0.001, offset: 0, toDisplay: 100, displayUnit: 'cm', kind: 'instant' },
  // Snow downscaling: rain/snow line and wind for lee loading
  { name: 'freezing_level_height', scale: 1, offset: 0, toDisplay: 1, displayUnit: 'm', kind: 'instant' },
  { name: 'wind_speed_850hPa', scale: 0.1, offset: 0, toDisplay: 1, displayUnit: 'km/h', kind: 'instant' },
  { name: 'wind_direction_850hPa', scale: 1, offset: 0, toDisplay: 1, displayUnit: '°', kind: 'instant' },
  // Phase 2 temperature layer
  { name: 'temperature_2m', scale: 0.01, offset: -60, toDisplay: 1, displayUnit: '°C', kind: 'instant' },
] as const;

const FORECAST_DAYS = 8; // ICON Global reaches 7.5 days; trailing empty hours are trimmed
const BATCH = 100; // locations per request
// Free tier: 600 calls/min, 5000/h, 10000/day. It's not documented whether a
// multi-location request counts once or per location – assume per location.
const CALLS_PER_MINUTE = 500;
const HOURLY_CAP = 5000;
const KEEP_RUNS = 3;

const API_KEY = process.env.OPEN_METEO_API_KEY;
const API_BASE = API_KEY ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast';
const USER_AGENT = 'snow-map/0.1 (forecast map; fetch script)';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

const log = (...a: unknown[]) => console.log('[fetch]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Land mask from Mapzen/AWS terrain tiles --------------------------------

const TILE_Z = 7;
const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z * 256;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * 256;
};

const tileCache = new Map<string, PNG>();
async function tile(x: number, y: number): Promise<PNG> {
  const key = `${TILE_Z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const file = path.join(CACHE, 'terrain', `${TILE_Z}_${x}_${y}.png`);
  let buf: Buffer;
  if (existsSync(file)) buf = await readFile(file);
  else {
    const res = await fetch(TILE_URL(TILE_Z, x, y), { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`terrain tile ${key}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buf);
  }
  const png = PNG.sync.read(buf);
  tileCache.set(key, png);
  return png;
}

/** Terrarium elevation in metres (negative = sea floor) */
async function elevation(lon: number, lat: number): Promise<number> {
  const px = lonToX(lon, TILE_Z);
  const py = latToY(lat, TILE_Z);
  const tx = Math.floor(px / 256);
  const ty = Math.floor(py / 256);
  const png = await tile(tx, ty);
  const i = ((Math.floor(py) - ty * 256) * 256 + (Math.floor(px) - tx * 256)) * 4;
  return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
}

interface CellSets {
  /** Land cells inside FETCH_REGIONS – these are fetched */
  land: Int32Array;
  /** One-cell sea buffer around them – filled from land neighbours, not fetched */
  buffer: Int32Array;
}

/** Land cells inside FETCH_REGIONS plus a one-cell buffer (for clean coastal interpolation). */
async function computeCells(): Promise<CellSets> {
  const g = JAPAN_GRID;
  const cacheFile = path.join(CACHE, `cells_v2_${g.lon0}_${g.lat0}_${g.dLon}_${g.nx}x${g.ny}.json`);
  if (existsSync(cacheFile)) {
    const c = JSON.parse(await readFile(cacheFile, 'utf8'));
    return { land: Int32Array.from(c.land), buffer: Int32Array.from(c.buffer) };
  }

  log('computing land mask from terrain tiles (one-time)...');
  const inRegion = (lon: number, lat: number) =>
    FETCH_REGIONS.some(({ bbox: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n);
  const land = new Uint8Array(g.nx * g.ny);
  for (let y = 0; y < g.ny; y++) {
    for (let x = 0; x < g.nx; x++) {
      const lon = g.lon0 + x * g.dLon;
      const lat = g.lat0 + y * g.dLat;
      if (!inRegion(lon, lat)) continue;
      // Land if any of 3×3 sub-samples is above sea level
      let isLand = false;
      for (let sy = -1; sy <= 1 && !isLand; sy++)
        for (let sx = -1; sx <= 1 && !isLand; sx++)
          if ((await elevation(lon + (sx * g.dLon) / 3, lat + (sy * g.dLat) / 3)) > 0) isLand = true;
      land[y * g.nx + x] = isLand ? 1 : 0;
    }
  }
  const landList: number[] = [];
  const bufferList: number[] = [];
  for (let y = 0; y < g.ny; y++)
    for (let x = 0; x < g.nx; x++) {
      const i = y * g.nx + x;
      if (land[i]) {
        landList.push(i);
        continue;
      }
      if (landNeighbours(land, x, y).length) bufferList.push(i);
    }
  await mkdir(CACHE, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ land: landList, buffer: bufferList }));
  return { land: Int32Array.from(landList), buffer: Int32Array.from(bufferList) };
}

/** Dense indices of the 8 neighbours of (x, y) that are marked in `mask` */
function landNeighbours(mask: ArrayLike<number>, x: number, y: number): number[] {
  const g = JAPAN_GRID;
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < g.nx && yy < g.ny && mask[yy * g.nx + xx]) out.push(yy * g.nx + xx);
    }
  return out;
}

// --- Open-Meteo -------------------------------------------------------------

interface ModelMeta {
  last_run_initialisation_time: number;
  last_run_availability_time: number;
}

async function modelMeta(): Promise<ModelMeta> {
  const res = await fetch(MODEL.metaUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`model meta: HTTP ${res.status}`);
  return (await res.json()) as ModelMeta;
}

interface Location {
  elevation?: number;
  hourly: { time: number[] } & Record<string, (number | null)[]>;
}

async function fetchBatch(points: Array<[number, number]>, attempt = 1): Promise<Location[]> {
  const params = new URLSearchParams({
    // 4 decimals: Open-Meteo picks the model cell by the terrain height at the exact
    // coordinate, so rounding a slope location by ~300 m can change the result
    latitude: points.map((p) => p[1].toFixed(4)).join(','),
    longitude: points.map((p) => p[0].toFixed(4)).join(','),
    hourly: VARIABLES.map((v) => v.name).join(','),
    models: MODEL.apiModel,
    forecast_days: String(FORECAST_DAYS),
    timeformat: 'unixtime',
    // Only land cells are requested: pick a model land cell with matching terrain height
    cell_selection: 'land',
  });
  if (API_KEY) params.set('apikey', API_KEY);
  const res = await fetch(`${API_BASE}?${params}`, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`Open-Meteo HTTP ${res.status} after ${attempt} attempts`);
    const wait = 15_000 * attempt;
    log(`HTTP ${res.status}, retrying in ${wait / 1000}s...`);
    await sleep(wait);
    return fetchBatch(points, attempt + 1);
  }
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [json];
}

type PointSeries = { id: string; elevation: number | null; series: Record<string, (number | null)[]> };

/**
 * Exact model values at each resort's coordinates (used by the labels, so they
 * match what a point query at Open-Meteo returns). Aligned to `times`.
 */
async function fetchResortPoints(times: number[]): Promise<PointSeries[]> {
  const locs = await fetchBatch(RESORTS.map((r) => [r.lon, r.lat] as [number, number]));
  log(`resort points ok (${RESORTS.length})`);
  return RESORTS.map((r, k) => {
    const loc = locs[k];
    const index = new Map(loc.hourly.time.map((t, i) => [t * 1000, i]));
    return {
      id: r.id,
      elevation: loc.elevation ?? null,
      series: Object.fromEntries(
        VARIABLES.map((v) => {
          const raw = loc.hourly[v.name] ?? [];
          return [
            v.name,
            times.map((t) => {
              const i = index.get(t);
              const x = i == null ? null : raw[i];
              return x == null ? null : +(x * v.toDisplay).toFixed(3);
            }),
          ];
        }),
      ),
    };
  });
}

/** Add/refresh resort points in the latest run without re-fetching the grid. */
async function pointsOnly() {
  const latest = JSON.parse(await readFile(path.join(OUT, 'latest.json'), 'utf8'));
  const metaPath = path.join(OUT, latest.meta);
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const current = await modelMeta();
  if (current.last_run_initialisation_time * 1000 !== meta.runTime)
    throw new Error('a newer model run is available – run a full fetch instead of --points-only');
  meta.points = await fetchResortPoints(meta.times);
  const note = 'Resort-Werte: eigene Open-Meteo-Punktabfrage am Resort-Koordinatenpunkt.';
  if (!meta.notes.includes(note)) meta.notes.push(note);
  await writeFile(metaPath, JSON.stringify(meta));
  log(`updated points in ${path.relative(ROOT, metaPath)}`);
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (args.includes('--points-only')) return pointsOnly();
  const g = JAPAN_GRID;
  const sets = await computeCells();
  let cells = sets.land;
  if (Number.isFinite(LIMIT)) cells = cells.slice(0, LIMIT);
  const batches = Math.ceil(cells.length / BATCH);
  const minutes = cells.length / CALLS_PER_MINUTE;
  log(
    `${cells.length} land cells (+${sets.buffer.length} coastal buffer cells, filled locally) in ${batches} requests ` +
      `(~${cells.length} API calls if counted per location, ~${minutes.toFixed(1)} min)`,
  );
  if (cells.length > HOURLY_CAP) throw new Error(`more than ${HOURLY_CAP} locations – would exceed the free hourly limit`);
  if (DRY) return;

  const before = await modelMeta();
  const runTime = before.last_run_initialisation_time * 1000;
  log(`model ${MODEL.label}, run ${new Date(runTime).toISOString()}`);

  let times: number[] | null = null;
  const series: Record<string, Float32Array[]> = {}; // per variable: per cell time series
  for (const v of VARIABLES) series[v.name] = [];

  const interval = (BATCH / CALLS_PER_MINUTE) * 60_000;
  for (let b = 0; b < batches; b++) {
    const started = Date.now();
    const slice = Array.from(cells.subarray(b * BATCH, (b + 1) * BATCH));
    const points = slice.map((i) => [g.lon0 + (i % g.nx) * g.dLon, g.lat0 + Math.floor(i / g.nx) * g.dLat] as [number, number]);
    const locs = await fetchBatch(points);
    if (locs.length !== points.length) throw new Error(`expected ${points.length} locations, got ${locs.length}`);
    for (const loc of locs) {
      times ??= loc.hourly.time.map((t) => t * 1000);
      for (const v of VARIABLES) {
        const raw = loc.hourly[v.name] ?? [];
        series[v.name].push(Float32Array.from(raw, (x) => (x == null ? NaN : x)));
      }
    }
    log(`batch ${b + 1}/${batches} ok`);
    if (b < batches - 1) await sleep(Math.max(0, interval - (Date.now() - started)));
  }

  const resortSeries = await fetchResortPoints(times!);

  const after = await modelMeta();
  if (after.last_run_initialisation_time !== before.last_run_initialisation_time)
    log('WARNING: a new model run became available during the fetch; data may mix two runs. Re-run to be safe.');

  // Trim trailing hours without snowfall data at most cells (beyond model range)
  let nTimes = times!.length;
  const sf = series.snowfall;
  while (nTimes > 0 && sf.filter((s) => Number.isNaN(s[nTimes - 1])).length > sf.length / 2) nTimes--;
  times = times!.slice(0, nTimes);

  // Coastal buffer: each buffer cell gets the mean of its fetched land neighbours
  // (only used to interpolate cleanly up to the coastline; the sea itself is masked)
  const fetched = new Uint8Array(g.nx * g.ny);
  const slot = new Map<number, number>();
  cells.forEach((i, k) => {
    fetched[i] = 1;
    slot.set(i, k);
  });
  const bufferCells: number[] = [];
  for (const i of sets.buffer) {
    const nb = landNeighbours(fetched, i % g.nx, Math.floor(i / g.nx));
    if (!nb.length) continue;
    bufferCells.push(i);
    for (const v of VARIABLES) {
      const circular = v.name.includes('direction'); // mean of 350° and 10° must be 0°, not 180°
      const s = new Float32Array(nTimes);
      for (let t = 0; t < nTimes; t++) {
        let sum = 0;
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (const j of nb) {
          const x = series[v.name][slot.get(j)!][t];
          if (!Number.isFinite(x)) continue;
          if (circular) {
            sx += Math.cos((x * Math.PI) / 180);
            sy += Math.sin((x * Math.PI) / 180);
          } else sum += x;
          n++;
        }
        s[t] = !n ? NaN : circular ? ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360 : sum / n;
      }
      series[v.name].push(s);
    }
  }
  cells = Int32Array.from([...cells, ...bufferCells]);

  // Mean terrain height per cell (5×5 samples, sea → 0): stand-in for the smooth
  // model orography that the snow downscaling compares the fine DEM against
  const elevationMean = await Promise.all(
    Array.from(cells, async (i) => {
      const lon0 = g.lon0 + (i % g.nx) * g.dLon;
      const lat0 = g.lat0 + Math.floor(i / g.nx) * g.dLat;
      let sum = 0;
      for (let sy = -2; sy <= 2; sy++)
        for (let sx = -2; sx <= 2; sx++) sum += Math.max(0, await elevation(lon0 + (sx * g.dLon) / 5, lat0 + (sy * g.dLat) / 5));
      return Math.round(sum / 25);
    }),
  );

  // Write
  const runId = new Date(runTime).toISOString().slice(0, 13).replace(/[-:]/g, '') + 'Z'; // 20261126T06Z
  const dir = path.join(OUT, MODEL.id, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'cells.i32'), Buffer.from(cells.buffer, cells.byteOffset, cells.byteLength));

  const variables: Record<string, unknown> = {};
  for (const v of VARIABLES) {
    const data = new Uint16Array(nTimes * cells.length);
    for (let t = 0; t < nTimes; t++)
      for (let c = 0; c < cells.length; c++) {
        const x = series[v.name][c][t];
        data[t * cells.length + c] = Number.isFinite(x) ? Math.min(65534, Math.max(0, Math.round((x - v.offset) / v.scale))) : 65535;
      }
    const file = `${v.name}.u16`;
    await writeFile(path.join(dir, file), Buffer.from(data.buffer));
    variables[v.name] = { file, scale: v.scale * v.toDisplay, offset: v.offset * v.toDisplay, unit: v.displayUnit, kind: v.kind };
  }

  const meta = {
    version: 1,
    model: MODEL.label,
    modelId: MODEL.id,
    provider: 'Open-Meteo.com',
    providerUrl: 'https://open-meteo.com/',
    licence: 'CC BY 4.0',
    runTime,
    fetchedAt: Date.now(),
    times,
    grid: g,
    cells: { file: 'cells.i32', count: cells.length },
    /** Mean terrain height (m) per stored cell, same order as cells.i32 */
    elevationMean,
    variables,
    // Resort point series in display units (cm), aligned with `times`
    points: resortSeries.map((p) => ({
      ...p,
      series: Object.fromEntries(Object.entries(p.series).map(([k, s]) => [k, s.slice(0, nTimes)])),
    })),
    notes: [
      'Werte am Modellgitter (ICON ~11 km, Open-Meteo-Punkt je 0,1°-Zelle), für die Karte bilinear interpoliert.',
      'Nach 78 h liefert ICON 3-stündliche Werte; Open-Meteo interpoliert sie auf Stunden.',
      'Schneefall = Modell-Schnee (Wasseräquivalent × 0,7 cm/mm), Werte an Modellhöhe, nicht Gipfelhöhe.',
      'Resort-Werte: eigene Open-Meteo-Punktabfrage am Resort-Koordinatenpunkt.',
    ],
  };
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  await writeFile(path.join(OUT, 'latest.json'), JSON.stringify({ meta: `${MODEL.id}/${runId}/meta.json`, runTime }));
  log(`wrote ${path.relative(ROOT, dir)} (${nTimes} hours x ${cells.length} cells)`);

  // Prune old runs
  const runs = (await readdir(path.join(OUT, MODEL.id))).sort().reverse();
  for (const old of runs.slice(KEEP_RUNS)) {
    await rm(path.join(OUT, MODEL.id, old), { recursive: true, force: true });
    log(`pruned ${old}`);
  }
}

main().catch((e) => {
  console.error('[fetch] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
