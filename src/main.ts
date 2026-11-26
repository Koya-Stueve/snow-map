import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre resolves its worker relative to its own module URL, which breaks
// after Vite pre-bundling. Point it at the real worker file explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/oswald/600.css';
import './styles.css';

import { buildStyle, WEATHER_INSERT_BEFORE } from './map/style';
import { RasterOverlay } from './map/rasterOverlay';
import { ScalarCanvas } from './render/scalarCanvas';
import { buildLut, PALETTES, type ColorLut } from './render/palette';
import { Legend } from './ui/legend';
import { loadTheme, saveTheme, type ThemeName } from './theme';
import { RESORTS } from './data/resorts';
import { createSyntheticDataset } from './data/synthetic';
import { HOUR_MS } from './data/types';
import { SnowfallLayer } from './layers/snow';
import type { ViewTime } from './layers/types';
import { TimeController } from './time/timeController';
import { ResortLabels } from './ui/resortLabels';
import { Timeline } from './ui/timeline';
import { DISPLAY_TZ_LABEL, formatDate, formatDay, formatRun, formatTime } from './ui/timeFormat';

// Start view: whole of Hokkaido, fitted to the viewport (desktop + phone)
const HOKKAIDO_BOUNDS: [[number, number], [number, number]] = [
  [139.6, 41.4],
  [145.6, 45.5],
];
// Rough Japan bounds to keep panning sensible
const JAPAN_BOUNDS: [[number, number], [number, number]] = [
  [122, 23],
  [150, 47],
];

maplibregl.setWorkerUrl(workerUrl);

let theme: ThemeName = loadTheme();
document.documentElement.dataset.theme = theme;

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(theme),
  bounds: HOKKAIDO_BOUNDS,
  fitBoundsOptions: { padding: { top: 120, bottom: 140, left: 16, right: 16 } },
  minZoom: 4,
  maxZoom: 12,
  maxBounds: JAPAN_BOUNDS,
  attributionControl: false,
  // Needed later to grab frames for video export
  canvasContextAttributes: { preserveDrawingBuffer: true },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
// No MapLibre attribution control: all required credits (with links) are in our
// own always-visible source line, which also ends up in exported videos.

// --- Data + layer (synthetic until step 5) ---
const dataset = createSyntheticDataset();
const layer = new SnowfallLayer();
layer.prepare(dataset);

// --- Map raster for the active layer ---
const scalar = new ScalarCanvas(dataset.grid, 3);
const overlay = new RasterOverlay(map, scalar, 'weather', WEATHER_INSERT_BEFORE);
const fieldBuf = new Float32Array(dataset.grid.nx * dataset.grid.ny);
const legend = new Legend(document.getElementById('legend-slot')!);
const lutCache = new Map<string, ColorLut>();
function lutFor(mode: ViewTime['mode']): ColorLut {
  const key = `${layer.id}|${mode}|${theme}`;
  let lut = lutCache.get(key);
  if (!lut) lutCache.set(key, (lut = buildLut(layer.colorStops(mode), PALETTES[theme])));
  return lut;
}

document.getElementById('theme-toggle')!.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  saveTheme(theme);
  document.documentElement.dataset.theme = theme;
  map.setStyle(buildStyle(theme));
  renderAt(time.state); // new palette; overlay re-adds itself on style.load
});

const labels = new ResortLabels(map, RESORTS);
const time = new TimeController(dataset.times);
new Timeline(document.getElementById('hud-bottom')!, time, dataset.times);

const readoutTime = document.getElementById('readout-time')!;
const readoutSub = document.getElementById('readout-sub')!;

document.getElementById('source-line')!.innerHTML = [
  dataset.meta.synthetic
    ? '<strong>Synthetische Beispieldaten – keine Prognose</strong>'
    : `${dataset.meta.source} · Lauf ${formatRun(dataset.meta.runTime)}`,
  'Relief: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen Terrain Tiles</a>',
  'Karte: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> / <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
].join(' · ');

/**
 * Draw everything that depends on time. Pure function of `vt` – the video
 * exporter will call this for each frame instead of real-time playback.
 */
function renderAt(vt: ViewTime) {
  const ms = dataset.times[vt.startIndex] + vt.t * HOUR_MS;
  readoutTime.textContent = `${formatDate(ms)} · ${formatTime(ms)} ${DISPLAY_TZ_LABEL}`;
  const leadH = Math.round((ms - dataset.meta.runTime) / HOUR_MS);
  readoutSub.textContent =
    `${vt.mode === 'accumulated' ? `${layer.label} seit ${formatDay(dataset.times[vt.startIndex])} ${formatTime(dataset.times[vt.startIndex])}` : `${layer.label} pro Stunde`}` +
    ` · Prognosestunde +${leadH} h · Lauf ${formatRun(dataset.meta.runTime)}`;

  const lut = lutFor(vt.mode);
  scalar.draw(layer.fieldAt(vt, fieldBuf), lut);
  overlay.refresh();
  legend.update(`${layer.label} · ${layer.unit(vt.mode)}`, layer.colorStops(vt.mode), lut);

  const values: Record<string, number> = {};
  for (const r of RESORTS) values[r.id] = layer.valueAt(vt, r.lon, r.lat);
  labels.setValues(values, {
    format: (v) => layer.format(v, vt.mode),
    unit: layer.unit(vt.mode),
    stops: layer.colorStops(vt.mode),
  });
}

time.subscribe(renderAt);

// Expose for debugging and later export tooling
Object.assign(window, { snowMap: map, snowApp: { time, renderAt, dataset, layer, scalar, lutFor } });
