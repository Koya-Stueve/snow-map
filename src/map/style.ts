import type { StyleSpecification } from 'maplibre-gl';
import { MAP_PALETTES, type ThemeName } from '../theme';
import { DEM_TILES } from './terrainSource';
import { SURFACE_LAYER_ID, SURFACE_SOURCE_ID, surfaceTiles } from '../render/surface/surfaceSource';

// Free, keyless sources. Attributions are shown in our own source line (main.ts).
export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

/** DEM source for the 3D terrain mesh (the surface shader loads DEM tiles itself) */
export const TERRAIN_SOURCE_ID = 'dem-terrain';
export const DEFAULT_EXAGGERATION = 1.4;

export interface StyleOptions {
  /** 3D terrain on/off */
  terrain: boolean;
  exaggeration?: number;
}

export function buildStyle(theme: ThemeName, opts: StyleOptions = { terrain: false }): StyleSpecification {
  const p = MAP_PALETTES[theme];
  return {
    version: 8,
    glyphs: GLYPHS,
    ...(opts.terrain
      ? { terrain: { source: TERRAIN_SOURCE_ID, exaggeration: opts.exaggeration ?? DEFAULT_EXAGGERATION } }
      : {}),
    sky: {
      'sky-color': p.sky.sky,
      'horizon-color': p.sky.horizon,
      'fog-color': p.sky.fog,
      // Aerial perspective: distant terrain fades into the fog colour, horizon blends softly into the sky
      'sky-horizon-blend': 0.7,
      'horizon-fog-blend': 0.85,
      'fog-ground-blend': 0.45,
      'atmosphere-blend': 0,
    },
    sources: {
      [TERRAIN_SOURCE_ID]: {
        type: 'raster-dem',
        tiles: [DEM_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      },
      // Terrain light + AO + snow, rendered per tile by the surface workers (version in the URL)
      [SURFACE_SOURCE_ID]: {
        type: 'raster',
        tiles: [surfaceTiles(0)],
        tileSize: 256,
        maxzoom: 14,
      },
      omt: {
        type: 'vector',
        url: OPENFREEMAP_TILEJSON, // credits are in our own source line (main.ts)
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.background } },
      {
        id: SURFACE_LAYER_ID,
        type: 'raster',
        source: SURFACE_SOURCE_ID,
        paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'omt',
        'source-layer': 'water',
        paint: { 'fill-color': p.water },
      },
      {
        id: 'boundary',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: [
          'all',
          ['<=', ['get', 'admin_level'], 4],
          ['!=', ['get', 'maritime'], 1],
          ['!=', ['get', 'disputed'], 1],
        ],
        paint: {
          'line-color': p.boundary,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 9, 1],
          'line-dasharray': [3, 2],
        },
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        minzoom: 6,
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.15,
        },
        paint: {
          'text-color': p.placeLabel,
          'text-halo-color': p.placeHalo,
          'text-halo-width': 1.2,
        },
      },
    ],
  };
}
