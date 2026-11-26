// Frame-by-frame preview render (precursor of the Phase 3 exporter).
// Drives the app in a headless browser: set time + camera → wait until exactly
// that state is on screen (surfaceReady) → save the frame. Not real time.
//
//   node scripts/render-preview.mjs still            → renders/preview.png
//   node scripts/render-preview.mjs video [frames]   → renders/frames/*.png + renders/preview.mp4
//
// Env: WIDTH/HEIGHT (default 1080×1920, 9:16), GPU=0 to force software rendering.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [mode = 'still', framesArg = '96'] = process.argv.slice(2);
const W = Number(process.env.WIDTH ?? 1080);
const H = Number(process.env.HEIGHT ?? 1920);
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'renders');
const URL = 'http://localhost:5173/?render=1';

// Shot: Daisetsuzan from the south-west, 4-day new snow, slow orbit
const SHOT = { center: [142.78, 43.6], zoom: 10.9, pitch: 66, bearing0: 10, bearing1: 40, rangeHours: 96 };

const browserPath = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'];
const swArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: process.env.GPU === '0' ? swArgs : gpuArgs,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.snowMap && window.snowApp, { timeout: 120000 });

const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log('WebGL renderer:', renderer);

/** Apply state for frame i of n and wait until it is fully on screen */
async function frame(i, n) {
  const f = n > 1 ? i / (n - 1) : 1;
  return page.evaluate(
    async (f, shot) => {
      const { time, surfaceReady } = window.snowApp;
      const map = window.snowMap;
      time.setRange(shot.rangeHours);
      time.setMode('accumulated');
      map.jumpTo({
        center: shot.center,
        zoom: shot.zoom,
        pitch: shot.pitch,
        bearing: shot.bearing0 + (shot.bearing1 - shot.bearing0) * f,
      });
      time.setTime(f * time.state.rangeHours);
      const t0 = performance.now();
      await surfaceReady();
      // labels/DOM settle on the next animation frame
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Math.round(performance.now() - t0);
    },
    f,
    SHOT,
  );
}

await mkdir(OUT, { recursive: true });
if (mode === 'still') {
  const ms = await frame(1, 1);
  const file = path.join(OUT, 'preview.png');
  await page.screenshot({ path: file });
  console.log(`saved ${file} (${ms} ms)`);
} else {
  const n = Number(framesArg);
  const dir = path.join(OUT, 'frames');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const ms = await frame(i, n);
    await page.screenshot({ path: path.join(dir, `${String(i).padStart(4, '0')}.png`) });
    if (i % 8 === 0 || i === n - 1) console.log(`frame ${i + 1}/${n} (${ms} ms, ${((Date.now() - t0) / 1000).toFixed(0)} s total)`);
  }
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
  const mp4 = path.join(OUT, 'preview.mp4');
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '24', '-i', path.join(dir, '%04d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  console.log(`saved ${mp4}`);
}
await browser.close();
