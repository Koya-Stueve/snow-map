import { sampleGrid } from '../data/grid';
import type { ForecastDataset, GridSpec } from '../data/types';
import { SNOW_STOPS, type ColorStop } from '../render/colorScale';
import type { TimeMode, ViewTime, WeatherLayer } from './types';

// Same colours as the accumulated scale, tuned for hourly rates (cm/h)
const RATE_STOPS: ColorStop[] = SNOW_STOPS.map((s, i) => ({
  value: [0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10][i],
  color: s.color,
}));

/** New snow (Neuschnee): hourly rate or accumulated since window start. */
export class SnowfallLayer implements WeatherLayer {
  id = 'snowfall';
  label = 'Neuschnee';
  supportsAccumulation = true;

  private grid!: GridSpec;
  private hourly: Float32Array[] = [];
  /** cum[i] = sum of hourly[0..i] – accumulation is a difference of two of these */
  private cum: Float32Array[] = [];

  unit(mode: TimeMode) {
    return mode === 'hourly' ? 'cm/h' : 'cm';
  }
  colorStops(mode: TimeMode) {
    return mode === 'hourly' ? RATE_STOPS : SNOW_STOPS;
  }
  format(v: number, mode: TimeMode) {
    if (mode === 'hourly') return v < 0.05 ? '0' : v.toFixed(1);
    return String(Math.round(v));
  }

  prepare(ds: ForecastDataset): void {
    this.grid = ds.grid;
    this.hourly = ds.fields.snowfall;
    if (!this.hourly) throw new Error('dataset has no snowfall field');
    const n = ds.grid.nx * ds.grid.ny;
    let acc = new Float32Array(n);
    this.cum = this.hourly.map((f) => {
      const next = new Float32Array(n);
      for (let i = 0; i < n; i++) next[i] = acc[i] + f[i];
      acc = next;
      return next;
    });
  }

  /** Time index (fractional) into dataset arrays, clamped */
  private index(vt: ViewTime) {
    const f = Math.min(vt.startIndex + vt.t, this.hourly.length - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, this.hourly.length - 1);
    return { i0, i1, w: f - i0 };
  }

  valueAt(vt: ViewTime, lon: number, lat: number): number {
    const { i0, i1, w } = this.index(vt);
    if (vt.mode === 'hourly') {
      // Hourly sum belongs to its valid time (end of hour); blend between timestamps
      const a = sampleGrid(this.grid, this.hourly[i0], lon, lat);
      const b = sampleGrid(this.grid, this.hourly[i1], lon, lat);
      return a * (1 - w) + b * w;
    }
    const c0 = sampleGrid(this.grid, this.cum[i0], lon, lat);
    const c1 = sampleGrid(this.grid, this.cum[i1], lon, lat);
    const base = sampleGrid(this.grid, this.cum[vt.startIndex], lon, lat);
    return Math.max(0, c0 * (1 - w) + c1 * w - base);
  }

  fieldAt(vt: ViewTime, out: Float32Array): Float32Array {
    const { i0, i1, w } = this.index(vt);
    if (vt.mode === 'hourly') {
      const a = this.hourly[i0];
      const b = this.hourly[i1];
      for (let i = 0; i < out.length; i++) out[i] = a[i] * (1 - w) + b[i] * w;
      return out;
    }
    const c0 = this.cum[i0];
    const c1 = this.cum[i1];
    const base = this.cum[vt.startIndex];
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, c0[i] * (1 - w) + c1[i] * w - base[i]);
    return out;
  }
}
