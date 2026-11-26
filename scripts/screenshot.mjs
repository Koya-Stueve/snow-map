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
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  defaultViewport: { width: Number(w), height: Number(h) },
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warn') console.log(`[${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => window.snowMap && window.snowMap.loaded(), { timeout: 60000 }).catch(() => {
  console.log('[warn] map did not report loaded within timeout');
});
await page.evaluate(() => new Promise((r) => (window.snowMap.areTilesLoaded() ? r() : window.snowMap.once('idle', r))));
if (process.env.EVAL) {
  console.log(await page.evaluate(process.env.EVAL));
  // Let the map settle after whatever EVAL changed (bounded wait)
  await page.evaluate(
    () =>
      new Promise((r) => {
        const done = () => setTimeout(r, 300);
        window.snowMap.once('idle', done);
        window.snowMap.triggerRepaint();
        setTimeout(r, 5000);
      }),
  );
}
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
