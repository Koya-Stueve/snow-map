import type { ForecastDataset } from '../data/types';
import type { ColorStop } from '../render/colorScale';

export type TimeMode = 'hourly' | 'accumulated';

/**
 * Everything that determines what is drawn. Rendering must be a pure function
 * of this (+ camera), so video export can step through it frame by frame.
 */
export interface ViewTime {
  /** Index into dataset.times where the selected window starts */
  startIndex: number;
  /** Window length in hours */
  rangeHours: number;
  /** Hours since window start, fractional (0..rangeHours) */
  t: number;
  mode: TimeMode;
}

/** Contract for a weather layer. Phase 2 layers (temperature, wind, …) implement the same. */
export interface WeatherLayer {
  id: string;
  label: string;
  /** Whether "accumulated over the window" makes sense (snow, precip: yes; temperature: no) */
  supportsAccumulation: boolean;
  unit(mode: TimeMode): string;
  colorStops(mode: TimeMode): ColorStop[];
  format(value: number, mode: TimeMode): string;
  /** Called once per dataset (precompute sums etc.) */
  prepare(ds: ForecastDataset): void;
  /** Value at a point for the given time state; NaN if unavailable */
  valueAt(vt: ViewTime, lon: number, lat: number): number;
  /** Value from a named point series (e.g. resort) if the dataset has one; NaN otherwise */
  valueAtPoint(vt: ViewTime, pointId: string): number;
  /** Fill `out` (grid-sized) with the full field for the given time state */
  fieldAt(vt: ViewTime, out: Float32Array): Float32Array;
}
