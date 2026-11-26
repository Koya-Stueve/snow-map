import { CellGrid } from '../data/cellGrid';
import type { ForecastDataset } from '../data/types';
import type { ColorStop } from '../render/colorScale';
import { SNOW_STOPS } from '../render/colorScale';
import type { TimeMode, ViewTime, WeatherLayer } from './types';

// Snow depth (cm) – same palette colours, positioned for depths up to ~3 m
const DEPTH_STOPS: ColorStop[] = SNOW_STOPS.map((s, i) => ({
  value: [1, 10, 25, 50, 75, 100, 150, 250][i],
  color: s.color,
}));

/** Snow depth on the ground (Schneehöhe), an instant value – no accumulation. */
export class SnowDepthLayer implements WeatherLayer {
  id = 'snow_depth';
  label = 'Schneehöhe';
  supportsAccumulation = false;

  private cg!: CellGrid;
  private depth: Float32Array[] = [];
  private dirX: Float32Array[] = [];
  private dirY: Float32Array[] = [];
  private points = new Map<string, Float32Array>();
  private out = new Float32Array(0);
  private outKey = '';
  private ref = { wx: new Float32Array(0), wy: new Float32Array(0) };
  private refKey = '';

  static available(ds: ForecastDataset) {
    return !!ds.fields.snow_depth;
  }

  unit(_mode: TimeMode) {
    return 'cm';
  }
  colorStops(_mode: TimeMode) {
    return DEPTH_STOPS;
  }
  format(v: number) {
    return String(Math.round(v));
  }
  describe() {
    return this.label;
  }

  prepare(ds: ForecastDataset): void {
    this.cg = new CellGrid(ds.grid, ds.cells);
    this.depth = (ds.fields.snow_depth ?? []).map((f) => f.map((v) => (v > 0 ? v : 0)));
    const dir = ds.fields.wind_direction_850hPa;
    this.dirX = dir ? dir.map((d) => d.map((deg) => (Number.isFinite(deg) ? -Math.sin((deg * Math.PI) / 180) : 0))) : [];
    this.dirY = dir ? dir.map((d) => d.map((deg) => (Number.isFinite(deg) ? -Math.cos((deg * Math.PI) / 180) : 0))) : [];
    this.points.clear();
    for (const [id, p] of Object.entries(ds.points ?? {})) if (p.fields.snow_depth) this.points.set(id, p.fields.snow_depth);
    const n = ds.cells.length;
    this.out = new Float32Array(n);
    this.ref = { wx: new Float32Array(n), wy: new Float32Array(n) };
    this.outKey = this.refKey = '';
  }

  private index(vt: ViewTime) {
    const f = Math.min(vt.startIndex + vt.t, this.depth.length - 1);
    const i0 = Math.floor(f);
    return { i0, i1: Math.min(i0 + 1, this.depth.length - 1), w: f - i0 };
  }

  cellsAt(vt: ViewTime): Float32Array {
    const key = `${vt.startIndex}|${vt.t}`;
    if (key === this.outKey) return this.out;
    this.outKey = key;
    const { i0, i1, w } = this.index(vt);
    const a = this.depth[i0];
    const b = this.depth[i1];
    for (let i = 0; i < this.out.length; i++) this.out[i] = a[i] * (1 - w) + b[i] * w;
    return this.out;
  }

  valueAt(vt: ViewTime, lon: number, lat: number): number {
    return this.cg.sample(this.cellsAt(vt), lon, lat);
  }

  valueAtPoint(vt: ViewTime, pointId: string): number {
    const s = this.points.get(pointId);
    if (!s) return NaN;
    const { i0, i1, w } = this.index(vt);
    return Math.max(0, s[i0] * (1 - w) + s[i1] * w);
  }

  fieldAt(vt: ViewTime, out: Float32Array): Float32Array {
    return this.cg.scatter(this.cellsAt(vt), out);
  }

  /**
   * Downscaling inputs: current wind for lee loading. No snow line – lying snow
   * doesn't follow today's freezing level (elevation + slope still apply).
   */
  refinementAt(vt: ViewTime) {
    if (!this.dirX.length) return null;
    const key = `${vt.startIndex}|${vt.t}`;
    if (key !== this.refKey) {
      this.refKey = key;
      const { i0, i1, w } = this.index(vt);
      for (let i = 0; i < this.ref.wx.length; i++) {
        this.ref.wx[i] = this.dirX[i0][i] * (1 - w) + this.dirX[i1][i] * w;
        this.ref.wy[i] = this.dirY[i0][i] * (1 - w) + this.dirY[i1][i] * w;
      }
    }
    return { fl: null, wx: this.ref.wx, wy: this.ref.wy };
  }
}
