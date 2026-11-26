// Map palettes: colour + alpha per stop. A palette is positioned on the value
// stops of the active layer/mode (e.g. 1…200 cm or 0.1…10 cm/h), so the same
// palette works for accumulated and hourly values.

import type { ColorStop } from './colorScale';
import type { ThemeName } from '../theme';

export interface PaletteStop {
  color: [number, number, number];
  alpha: number;
}

/** Colourful scale (Powderguide / snow_sure look) – light theme */
const VIVID: PaletteStop[] = [
  { color: [64, 224, 255], alpha: 0.75 },
  { color: [46, 150, 255], alpha: 0.85 },
  { color: [104, 96, 255], alpha: 0.88 },
  { color: [170, 80, 255], alpha: 0.9 },
  { color: [226, 80, 220], alpha: 0.9 },
  { color: [255, 92, 150], alpha: 0.92 },
  { color: [255, 170, 40], alpha: 0.95 },
  { color: [255, 60, 30], alpha: 0.95 },
];

/** Ice → white (dark Inspo videos: "white where snow is, brighter = more") – dark theme */
// Reaches near-white by ~20 cm (or the equivalent hourly stop) so fresh snow reads as snow
const ICE: PaletteStop[] = [
  { color: [95, 130, 195], alpha: 0.5 },
  { color: [155, 185, 235], alpha: 0.75 },
  { color: [200, 220, 250], alpha: 0.88 },
  { color: [232, 241, 255], alpha: 0.96 },
  { color: [244, 248, 255], alpha: 1 },
  { color: [250, 252, 255], alpha: 1 },
  { color: [255, 255, 255], alpha: 1 },
  { color: [255, 255, 255], alpha: 1 },
];

export const PALETTES: Record<ThemeName, PaletteStop[]> = { dark: ICE, light: VIVID };

export const LUT_SIZE = 1024;

/**
 * Colour lookup table over log(value). Below the first stop the colour fades out
 * (transparent at first/4) so thin amounts don't show hard edges.
 */
export interface ColorLut {
  rgba: Uint8ClampedArray; // LUT_SIZE * 4, non-premultiplied
  lnLo: number; // ln(value) of entry 0 (fully transparent)
  lnHi: number; // ln(value) of the last entry
}

export function buildLut(stops: ColorStop[], palette: PaletteStop[]): ColorLut {
  if (stops.length !== palette.length) throw new Error('palette/stop count mismatch');
  const lnStops = stops.map((s) => Math.log(s.value));
  const lnLo = lnStops[0] - Math.log(4);
  const lnHi = lnStops[lnStops.length - 1];
  const rgba = new Uint8ClampedArray(LUT_SIZE * 4);
  for (let k = 0; k < LUT_SIZE; k++) {
    const lv = lnLo + ((lnHi - lnLo) * k) / (LUT_SIZE - 1);
    let c: [number, number, number];
    let a: number;
    if (lv <= lnStops[0]) {
      const t = (lv - lnLo) / (lnStops[0] - lnLo);
      c = palette[0].color;
      a = palette[0].alpha * t * t * (3 - 2 * t); // smoothstep fade-in
    } else {
      let i = 1;
      while (i < lnStops.length - 1 && lv > lnStops[i]) i++;
      const t = Math.min(1, (lv - lnStops[i - 1]) / (lnStops[i] - lnStops[i - 1]));
      const p = palette[i - 1];
      const q = palette[i];
      c = [0, 1, 2].map((j) => p.color[j] + (q.color[j] - p.color[j]) * t) as [number, number, number];
      a = p.alpha + (q.alpha - p.alpha) * t;
    }
    rgba.set([c[0], c[1], c[2], Math.round(a * 255)], k * 4);
  }
  return { rgba, lnLo, lnHi };
}
