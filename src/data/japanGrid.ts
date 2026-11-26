import type { GridSpec } from './types';

/**
 * The analysis grid for Japan (0.1° ≈ ICON Global's native resolution).
 * Shared by the fetch script, the synthetic data and the renderer.
 */
export const JAPAN_GRID: GridSpec = { lon0: 128, lat0: 30, dLon: 0.1, dLat: 0.1, nx: 181, ny: 171 };

/**
 * Areas we fetch data for: [west, south, east, north]. Only land cells inside
 * these boxes (+ a one-cell sea buffer) are requested, which keeps API usage low
 * and leaves out Korea / Sakhalin.
 */
export const FETCH_REGIONS: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Hokkaido', bbox: [139.3, 41.3, 145.9, 45.6] },
  { name: 'Tohoku', bbox: [139.0, 37.6, 142.2, 41.6] },
  { name: 'Kanto/Chubu/Kansai', bbox: [135.3, 34.4, 141.0, 38.1] },
  { name: 'West Japan', bbox: [129.5, 31.0, 135.6, 35.8] },
];
