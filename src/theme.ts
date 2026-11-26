// Central design tokens for both themes. Map style, surface shader and UI read
// from here, so the video export (Phase 3) can reuse the exact same values.

import type { SurfaceTheme } from './render/surface/shading';

export type ThemeName = 'dark' | 'light';

export interface MapPalette {
  background: string;
  water: string;
  boundary: string;
  placeLabel: string;
  placeHalo: string;
  /** Terrain + snow lighting for the surface shader */
  surface: SurfaceTheme;
  /** Sky + distance fog for tilted 3D views */
  sky: { sky: string; horizon: string; fog: string };
  /** Column view: colour at the ground → mid height → top of tall columns (rgb 0..1) */
  columns: { low: [number, number, number]; mid: [number, number, number]; high: [number, number, number] };
}

export const MAP_PALETTES: Record<ThemeName, MapPalette> = {
  // Navy relief + white snow (Inspo videos)
  dark: {
    background: '#1b2744',
    water: '#070c19',
    boundary: '#4a5d86',
    placeLabel: '#8f9ec2',
    placeHalo: '#070c19',
    surface: {
      terrain: [38, 54, 92],
      ambient: 0.32,
      diffuse: 1.25,
      aoStrength: 0.85,
      snowAmbient: 0.5,
      snowDiffuse: 0.85,
      snowAo: 0.55,
    },
    sky: { sky: '#050914', horizon: '#22345c', fog: '#0c1529' },
    // dark blue melting into the navy relief → white → pink (Inspo clip 09-24-24)
    columns: { low: [0.1, 0.15, 0.3], mid: [0.93, 0.96, 1], high: [1, 0.36, 0.65] },
  },
  // Light grey relief + colourful snow scale (Inspo images)
  light: {
    background: '#eef1f4',
    water: '#c9dbe6',
    boundary: '#9aa6b2',
    placeLabel: '#5b6672',
    placeHalo: '#eef1f4',
    surface: {
      terrain: [214, 219, 225],
      ambient: 0.55,
      diffuse: 0.85,
      aoStrength: 0.6,
      snowAmbient: 0.62,
      snowDiffuse: 0.72,
      snowAo: 0.45,
    },
    sky: { sky: '#9ec3e6', horizon: '#eef3f7', fog: '#e6ecf1' },
    columns: { low: [0.45, 0.58, 0.78], mid: [0.97, 0.98, 1], high: [1, 0.3, 0.6] },
  },
};

const STORAGE_KEY = 'snowmap.theme';

export function loadTheme(): ThemeName {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

export function saveTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable */
  }
}
