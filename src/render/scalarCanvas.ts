// Renders a lon/lat grid field into a canvas laid out in Web Mercator, so it can
// be placed on the map as a canvas source with 4 corner coordinates (a plain
// lon/lat image would be misplaced by up to ~0.5° in latitude over Japan).
// Sampling weights are precomputed once; per frame it's 4 taps + a LUT lookup per pixel.

import { gridBounds } from '../data/grid';
import type { GridSpec } from '../data/types';
import { LUT_SIZE, type ColorLut } from './palette';

const mercY = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
const invMercY = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
/** LUT index used for empty cells: one fade-width below the transparent end */
const BELOW = -LUT_SIZE * 0.2;

export class ScalarCanvas {
  readonly canvas: HTMLCanvasElement;
  /** Corners for a MapLibre canvas source: TL, TR, BR, BL */
  readonly coordinates: [[number, number], [number, number], [number, number], [number, number]];
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private out32: Int32Array; // 32-bit view on image pixels (one write per pixel)
  private idx: Int32Array; // grid index of the SW neighbour, per pixel
  private w: Float32Array; // 4 bilinear weights per pixel
  private nx: number;

  constructor(grid: GridSpec, upscale = 3) {
    const [west, south, east, north] = gridBounds(grid);
    this.coordinates = [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];
    this.nx = grid.nx;

    const width = grid.nx * upscale;
    const yN = mercY(north);
    const yS = mercY(south);
    const lonSpanRad = ((east - west) * Math.PI) / 180;
    const height = Math.round((width * (yN - yS)) / lonSpanRad);

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false })!;
    this.image = this.ctx.createImageData(width, height);
    this.out32 = new Int32Array(this.image.data.buffer);

    const n = width * height;
    this.idx = new Int32Array(n);
    this.w = new Float32Array(n * 4);
    for (let py = 0; py < height; py++) {
      // pixel centre → latitude (rows evenly spaced in mercator, top = north)
      const lat = invMercY(yN - ((py + 0.5) / height) * (yN - yS));
      const fy = Math.min(Math.max((lat - grid.lat0) / grid.dLat, 0), grid.ny - 1.0001);
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      for (let px = 0; px < width; px++) {
        const lon = west + ((px + 0.5) / width) * (east - west);
        const fx = Math.min(Math.max((lon - grid.lon0) / grid.dLon, 0), grid.nx - 1.0001);
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const p = py * width + px;
        this.idx[p] = y0 * grid.nx + x0;
        this.w[p * 4] = (1 - tx) * (1 - ty);
        this.w[p * 4 + 1] = tx * (1 - ty);
        this.w[p * 4 + 2] = (1 - tx) * ty;
        this.w[p * 4 + 3] = tx * ty;
      }
    }
  }

  /**
   * Colour indices are computed per grid cell in log space and then bilinearly
   * interpolated per pixel (≈10× fewer logs, smooth log-space gradients).
   * Cells at/near zero get a negative index so edges fade out instead of stepping.
   */
  draw(field: Float32Array, lut: ColorLut): void {
    const { idx, w, nx } = this;
    const k = (LUT_SIZE - 1) / (lut.lnHi - lut.lnLo);
    const cellIdx = this.cellIndex(field.length);
    for (let i = 0; i < field.length; i++) {
      const v = field[i];
      cellIdx[i] = v > 0 ? Math.max((Math.log(v) - lut.lnLo) * k, BELOW) : BELOW;
    }

    const lut32 = this.lut32(lut);
    const out = this.out32;
    const n = idx.length;
    const top = LUT_SIZE - 1;
    for (let p = 0; p < n; p++) {
      const i = idx[p];
      const q = p * 4;
      const e = w[q] * cellIdx[i] + w[q + 1] * cellIdx[i + 1] + w[q + 2] * cellIdx[i + nx] + w[q + 3] * cellIdx[i + nx + 1];
      out[p] = e <= 0 ? 0 : lut32[e >= top ? top : e | 0];
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  private _cellIdx?: Float32Array;
  private cellIndex(n: number): Float32Array {
    if (!this._cellIdx || this._cellIdx.length !== n) this._cellIdx = new Float32Array(n);
    return this._cellIdx;
  }

  private lutCache = new WeakMap<ColorLut, Int32Array>();
  private lut32(lut: ColorLut): Int32Array {
    let u = this.lutCache.get(lut);
    if (!u) {
      // Copy so the view is aligned; platform byte order matches ImageData's
      u = new Int32Array(new Uint8ClampedArray(lut.rgba).buffer);
      this.lutCache.set(lut, u);
    }
    return u;
  }
}
