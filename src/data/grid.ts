import type { GridSpec } from './types';

/** Grid bounds as cell edges: [west, south, east, north] */
export function gridBounds(grid: GridSpec): [number, number, number, number] {
  return [
    grid.lon0 - grid.dLon / 2,
    grid.lat0 - grid.dLat / 2,
    grid.lon0 + (grid.nx - 0.5) * grid.dLon,
    grid.lat0 + (grid.ny - 0.5) * grid.dLat,
  ];
}
