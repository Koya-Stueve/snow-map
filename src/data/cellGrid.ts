import type { GridSpec } from './types';

/**
 * A regular grid where only some cells carry data (land + coastal buffer).
 * Values are stored per stored cell ("sparse"); this maps between the two.
 * Missing cells count as 0, which is right for snow amounts.
 */
export class CellGrid {
  /** dense index → stored cell index, or -1 */
  readonly cellOf: Int32Array;

  constructor(
    readonly grid: GridSpec,
    /** dense indices of stored cells */
    readonly cells: Int32Array,
  ) {
    this.cellOf = new Int32Array(grid.nx * grid.ny).fill(-1);
    for (let k = 0; k < cells.length; k++) this.cellOf[cells[k]] = k;
  }

  get size() {
    return this.cells.length;
  }

  /** Write per-cell values into a dense grid buffer (missing cells → 0). */
  scatter(values: ArrayLike<number>, out: Float32Array): Float32Array {
    out.fill(0);
    const { cells } = this;
    for (let k = 0; k < cells.length; k++) out[cells[k]] = values[k];
    return out;
  }

  private at(values: ArrayLike<number>, dense: number): number {
    const k = this.cellOf[dense];
    return k < 0 ? 0 : values[k];
  }

  /** Bilinear sample at lon/lat; NaN outside the grid. */
  sample(values: ArrayLike<number>, lon: number, lat: number): number {
    const g = this.grid;
    const fx = (lon - g.lon0) / g.dLon;
    const fy = (lat - g.lat0) / g.dLat;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return NaN;
    const x0 = Math.min(Math.floor(fx), g.nx - 2);
    const y0 = Math.min(Math.floor(fy), g.ny - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const i = y0 * g.nx + x0;
    const a = this.at(values, i);
    const b = this.at(values, i + 1);
    const c = this.at(values, i + g.nx);
    const d = this.at(values, i + g.nx + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /** Grid with every cell stored (e.g. synthetic data). */
  static dense(grid: GridSpec): CellGrid {
    return new CellGrid(grid, Int32Array.from({ length: grid.nx * grid.ny }, (_, i) => i));
  }
}
