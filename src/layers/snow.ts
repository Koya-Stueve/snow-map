import { CellGrid } from '../data/cellGrid';
import type { ForecastDataset } from '../data/types';
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

  private cg!: CellGrid;
  private hourly: Float32Array[] = [];
  /** cum[i] = sum of hourly[0..i] per cell – accumulation is a difference of two of these */
  private cum: Float32Array[] = [];
  private scratch = new Float32Array(0);

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
    const hourly = ds.fields.snowfall;
    if (!hourly) throw new Error('dataset has no snowfall field');
    this.cg = new CellGrid(ds.grid, ds.cells);
    const n = ds.cells.length;
    // Missing values (NaN) count as no snow
    this.hourly = hourly.map((f) => f.map((v) => (v > 0 ? v : 0)));
    let acc = new Float32Array(n);
    this.cum = this.hourly.map((f) => {
      const next = new Float32Array(n);
      for (let i = 0; i < n; i++) next[i] = acc[i] + f[i];
      acc = next;
      return next;
    });
    this.scratch = new Float32Array(n);
    this.scratchKey = '';

    // Point series (resorts): hourly per time + running sum
    this.points.clear();
    for (const [id, p] of Object.entries(ds.points ?? {})) {
      const s = p.fields.snowfall;
      if (!s) continue;
      const hourlyP = s.map((v) => (v > 0 ? v : 0));
      const cumP = new Float32Array(hourlyP.length);
      let acc = 0;
      for (let i = 0; i < hourlyP.length; i++) cumP[i] = acc += hourlyP[i];
      this.points.set(id, { hourly: hourlyP, cum: cumP });
    }
  }

  private points = new Map<string, { hourly: Float32Array; cum: Float32Array }>();

  valueAtPoint(vt: ViewTime, pointId: string): number {
    const p = this.points.get(pointId);
    if (!p) return NaN;
    const { i0, i1, w } = this.index(vt);
    if (vt.mode === 'hourly') return p.hourly[i0] * (1 - w) + p.hourly[i1] * w;
    return Math.max(0, p.cum[i0] * (1 - w) + p.cum[i1] * w - p.cum[vt.startIndex]);
  }

  /** Time index (fractional) into dataset arrays, clamped */
  private index(vt: ViewTime) {
    const f = Math.min(vt.startIndex + vt.t, this.hourly.length - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, this.hourly.length - 1);
    return { i0, i1, w: f - i0 };
  }

  private scratchKey = '';

  /** Per-cell values for the given time state (memoised in `scratch` for the last state) */
  private cellValues(vt: ViewTime): Float32Array {
    const key = `${vt.startIndex}|${vt.t}|${vt.mode}`;
    if (key === this.scratchKey) return this.scratch;
    this.scratchKey = key;
    const out = this.scratch;
    const { i0, i1, w } = this.index(vt);
    if (vt.mode === 'hourly') {
      // Hourly sum belongs to its valid time (end of hour); blend between timestamps
      const a = this.hourly[i0];
      const b = this.hourly[i1];
      for (let i = 0; i < out.length; i++) out[i] = a[i] * (1 - w) + b[i] * w;
    } else {
      const c0 = this.cum[i0];
      const c1 = this.cum[i1];
      const base = this.cum[vt.startIndex];
      for (let i = 0; i < out.length; i++) out[i] = Math.max(0, c0[i] * (1 - w) + c1[i] * w - base[i]);
    }
    return out;
  }

  valueAt(vt: ViewTime, lon: number, lat: number): number {
    return this.cg.sample(this.cellValues(vt), lon, lat);
  }

  fieldAt(vt: ViewTime, out: Float32Array): Float32Array {
    return this.cg.scatter(this.cellValues(vt), out);
  }
}
