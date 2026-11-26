// Common in-memory forecast format. Real data (Open-Meteo, step 5) and the
// synthetic sample data both produce this, so layers/UI don't care about the source.

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
  /** Human readable, shown in the source line, e.g. "Open-Meteo · JMA MSM" */
  source: string;
  model: string;
  /** Model run (initialisation) time, epoch ms UTC */
  runTime: number;
  /** True for generated sample data – UI must say so */
  synthetic: boolean;
}

export interface ForecastDataset {
  meta: DatasetMeta;
  /** Hourly valid times, epoch ms UTC, ascending */
  times: number[];
  grid: GridSpec;
  /**
   * Per-variable, per-time fields. Convention for sums (snowfall, precipitation):
   * value at index i = amount during the hour ENDING at times[i] (Open-Meteo convention).
   */
  fields: Record<string, Float32Array[]>;
}

export const HOUR_MS = 3_600_000;
