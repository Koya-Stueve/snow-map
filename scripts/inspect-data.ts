// Dev helper: print a quick summary of the latest fetched forecast.
// Usage: node scripts/inspect-data.ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', 'public', 'data');
const latest = JSON.parse(await readFile(path.join(OUT, 'latest.json'), 'utf8'));
const metaPath = path.join(OUT, latest.meta);
const meta = JSON.parse(await readFile(metaPath, 'utf8'));
const dir = path.dirname(metaPath);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + 'Z';

console.log(`model ${meta.model}, run ${iso(meta.runTime)}, ${meta.times.length} h: ${iso(meta.times[0])} … ${iso(meta.times.at(-1))}`);
const n: number = meta.cells.count;
const cells = new Int32Array((await readFile(path.join(dir, meta.cells.file))).buffer.slice(0));
console.log(`cells: ${n} (file ${cells.length})`);

for (const [name, v] of Object.entries<{ file: string; scale: number; unit: string; kind: string }>(meta.variables)) {
  const buf = await readFile(path.join(dir, v.file));
  const raw = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  let missing = 0;
  let max = 0;
  let maxAt = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 65535) missing++;
    else if (raw[i] * v.scale > max) {
      max = raw[i] * v.scale;
      maxAt = i;
    }
  }
  // Per-cell total over all hours (sums) or last value (instant)
  let best = 0;
  let bestCell = 0;
  for (let c = 0; c < n; c++) {
    let s = 0;
    for (let t = 0; t < meta.times.length; t++) {
      const q = raw[t * n + c];
      if (q !== 65535) s = v.kind === 'sum' ? s + q * v.scale : Math.max(s, q * v.scale);
    }
    if (s > best) {
      best = s;
      bestCell = c;
    }
  }
  const g = meta.grid;
  const d = cells[bestCell];
  const where = `${(g.lon0 + (d % g.nx) * g.dLon).toFixed(1)}E ${(g.lat0 + Math.floor(d / g.nx) * g.dLat).toFixed(1)}N`;
  console.log(
    `${name}: missing ${((missing / raw.length) * 100).toFixed(1)}%, max single value ${max.toFixed(2)} ${v.unit}` +
      `${maxAt >= 0 ? ` at ${iso(meta.times[Math.floor(maxAt / n)])}` : ''}, ` +
      `${v.kind === 'sum' ? 'max total' : 'max'} ${best.toFixed(1)} ${v.unit} at ${where}`,
  );
}
