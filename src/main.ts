import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre resolves its worker relative to its own module URL, which breaks
// after Vite pre-bundling. Point it at the real worker file explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/oswald/600.css';
import './styles.css';

import { buildStyle, DEFAULT_EXAGGERATION, TERRAIN_SOURCE_ID } from './map/style';
import { CAMERA_PRESETS } from './map/cameras';
import { loadTerrainIndex, registerTerrainProtocols, terrainInfoForWorkers } from './map/terrainSource';
import { buildLut, PALETTES, type ColorLut } from './render/palette';
import { SurfaceRenderer, SurfaceSync } from './render/surface/surfaceSource';
import { Legend } from './ui/legend';
import { MAP_PALETTES, loadTheme, saveTheme, type ThemeName } from './theme';
import { RESORTS } from './data/resorts';
import { loadDataset } from './data/load';
import { HOUR_MS } from './data/types';
import { SnowfallLayer } from './layers/snow';
import { SnowDepthLayer } from './layers/snowDepth';
import type { ViewTime, WeatherLayer } from './layers/types';
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

const stored = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const store = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
};

maplibregl.setWorkerUrl(workerUrl);
registerTerrainProtocols();

// ?render=1: clean output for stills/video frames (no interactive controls)
if (new URLSearchParams(location.search).has('render')) document.body.classList.add('render-mode');

// --- Data first: the surface renderer must exist before the map asks for tiles ---
const [terrainIndex, { dataset, fallbackReason }] = await Promise.all([loadTerrainIndex(), loadDataset()]);
// Layer registry: new weather layers (Phase 2) are added here
const layers: WeatherLayer[] = [new SnowfallLayer(), ...(SnowDepthLayer.available(dataset) ? [new SnowDepthLayer()] : [])];
for (const l of layers) l.prepare(dataset);
const storedLayer = (() => {
  try {
    return localStorage.getItem('snowmap.layer');
  } catch {
    return null;
  }
})();
let layer: WeatherLayer = layers.find((l) => l.id === storedLayer) ?? layers[0];

// Surface tile resolution: 512 px per tile on hi-dpi screens and for renders
// (crisp relief + snow detail), 256 px otherwise. ?quality=1|2 overrides.
const params = new URLSearchParams(location.search);
const qualityParam = Number(params.get('quality'));
const surfaceScale = qualityParam === 1 || qualityParam === 2 ? qualityParam : params.has('render') || devicePixelRatio >= 1.5 ? 2 : 1;

const surface = new SurfaceRenderer({
  grid: dataset.grid,
  cells: dataset.cells,
  href: dataset.elevationMean ?? null,
  scale: surfaceScale,
  ...terrainInfoForWorkers(),
});

let theme: ThemeName = loadTheme();
document.documentElement.dataset.theme = theme;
let terrain3d = stored('snowmap.terrain3d', true);
let refined = stored('snowmap.refined', true);
const styleFor = () => buildStyle(theme, { terrain: terrain3d });

const map = new maplibregl.Map({
  container: 'map',
  style: styleFor(),
  bounds: HOKKAIDO_BOUNDS,
  fitBoundsOptions: { padding: { top: 120, bottom: 140, left: 16, right: 16 } },
  pitch: terrain3d ? 45 : 0,
  minZoom: 4,
  maxZoom: 15,
  maxPitch: 85,
  maxBounds: JAPAN_BOUNDS,
  attributionControl: false,
  // Needed later to grab frames for video export
  canvasContextAttributes: { preserveDrawingBuffer: true },
});
const surfaceSync = new SurfaceSync(map);

map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');
// No MapLibre attribution control: all required credits (with links) are in our
// own always-visible source line, which also ends up in exported videos.

// --- 2D/3D toggle + camera presets ---
const terrainBtn = document.getElementById('terrain-toggle') as HTMLButtonElement;
const syncTerrainBtn = () => {
  terrainBtn.setAttribute('aria-pressed', String(terrain3d));
  terrainBtn.classList.toggle('active', terrain3d);
};
syncTerrainBtn();
terrainBtn.addEventListener('click', () => {
  terrain3d = !terrain3d;
  store('snowmap.terrain3d', terrain3d);
  syncTerrainBtn();
  map.setTerrain(terrain3d ? { source: TERRAIN_SOURCE_ID, exaggeration: DEFAULT_EXAGGERATION } : null);
  map.easeTo({ pitch: terrain3d ? 55 : 0, bearing: terrain3d ? map.getBearing() : 0, duration: 800 });
});

const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
cameraSelect.innerHTML =
  '<option value="">Region …</option>' + CAMERA_PRESETS.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
cameraSelect.addEventListener('change', () => {
  const c = CAMERA_PRESETS.find((p) => p.id === cameraSelect.value);
  if (!c) return;
  map.flyTo({ center: c.center, zoom: c.zoom, pitch: terrain3d ? c.pitch : 0, bearing: terrain3d ? c.bearing : 0, duration: 2500, essential: true });
  cameraSelect.value = '';
});

// --- Legend + "model / refined" toggle ---
const legendSlot = document.getElementById('legend-slot')!;
const legend = new Legend(legendSlot);
const refineBtn = document.createElement('button');
refineBtn.type = 'button';
refineBtn.className = 'refine-toggle';
refineBtn.title =
  'Verfeinert: Modellschnee optisch nach Höhe, Hangneigung, Leeseite und Schneefallgrenze auf das 5–10-m-Gelände verteilt. ' +
  'Modell: das ~11-km-Modellraster, nur geglättet. Die Resort-Werte sind immer Modellwerte.';
legendSlot.appendChild(refineBtn);
const syncRefineBtn = () => {
  refineBtn.textContent = refined ? '◆ optisch verfeinert' : '◇ Modellraster';
  refineBtn.classList.toggle('active', refined);
};
syncRefineBtn();
refineBtn.addEventListener('click', () => {
  refined = !refined;
  store('snowmap.refined', refined);
  syncRefineBtn();
  renderAt(time.state);
});

const lutCache = new Map<string, { lut: ColorLut; packed: Int32Array }>();
function lutFor(mode: ViewTime['mode']) {
  const key = `${layer.id}|${mode}|${theme}`;
  let e = lutCache.get(key);
  if (!e) {
    const lut = buildLut(layer.colorStops(mode), PALETTES[theme]);
    e = { lut, packed: new Int32Array(new Uint8ClampedArray(lut.rgba).buffer) };
    lutCache.set(key, e);
  }
  return e;
}

document.getElementById('theme-toggle')!.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  saveTheme(theme);
  document.documentElement.dataset.theme = theme;
  map.setStyle(styleFor());
  renderAt(time.state); // new palette + lighting
});

const labels = new ResortLabels(map, RESORTS);
const time = new TimeController(dataset.times);
const timeline = new Timeline(document.getElementById('hud-bottom')!, time, dataset.times);
const selectLayer = (id: string) => {
  layer = layers.find((l) => l.id === id) ?? layer;
  try {
    localStorage.setItem('snowmap.layer', layer.id);
  } catch {
    /* storage unavailable */
  }
  timeline.setActiveLayer(layer.id);
  timeline.setModesEnabled(layer.supportsAccumulation);
  renderAt(time.state);
};
if (layers.length > 1) timeline.setLayers(layers.map((l) => ({ id: l.id, label: l.label })), layer.id, selectLayer);
timeline.setModesEnabled(layer.supportsAccumulation);

const readoutTime = document.getElementById('readout-time')!;
const readoutSub = document.getElementById('readout-sub')!;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const m = dataset.meta;
const STALE_MS = 24 * HOUR_MS;
document.getElementById('source-line')!.innerHTML = [
  m.synthetic
    ? `<strong title="${esc(fallbackReason ?? '')}">Synthetische Beispieldaten – keine Prognose</strong>`
    : `Wetterdaten: <a href="${esc(m.providerUrl ?? '')}" target="_blank" rel="noopener">${esc(m.provider)}</a>` +
      ` (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">${esc(m.licence ?? '')}</a>)` +
      ` · Modell ${esc(m.model)} · Lauf ${formatRun(m.runTime)}` +
      (Date.now() - m.runTime > STALE_MS ? ' · <strong>veraltet</strong>' : '') +
      ` · <span class="note" title="${esc(m.notes.join('\n'))}">interpoliert ⓘ</span>`,
  'Relief: ' +
    (terrainIndex
      ? `<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">${esc(terrainIndex.attribution)}</a> · `
      : '') +
    '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen Terrain Tiles</a>',
  'Karte: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> / <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
].join(' · ');

/**
 * Draw everything that depends on time. Pure function of `vt` (+ theme/mode) –
 * the video exporter will call this for each frame and then await `surfaceReady()`.
 */
let lastVersion = 0;
function renderAt(vt: ViewTime) {
  const ms = dataset.times[vt.startIndex] + vt.t * HOUR_MS;
  readoutTime.textContent = `${formatDate(ms)} · ${formatTime(ms)} ${DISPLAY_TZ_LABEL}`;
  const leadH = Math.round((ms - dataset.meta.runTime) / HOUR_MS);
  const start = dataset.times[vt.startIndex];
  readoutSub.textContent =
    layer.describe(vt, `${formatDay(start)} ${formatTime(start)}`) +
    ` · Prognosestunde +${leadH} h · Lauf ${formatRun(dataset.meta.runTime)}`;

  // Surface tiles (terrain light + AO + snow) for this state
  const { lut, packed } = lutFor(vt.mode);
  const ref = refined ? layer.refinementAt(vt) : null;
  lastVersion = surface.setFrame({
    refined,
    snow: layer.cellsAt(vt).slice(),
    fl: ref?.fl ? ref.fl.slice() : null,
    wx: ref ? ref.wx.slice() : null,
    wy: ref ? ref.wy.slice() : null,
    lut: packed,
    lnLo: lut.lnLo,
    lnHi: lut.lnHi,
    theme: MAP_PALETTES[theme].surface,
  });
  surfaceSync.request(lastVersion);
  legend.update(`${layer.label} · ${layer.unit(vt.mode)}`, layer.colorStops(vt.mode), lut);

  const values: Record<string, number> = {};
  for (const r of RESORTS) {
    // Prefer the exact point series; fall back to grid interpolation
    const p = layer.valueAtPoint(vt, r.id);
    values[r.id] = Number.isNaN(p) ? layer.valueAt(vt, r.lon, r.lat) : p;
  }
  labels.setValues(values, {
    format: (v) => layer.format(v, vt.mode),
    unit: layer.unit(vt.mode),
    stops: layer.colorStops(vt.mode),
  });
}

time.subscribe(renderAt);

/** Resolves when the surface tiles of the last rendered state are on screen. */
const surfaceReady = () => surfaceSync.waitForVersion(lastVersion);

// Expose for debugging and later export tooling
Object.assign(window, { snowMap: map, snowApp: { time, renderAt, surfaceReady, surface, dataset, layer, lutFor } });
