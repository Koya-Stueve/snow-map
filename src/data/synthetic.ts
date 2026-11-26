// Deterministic synthetic snowfall for development: storm cells drifting
// north-east across Japan, enhanced over (rough, hand-placed) mountain areas.
// NOT a forecast – the UI labels it as sample data.

import { HOUR_MS, type ForecastDataset } from './types';
import { JAPAN_GRID } from './japanGrid';

// Rough mountain areas: [lon, lat, radius°, weight]
const MOUNTAINS: Array<[number, number, number, number]> = [
  [140.75, 42.82, 0.35, 1.0], // Niseko / Yotei / Rusutsu
  [141.15, 43.05, 0.3, 0.6], // Sapporo backcountry / Kiroro
  [142.75, 43.6, 0.55, 1.0], // Daisetsuzan
  [142.35, 43.3, 0.35, 0.8], // Furano / Tokachi
  [142.2, 43.8, 0.3, 0.5], // Kamui
  [140.4, 38.2, 0.4, 0.8], // Zao
  [140.1, 39.7, 0.6, 0.6], // Ou mountains
  [139.9, 37.6, 0.5, 0.6], // Bandai
  [138.3, 36.85, 0.45, 1.0], // Myoko / Nozawa / Shiga
  [137.75, 36.55, 0.45, 1.0], // Northern Alps / Hakuba
  [138.9, 36.9, 0.45, 0.7], // Minakami / Yuzawa
];

// Storm cells: start position, drift (°/h), radius°, peak intensity (cm/h), active hours
const STORMS = [
  { lon: 138.6, lat: 42.6, vLon: 0.07, vLat: 0.035, r: 1.1, peak: 3.2, from: 2, to: 40 },
  { lon: 135.2, lat: 35.4, vLon: 0.09, vLat: 0.03, r: 1.4, peak: 2.6, from: 18, to: 70 },
  { lon: 139.4, lat: 41.6, vLon: 0.06, vLat: 0.03, r: 0.9, peak: 2.2, from: 55, to: 100 },
  { lon: 136.6, lat: 36.0, vLon: 0.05, vLat: 0.025, r: 1.0, peak: 2.0, from: 80, to: 120 },
];

export function createSyntheticDataset(now = Date.now(), hours = 120): ForecastDataset {
  const runTime = Math.floor(now / (6 * HOUR_MS)) * 6 * HOUR_MS - 6 * HOUR_MS; // previous 6-hourly run
  const times: number[] = [];
  for (let i = 0; i <= hours; i++) times.push(runTime + i * HOUR_MS);

  const g = JAPAN_GRID;
  const orog = new Float32Array(g.nx * g.ny);
  for (let y = 0; y < g.ny; y++) {
    const lat = g.lat0 + y * g.dLat;
    for (let x = 0; x < g.nx; x++) {
      const lon = g.lon0 + x * g.dLon;
      let m = 0;
      for (const [mx, my, r, w] of MOUNTAINS) {
        const d2 = ((lon - mx) ** 2 + (lat - my) ** 2) / (r * r);
        m = Math.max(m, w * Math.exp(-d2));
      }
      orog[y * g.nx + x] = m;
    }
  }

  const snowfall: Float32Array[] = times.map((_, h) => {
    const f = new Float32Array(g.nx * g.ny);
    if (h === 0) return f; // nothing "during the hour ending" at run time
    for (const s of STORMS) {
      if (h < s.from || h > s.to) continue;
      const life = (h - s.from) / (s.to - s.from);
      const env = Math.sin(Math.PI * life) ** 0.7; // grow and decay
      const cLon = s.lon + s.vLon * (h - s.from);
      const cLat = s.lat + s.vLat * (h - s.from);
      const x0 = Math.max(0, Math.floor((cLon - 3 * s.r - g.lon0) / g.dLon));
      const x1 = Math.min(g.nx - 1, Math.ceil((cLon + 3 * s.r - g.lon0) / g.dLon));
      const y0 = Math.max(0, Math.floor((cLat - 3 * s.r - g.lat0) / g.dLat));
      const y1 = Math.min(g.ny - 1, Math.ceil((cLat + 3 * s.r - g.lat0) / g.dLat));
      for (let y = y0; y <= y1; y++) {
        const lat = g.lat0 + y * g.dLat;
        for (let x = x0; x <= x1; x++) {
          const lon = g.lon0 + x * g.dLon;
          const i = y * g.nx + x;
          const d2 = ((lon - cLon) ** 2 + (lat - cLat) ** 2) / (s.r * s.r);
          // Banded texture so it doesn't look like perfect blobs
          const bands = 0.75 + 0.25 * Math.sin(lon * 7.3 + lat * 4.1 + h * 0.35);
          f[i] += s.peak * env * Math.exp(-d2) * bands * (0.08 + orog[i]);
        }
      }
    }
    return f;
  });

  return {
    meta: {
      model: 'Demo',
      provider: 'Synthetische Beispieldaten',
      runTime,
      synthetic: true,
      notes: ['Erfundene Schneezellen zum Entwickeln – keine Prognose.'],
    },
    times,
    grid: g,
    cells: Int32Array.from({ length: g.nx * g.ny }, (_, i) => i), // every cell stored
    fields: { snowfall },
  };
}
