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
    this.prepareRefinement(ds);

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

  // --- Inputs for the visual downscaling (snow shader) -----------------------
  // Running sums weighted by hourly snowfall, so "effective" freezing level and
  // wind over any window are a difference of two arrays (like the snow sums).
  private refine: null | {
    fl: Float32Array[]; // raw freezing level per hour (m)
    wx: Float32Array[]; // wind "to" unit vector east, per hour
    wy: Float32Array[]; // … north
    cumS: Float32Array[]; // Σ snowfall
    cumFl: Float32Array[]; // Σ snowfall · freezing level
    cumWx: Float32Array[]; // Σ snowfall · wx
    cumWy: Float32Array[];
  } = null;
  private refineOut = { fl: new Float32Array(0), wx: new Float32Array(0), wy: new Float32Array(0) };
  private refineKey = '';

  private prepareRefinement(ds: ForecastDataset) {
    const fl = ds.fields.freezing_level_height;
    const dir = ds.fields.wind_direction_850hPa;
    if (!fl || !dir) {
      this.refine = null;
      return;
    }
    const n = ds.cells.length;
    const wx = dir.map((d) => d.map((deg) => (Number.isFinite(deg) ? -Math.sin((deg * Math.PI) / 180) : 0)));
    const wy = dir.map((d) => d.map((deg) => (Number.isFinite(deg) ? -Math.cos((deg * Math.PI) / 180) : 0)));
    const cum = (val: (t: number, i: number) => number) => {
      let acc = new Float32Array(n);
      return this.hourly.map((s, t) => {
        const next = new Float32Array(n);
        for (let i = 0; i < n; i++) next[i] = acc[i] + s[i] * val(t, i);
        acc = next;
        return next;
      });
    };
    this.refine = {
      fl,
      wx,
      wy,
      cumS: this.cum,
      cumFl: cum((t, i) => (Number.isFinite(fl[t][i]) ? fl[t][i] : 0)),
      cumWx: cum((t, i) => wx[t][i]),
      cumWy: cum((t, i) => wy[t][i]),
    };
    this.refineOut = { fl: new Float32Array(n), wx: new Float32Array(n), wy: new Float32Array(n) };
    this.refineKey = '';
  }

  /**
   * Per-cell freezing level (m) and wind "to" vector for the visual downscaling.
   * Accumulated mode: snowfall-weighted means over the window (falls back to the
   * current hour where no snow fell). Hourly mode: values at the current time.
   * null if the dataset has no such fields (e.g. synthetic data).
   */
  refinementAt(vt: ViewTime): { fl: Float32Array; wx: Float32Array; wy: Float32Array } | null {
    const r = this.refine;
    if (!r) return null;
    const key = `${vt.startIndex}|${vt.t}|${vt.mode}`;
    if (key === this.refineKey) return this.refineOut;
    this.refineKey = key;
    const { i0, i1, w } = this.index(vt);
    const out = this.refineOut;
    const lerp = (a: Float32Array, b: Float32Array, i: number) => a[i] * (1 - w) + b[i] * w;
    const s0 = vt.startIndex;
    for (let i = 0; i < out.fl.length; i++) {
      const flNow = lerp(r.fl[i0], r.fl[i1], i);
      const wxNow = lerp(r.wx[i0], r.wx[i1], i);
      const wyNow = lerp(r.wy[i0], r.wy[i1], i);
      const S = vt.mode === 'accumulated' ? lerp(r.cumS[i0], r.cumS[i1], i) - r.cumS[s0][i] : 0;
      if (S > 0.05) {
        out.fl[i] = (lerp(r.cumFl[i0], r.cumFl[i1], i) - r.cumFl[s0][i]) / S;
        out.wx[i] = (lerp(r.cumWx[i0], r.cumWx[i1], i) - r.cumWx[s0][i]) / S;
        out.wy[i] = (lerp(r.cumWy[i0], r.cumWy[i1], i) - r.cumWy[s0][i]) / S;
      } else {
        out.fl[i] = Number.isFinite(flNow) ? flNow : 9999;
        out.wx[i] = wxNow;
        out.wy[i] = wyNow;
      }
    }
    return out;
  }

  /** Per-cell snow values for the current state (same values the map shows) */
  cellsAt(vt: ViewTime): Float32Array {
    return this.cellValues(vt);
  }

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
