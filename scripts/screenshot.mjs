// Dev helper: render the app in headless Edge/Chrome, wait until the map is idle,
// print console errors and save a screenshot.
// Usage: node scripts/screenshot.mjs <out.png> [width] [height] [url]
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const [out = 'shot.png', w = '1280', h = '800', url = 'http://localhost:5173'] = process.argv.slice(2);

const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Edge/Chrome found; set BROWSER_PATH');

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  // GPU=1 → real GPU (ANGLE D3D11), otherwise software rendering
  args:
    process.env.GPU === '1'
      ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  defaultViewport: { width: Number(w), height: Number(h) },
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warn') console.log(`[${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

// Don't wait for network idle: map tiles keep streaming (slow on mobile hotspots)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.snowMap && window.snowApp, { timeout: 120000 });
const settle = (ms) =>
  page.evaluate(
    (ms) =>
      new Promise((r) => {
        if (window.snowMap.loaded() && window.snowMap.areTilesLoaded()) return r(true);
        window.snowMap.once('idle', () => r(true));
        setTimeout(() => r(false), ms);
      }),
    ms,
  );
if (!(await settle(120000))) console.log('[warn] map not idle after 120 s – screenshot anyway');
if (process.env.EVAL) {
  console.log(await page.evaluate(process.env.EVAL));
  // Let the map settle after whatever EVAL changed (camera moves load new tiles)
  await page.evaluate(() => window.snowMap.triggerRepaint());
  await new Promise((r) => setTimeout(r, 500));
  if (!(await settle(Number(process.env.SETTLE_MS ?? 90000)))) console.log('[warn] map not idle after EVAL – screenshot anyway');
  await new Promise((r) => setTimeout(r, 300));
}
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
