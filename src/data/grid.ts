import type { GridSpec } from './types';

/** Bilinear sample of a grid field at lon/lat. Returns NaN outside the grid. */
export function sampleGrid(grid: GridSpec, field: ArrayLike<number>, lon: number, lat: number): number {
  const fx = (lon - grid.lon0) / grid.dLon;
  const fy = (lat - grid.lat0) / grid.dLat;
  if (fx < 0 || fy < 0 || fx > grid.nx - 1 || fy > grid.ny - 1) return NaN;
  const x0 = Math.min(Math.floor(fx), grid.nx - 2);
  const y0 = Math.min(Math.floor(fy), grid.ny - 2);
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * grid.nx + x0;
  const a = field[i];
  const b = field[i + 1];
  const c = field[i + grid.nx];
  const d = field[i + grid.nx + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Grid bounds as cell edges: [west, south, east, north] */
export function gridBounds(grid: GridSpec): [number, number, number, number] {
  return [
    grid.lon0 - grid.dLon / 2,
    grid.lat0 - grid.dLat / 2,
    grid.lon0 + (grid.nx - 0.5) * grid.dLon,
    grid.lat0 + (grid.ny - 0.5) * grid.dLat,
  ];
}
