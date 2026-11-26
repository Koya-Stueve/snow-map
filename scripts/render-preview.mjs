// Frame-by-frame preview render (precursor of the Phase 3 exporter).
// Drives the app in a headless browser on the real GPU: set time + camera →
// wait until exactly that state is on screen (surfaceReady) → save the frame.
// Not real time, so slow hardware only makes it take longer.
//
//   node scripts/render-preview.mjs still [shot]           → renders/<shot>.png
//   node scripts/render-preview.mjs video [shot] [frames]  → renders/<shot>.mp4
//
// Shots: daisetsu (default), niseko, tomamu.
// Env: WIDTH/HEIGHT (1080×1920), SSAA (2 = render at 2× and downscale), COLUMNS=1 (column view; DENSITY=0 / COLFADE=0 turn density / soft foot off), LAYER
// (snowfall | snow_depth), GPU=0 (software), FFMPEG (path to ffmpeg),
// WORKERS (parallel browsers for video, default 2; ~1.3 GB RAM each),
// COLSIZE (column spacing in screen px, follows the zoom), COLHEIGHT=0, ZOOM/PITCH/BEARING, TAG (file name suffix).
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [mode = 'still', shotName = 'daisetsu', framesArg = '240'] = process.argv.slice(2);
const W = Number(process.env.WIDTH ?? 1080);
const H = Number(process.env.HEIGHT ?? 1920);
const SSAA = Number(process.env.SSAA ?? 2);
const LAYER = process.env.LAYER ?? 'snowfall';
const FPS = 24;
const HOLD = FPS; // frames to hold the final state
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'renders');
const URL = 'http://localhost:5173/?render=1';
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

// Close, low cameras so the mountains fill the frame; slow orbit
const SHOTS = {
  daisetsu: { center: [142.84, 43.66], zoom: 11.7, pitch: 64, bearing0: 5, bearing1: 30, region: [142.4, 43.3, 143.2, 43.9] },
  niseko: { center: [140.74, 42.84], zoom: 11.9, pitch: 66, bearing0: -35, bearing1: -10, region: [140.4, 42.6, 141.1, 43.0] },
  tomamu: { center: [142.68, 43.08], zoom: 12.1, pitch: 64, bearing0: 30, bearing1: 55, region: [142.45, 42.95, 142.9, 43.15] },
};
const shot = SHOTS[shotName] && { ...SHOTS[shotName] };
// Optional camera overrides (stills from further away etc.): ZOOM, PITCH, BEARING
if (shot && process.env.ZOOM) shot.zoom = Number(process.env.ZOOM);
if (shot && process.env.PITCH) shot.pitch = Number(process.env.PITCH);
if (shot && process.env.BEARING) shot.bearing0 = shot.bearing1 = Number(process.env.BEARING);
if (!shot) throw new Error(`unknown shot ${shotName} (${Object.keys(SHOTS).join(', ')})`);

const browserPath = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'];
const swArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const COLUMNS = process.env.COLUMNS === '1';
// Column options (on by default): DENSITY=0 / COLFADE=0 switch off density and soft foot
const flags = {
  'snowmap.layer': LAYER,
  'snowmap.columns': COLUMNS ? '1' : '0',
  'snowmap.colDensity': process.env.DENSITY === '0' ? '0' : '1',
  'snowmap.colFade': process.env.COLFADE === '0' ? '0' : '1',
  // COLSIZE: column spacing in screen px (unset = app default 35, 0 = fixed 2.5 km); COLHEIGHT=0: heights don't shrink
  ...(process.env.COLSIZE ? { 'snowmap.colSize': process.env.COLSIZE } : {}),
  'snowmap.colHeightFollow': process.env.COLHEIGHT === '0' ? '0' : '1',
};
/**
 * One headless browser with the app loaded. Video frames can be split across
 * several of these (WORKERS): every frame sets time + camera itself, so the
 * output does not depend on which worker rendered it or in which order.
 */
async function openWorker() {
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: process.env.GPU === '0' ? swArgs : gpuArgs,
    defaultViewport: { width: W, height: H, deviceScaleFactor: SSAA },
    protocolTimeout: 900000,
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.evaluateOnNewDocument((flags) => {
    try {
      for (const [k, v] of Object.entries(flags)) localStorage.setItem(k, v);
    } catch {}
  }, flags);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.snowMap && window.snowApp, { timeout: 120000 });
  if (COLUMNS) await page.waitForFunction(() => window.snowApp.columns, { timeout: 180000 });
  return { browser, page };
}
const main = await openWorker();
const page = main.page;
const suffix =
  (LAYER === 'snowfall' ? '' : '-' + LAYER) +
  (COLUMNS ? '-columns' : '') +
  (COLUMNS && process.env.DENSITY === '0' ? '-ohne-dichte' : '') +
  (COLUMNS && process.env.COLFADE === '0' ? '-ohne-fuss' : '') +
  (COLUMNS && process.env.COLSIZE ? '-s' + process.env.COLSIZE : '') +
  (process.env.TAG ? '-' + process.env.TAG : '');

const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`WebGL: ${renderer} · ${W}×${H} ×${SSAA} SSAA · layer ${LAYER} · shot ${shotName}`);

/**
 * Time warp: hours with more snowfall in the shot's region get more frames, so the
 * build-up is readable instead of "snow suddenly appears". Returns t (hours) per frame.
 */
async function timeline(n) {
  return page.evaluate(
    (n, region) => {
      const { dataset, time } = window.snowApp;
      time.setRange(96);
      const { startIndex, rangeHours } = time.state;
      const g = dataset.grid;
      const inRegion = [];
      dataset.cells.forEach((d, k) => {
        const lon = g.lon0 + (d % g.nx) * g.dLon;
        const lat = g.lat0 + Math.floor(d / g.nx) * g.dLat;
        if (lon >= region[0] && lon <= region[2] && lat >= region[1] && lat <= region[3]) inRegion.push(k);
      });
      const sf = dataset.fields.snowfall;
      const rate = [];
      for (let h = 0; h <= rangeHours; h++) {
        const f = sf[Math.min(startIndex + h, sf.length - 1)];
        let s = 0;
        for (const k of inRegion) s += f[k] > 0 ? f[k] : 0;
        rate.push(inRegion.length ? s / inRegion.length : 0);
      }
      const max = Math.max(...rate, 1e-6);
      // frame density: 1 everywhere + up to 5× during the heaviest snowfall
      const w = rate.map((r) => 1 + 4 * (r / max));
      const cum = [0];
      for (let h = 1; h <= rangeHours; h++) cum.push(cum[h - 1] + (w[h - 1] + w[h]) / 2);
      const total = cum[rangeHours];
      const ts = [];
      for (let i = 0; i < n; i++) {
        const target = (i / (n - 1)) * total;
        let h = 0;
        while (h < rangeHours - 1 && cum[h + 1] < target) h++;
        const seg = cum[h + 1] - cum[h];
        ts.push(h + (seg > 0 ? (target - cum[h]) / seg : 0));
      }
      return ts;
    },
    n,
    shot.region,
  );
}

const ease = (f) => f * f * (3 - 2 * f); // smooth start/stop of the camera

/** Apply time t + camera progress f and wait until it is fully on screen */
async function frame(page, t, f) {
  return page.evaluate(
    async (t, f, shot) => {
      const { time, surfaceReady } = window.snowApp;
      time.setRange(96);
      time.setMode('accumulated');
      window.snowMap.jumpTo({
        center: shot.center,
        zoom: shot.zoom,
        pitch: shot.pitch,
        bearing: shot.bearing0 + (shot.bearing1 - shot.bearing0) * f,
      });
      time.setTime(t);
      const t0 = performance.now();
      await surfaceReady();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Math.round(performance.now() - t0);
    },
    t,
    f,
    shot,
  );
}

await mkdir(OUT, { recursive: true });
const downscale = ['-vf', `scale=${W}:${H}:flags=lanczos`];

if (mode === 'still') {
  const ms = await frame(page, 96, 1);
  const raw = path.join(OUT, `${shotName}-raw.png`);
  const file = path.join(OUT, `${shotName}${suffix}.png`);
  await page.screenshot({ path: raw });
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', raw, ...downscale, file]);
  await rm(raw);
  console.log(`saved ${file} (${ms} ms)`);
} else {
  const n = Number(framesArg);
  const ts = await timeline(n);
  // per-video frame folder, so several renders can run side by side
  const dir = path.join(OUT, `frames-${shotName}${suffix}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // WORKERS: parallel browsers. The GPU is mostly idle while one browser waits for
  // tiles and encodes PNGs, so 2–3 workers render clearly faster (~1.3 GB RAM each).
  const nWorkers = Math.max(1, Math.min(n, Number(process.env.WORKERS ?? 2)));
  const workers = [main, ...(await Promise.all(Array.from({ length: nWorkers - 1 }, openWorker)))];
  console.log(`${nWorkers} worker(s)`);
  const t0 = Date.now();
  let next = 0;
  let done = 0;
  await Promise.all(
    workers.map(async ({ page }) => {
      while (next < n) {
        const i = next++; // shared queue: neighbouring frames spread across workers
        const ms = await frame(page, ts[i], ease(i / (n - 1)));
        await page.screenshot({ path: path.join(dir, `${String(i).padStart(4, '0')}.png`), optimizeForSpeed: true });
        done++;
        if (done % 12 === 0 || done === n) {
          const s = (Date.now() - t0) / 1000;
          console.log(`frame ${done}/${n} (${ms} ms, ${s.toFixed(0)} s, ${(s / done).toFixed(2)} s/frame, ~${((s / done) * (n - done)).toFixed(0)} s left)`);
        }
      }
    }),
  );
  for (const w of workers.slice(1)) await w.browser.close();
  const mp4 = path.join(OUT, `${shotName}${suffix}.mp4`);
  // hold the last frame for a second, downscale (SSAA), high-quality x264
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.png'),
    '-vf', `tpad=stop_mode=clone:stop=${HOLD},scale=${W}:${H}:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4,
  ]);
  await rm(dir, { recursive: true, force: true });
  console.log(`saved ${mp4} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
await main.browser.close();
