// Per-pixel surface shading: terrain light + ambient occlusion + snow, with the
// optional visual downscaling of the coarse model snow by elevation, slope,
// aspect (lee side) and the rain/snow line. Pure functions, no DOM – used by the
// surface worker and (later) by the offline video renderer.

import type { GridSpec } from '../../data/types';

export const TILE = 256;

// --- Visual downscaling parameters ("optisch verfeinert", documented in README) ---
/** +7 % snow per 100 m above the cell's mean terrain height (clamped) */
export const ELEV_GAIN_PER_M = 0.0007;
export const ELEV_FACTOR_MIN = 0.35;
export const ELEV_FACTOR_MAX = 2.5;
/** Snow line ≈ freezing level − 250 m, soft transition */
export const SNOWLINE_BELOW_FL = 250;
export const SNOWLINE_SOFT_BELOW = 200;
export const SNOWLINE_SOFT_ABOVE = 150;
/** Steep faces shed snow: full cover below 35°, bare rock from ~58° */
export const SLOPE_FULL_DEG = 35;
export const SLOPE_BARE_DEG = 58;
/** Lee slopes (facing away from the wind) collect up to +35 %, windward slopes lose as much */
export const LEE_GAIN = 0.35;

/** Lighting/colour parameters per theme */
export interface SurfaceTheme {
  terrain: [number, number, number];
  ambient: number;
  diffuse: number;
  aoStrength: number;
  snowAmbient: number;
  snowDiffuse: number;
  snowAo: number;
}

/** Static, time-independent per-pixel terrain attributes of one tile */
export interface StaticTile {
  elev: Int16Array; // metres
  slope: Uint8Array; // degrees (true, not exaggerated)
  downX: Int8Array; // downhill unit vector east ·127
  downY: Int8Array; // … north ·127
  light: Uint8Array; // n·l (exaggerated for readable relief) ·255
  ao: Uint8Array; // occlusion 0..255
  // Coarse-grid sampling positions (lon depends on column, lat on row only)
  colI: Int32Array;
  colT: Float32Array;
  rowJ: Int32Array;
  rowT: Float32Array;
}

/** Everything that changes with time/theme/mode */
export interface Frame {
  version: number;
  refined: boolean;
  snow: Float32Array; // dense grid, cm
  fl: Float32Array | null; // dense, m (freezing level)
  wx: Float32Array | null; // dense, wind "to" east
  wy: Float32Array | null; // dense, wind "to" north
  href: Float32Array | null; // dense, mean terrain height of the cell (m)
  lut: Int32Array; // 1024 packed RGBA (little endian), non-premultiplied
  lnLo: number;
  lnHi: number;
  theme: SurfaceTheme;
}

const LUT_SIZE = 1024;
const BELOW = -LUT_SIZE * 0.2;

const lonOf = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latOf = (y: number, z: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z));
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Sun from the north-west (cartographic convention, reads as "relief" to most people) */
const SUN_AZ = (315 * Math.PI) / 180;
const SUN_EL = (35 * Math.PI) / 180;
const LX = Math.cos(SUN_EL) * Math.sin(SUN_AZ);
const LY = Math.cos(SUN_EL) * Math.cos(SUN_AZ);
const LZ = Math.sin(SUN_EL);

/**
 * Derive static attributes from a 258×258 height block (tile + 1 px border from
 * neighbours, so normals match across tile edges) and an optional AO tile.
 */
export function computeStatic(
  h258: Float32Array,
  ao: Uint8Array | null,
  z: number,
  x: number,
  y: number,
  grid: GridSpec,
): StaticTile {
  const n = TILE * TILE;
  const st: StaticTile = {
    elev: new Int16Array(n),
    slope: new Uint8Array(n),
    downX: new Int8Array(n),
    downY: new Int8Array(n),
    light: new Uint8Array(n),
    ao: ao ?? new Uint8Array(n),
    colI: new Int32Array(TILE),
    colT: new Float32Array(TILE),
    rowJ: new Int32Array(TILE),
    rowT: new Float32Array(TILE),
  };
  const latMid = latOf(y + 0.5, z);
  const mpp = (40075016.686 * Math.cos((latMid * Math.PI) / 180)) / (TILE * 2 ** z);
  // Readable relief at all zooms: exaggerate shading more when zoomed out
  const exag = 1.4 + 0.35 * Math.max(0, 12 - z);
  const W = TILE + 2;
  for (let py = 0; py < TILE; py++) {
    for (let px = 0; px < TILE; px++) {
      const c = (py + 1) * W + px + 1;
      const h = Math.max(0, h258[c]);
      const dzdx = (h258[c + 1] - h258[c - 1]) / (2 * mpp); // east
      const dzdy = (h258[c - W] - h258[c + W]) / (2 * mpp); // north (row −1 is north)
      const g = Math.hypot(dzdx, dzdy);
      const i = py * TILE + px;
      st.elev[i] = Math.round(Math.min(h, 32767));
      st.slope[i] = Math.round((Math.atan(g) * 180) / Math.PI);
      if (g > 1e-6) {
        st.downX[i] = Math.round((-dzdx / g) * 127);
        st.downY[i] = Math.round((-dzdy / g) * 127);
      }
      // Lighting normal with exaggerated slopes
      const nx = -dzdx * exag;
      const ny = -dzdy * exag;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      st.light[i] = Math.round(Math.max(0, (nx * LX + ny * LY + LZ) * inv) * 255);
    }
  }
  // Coarse grid positions per column / row
  for (let p = 0; p < TILE; p++) {
    const lon = lonOf(x + (p + 0.5) / TILE, z);
    const fx = (lon - grid.lon0) / grid.dLon;
    const i0 = Math.floor(fx);
    st.colI[p] = fx < 0 || fx > grid.nx - 1 ? -1 : Math.min(i0, grid.nx - 2);
    st.colT[p] = fx - st.colI[p];
    const lat = latOf(y + (p + 0.5) / TILE, z);
    const fy = (lat - grid.lat0) / grid.dLat;
    const j0 = Math.floor(fy);
    st.rowJ[p] = fy < 0 || fy > grid.ny - 1 ? -1 : Math.min(j0, grid.ny - 2);
    st.rowT[p] = fy - st.rowJ[p];
  }
  return st;
}

/** Bilinear sample of a dense grid at precomputed (row, col) positions */
function bilin(f: Float32Array, nx: number, j: number, ty: number, i: number, tx: number): number {
  const k = j * nx + i;
  return (f[k] * (1 - tx) + f[k + 1] * tx) * (1 - ty) + (f[k + nx] * (1 - tx) + f[k + nx + 1] * tx) * ty;
}

/** Shade one tile into `out` (RGBA, 256×256). Deterministic for a given (static, frame). */
export function shadeTile(st: StaticTile, frame: Frame, grid: GridSpec, out: Uint8ClampedArray): void {
  const { theme: th, snow, refined, lut } = frame;
  const fl = refined ? frame.fl : null;
  const wx = refined ? frame.wx : null;
  const wy = refined ? frame.wy : null;
  const href = refined ? frame.href : null;
  const nx = grid.nx;
  const k = (LUT_SIZE - 1) / (frame.lnHi - frame.lnLo);
  const [tr, tg, tb] = th.terrain;

  for (let py = 0; py < TILE; py++) {
    const j = st.rowJ[py];
    const ty = st.rowT[py];
    for (let px = 0; px < TILE; px++) {
      const p = py * TILE + px;
      const nl = st.light[p] / 255;
      const ao = st.ao[p] / 255;

      // Bare terrain
      const tShade = (th.ambient + th.diffuse * nl) * (1 - th.aoStrength * ao);
      let r = tr * tShade;
      let g = tg * tShade;
      let b = tb * tShade;

      // Snow amount at this pixel
      const i = st.colI[px];
      let s = 0;
      if (i >= 0 && j >= 0) {
        const tx = st.colT[px];
        s = bilin(snow, nx, j, ty, i, tx);
        if (refined && s > 0) {
          const h = st.elev[p];
          const slope = st.slope[p];
          if (href) {
            const dz = h - bilin(href, nx, j, ty, i, tx);
            s *= Math.min(ELEV_FACTOR_MAX, Math.max(ELEV_FACTOR_MIN, 1 + ELEV_GAIN_PER_M * dz));
          }
          if (fl) {
            const line = bilin(fl, nx, j, ty, i, tx) - SNOWLINE_BELOW_FL;
            s *= smoothstep(line - SNOWLINE_SOFT_BELOW, line + SNOWLINE_SOFT_ABOVE, h);
          }
          s *= 1 - smoothstep(SLOPE_FULL_DEG, SLOPE_BARE_DEG, slope);
          if (wx && wy) {
            const vx = bilin(wx, nx, j, ty, i, tx);
            const vy = bilin(wy, nx, j, ty, i, tx);
            // downhill · wind-to > 0  ⇒ slope faces away from the wind (lee)
            const dot = (st.downX[p] * vx + st.downY[p] * vy) / 127;
            s *= 1 + LEE_GAIN * Math.max(-1, Math.min(1, dot)) * smoothstep(8, 30, slope);
          }
        }
      }

      // Snow colour + coverage from the palette LUT (log scale)
      if (s > 0) {
        let e = (Math.log(s) - frame.lnLo) * k;
        if (e < BELOW) e = BELOW;
        if (e > 0) {
          const c = lut[e >= LUT_SIZE - 1 ? LUT_SIZE - 1 : e | 0];
          const a = ((c >>> 24) & 255) / 255;
          const sShade = (th.snowAmbient + th.snowDiffuse * nl) * (1 - th.snowAo * ao);
          r += ((c & 255) * sShade - r) * a;
          g += (((c >>> 8) & 255) * sShade - g) * a;
          b += (((c >>> 16) & 255) * sShade - b) * a;
        }
      }

      const q = p * 4;
      out[q] = r;
      out[q + 1] = g;
      out[q + 2] = b;
      out[q + 3] = 255;
    }
  }
}
