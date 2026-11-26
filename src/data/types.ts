// Common in-memory forecast format. Real data (Open-Meteo) and the synthetic
// sample data both produce this, so layers/UI don't care about the source.

/** Regular lon/lat grid. (lon0, lat0) is the centre of cell (0,0) = south-west corner. Row-major, rows go north. */
export interface GridSpec {
  lon0: number;
  lat0: number;
  dLon: number;
  dLat: number;
  nx: number;
  ny: number;
}

export interface DatasetMeta {
  /** Model name for the source line, e.g. "DWD ICON" */
  model: string;
  /** Data provider, e.g. "Open-Meteo.com" */
  provider: string;
  providerUrl?: string;
  licence?: string;
  /** Model run (initialisation) time, epoch ms UTC */
  runTime: number;
  /** True for generated sample data – UI must say so */
  synthetic: boolean;
  /** Honest notes about processing (interpolation etc.), shown on demand */
  notes: string[];
}

export interface ForecastDataset {
  meta: DatasetMeta;
  /** Hourly valid times, epoch ms UTC, ascending */
  times: number[];
  grid: GridSpec;
  /** Dense grid indices of the cells that carry data; field arrays are per stored cell */
  cells: Int32Array;
  /**
   * Per-variable, per-time values for each stored cell, in display units:
   * snowfall in cm (sum over the hour ENDING at times[i]), snow_depth in cm (instant).
   */
  fields: Record<string, Float32Array[]>;
  /**
   * Optional exact series at named points (resorts), same units and time axis
   * as `fields`. Labels prefer these over grid interpolation.
   */
  points?: Record<string, { elevation: number | null; fields: Record<string, Float32Array> }>;
}

export const HOUR_MS = 3_600_000;
