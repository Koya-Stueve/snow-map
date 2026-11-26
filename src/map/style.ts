import type { StyleSpecification } from 'maplibre-gl';
import { MAP_PALETTES, type ThemeName } from '../theme';

// Free, keyless sources. Attributions are rendered in our own source line
// (see src/ui/sourceLine.ts) and in MapLibre's attribution control.
export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

export const DEM_SOURCE_ID = 'dem';

export function buildStyle(theme: ThemeName): StyleSpecification {
  const p = MAP_PALETTES[theme];
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      [DEM_SOURCE_ID]: {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
        attribution:
          '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen / AWS Terrain Tiles</a>',
      },
      omt: {
        type: 'vector',
        url: OPENFREEMAP_TILEJSON,
        attribution:
          '<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.background } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: DEM_SOURCE_ID,
        paint: {
          'hillshade-shadow-color': p.hillshadeShadow,
          'hillshade-highlight-color': p.hillshadeHighlight,
          'hillshade-accent-color': p.hillshadeAccent,
          'hillshade-exaggeration': p.hillshadeExaggeration,
          'hillshade-illumination-direction': 315,
        },
      },
      // Weather rasters are inserted here (between the base relief and this shading)
      {
        id: 'snow-shade',
        type: 'hillshade',
        source: DEM_SOURCE_ID,
        paint: {
          'hillshade-shadow-color': p.snowShadeColor,
          'hillshade-highlight-color': 'rgba(255,255,255,0)',
          'hillshade-accent-color': 'rgba(0,0,0,0)',
          'hillshade-exaggeration': p.snowShadeExaggeration,
          'hillshade-illumination-direction': 315,
        },
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

/**
 * Weather rasters go between the full relief and a shadow-only hillshade: the
 * snow covers the base relief but keeps a shaded 3D texture, and the opaque
 * water layer masks values over the sea.
 */
export const WEATHER_INSERT_BEFORE = 'snow-shade';
