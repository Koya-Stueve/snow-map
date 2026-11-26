import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre resolves its worker relative to its own module URL, which breaks
// after Vite pre-bundling. Point it at the real worker file explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/oswald/600.css';
import './styles.css';

import { buildStyle } from './map/style';
import { loadTheme, saveTheme, type ThemeName } from './theme';
import { RESORTS } from './data/resorts';
import { SAMPLE_RESORT_VALUES } from './data/sample';
import { ResortLabels } from './ui/resortLabels';

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
  fitBoundsOptions: { padding: { top: 90, bottom: 40, left: 16, right: 16 } },
  minZoom: 4,
  maxZoom: 12,
  maxBounds: JAPAN_BOUNDS,
  attributionControl: false,
  // Needed later to grab frames for video export
  canvasContextAttributes: { preserveDrawingBuffer: true },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
// Collapsed by default (the "i" button); full credits are also in our own source line
const attribution = new maplibregl.AttributionControl({ compact: true });
map.addControl(attribution, 'bottom-right');
map.once('load', () => {
  map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
});

const labels = new ResortLabels(map, RESORTS);
labels.setValues(SAMPLE_RESORT_VALUES);

document.getElementById('theme-toggle')!.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  saveTheme(theme);
  document.documentElement.dataset.theme = theme;
  map.setStyle(buildStyle(theme));
});

document.getElementById('source-line')!.textContent =
  'Beispielwerte (keine Prognose) · Relief: Mapzen Terrain Tiles · Karte: © OpenStreetMap / OpenFreeMap';

// Expose for debugging and later export tooling
(window as unknown as { snowMap: maplibregl.Map }).snowMap = map;
