// Central design tokens for both themes. Map style and UI read from here,
// so the video export (Phase 3) can reuse the exact same values.

export type ThemeName = 'dark' | 'light';

export interface MapPalette {
  background: string;
  water: string;
  boundary: string;
  placeLabel: string;
  placeHalo: string;
  hillshadeShadow: string;
  hillshadeHighlight: string;
  hillshadeAccent: string;
  hillshadeExaggeration: number;
  /** Shadow-only hillshade drawn over the weather layer, so snow keeps its relief texture */
  snowShadeColor: string;
  snowShadeExaggeration: number;
  /** Strength of the precomputed ambient-occlusion layer */
  aoOpacity: number;
  /** Sky + distance fog for tilted 3D views */
  sky: { sky: string; horizon: string; fog: string };
}

export const MAP_PALETTES: Record<ThemeName, MapPalette> = {
  // Inspired by the navy relief + white snow look (Inspo videos)
  dark: {
    background: '#1b2744',
    water: '#070c19',
    boundary: '#4a5d86',
    placeLabel: '#8f9ec2',
    placeHalo: '#070c19',
    hillshadeShadow: '#03060d',
    hillshadeHighlight: '#7d93c4',
    hillshadeAccent: '#101a33',
    hillshadeExaggeration: 0.9,
    snowShadeColor: '#0b1430',
    snowShadeExaggeration: 0.55,
    aoOpacity: 0.85,
    sky: { sky: '#050914', horizon: '#22345c', fog: '#0c1529' },
  },
  // Inspired by the light grey relief + colored snow look (Inspo images)
  light: {
    background: '#eef1f4',
    water: '#c9dbe6',
    boundary: '#9aa6b2',
    placeLabel: '#5b6672',
    placeHalo: '#eef1f4',
    hillshadeShadow: '#7d8792',
    hillshadeHighlight: '#ffffff',
    hillshadeAccent: '#a9b2bc',
    hillshadeExaggeration: 0.6,
    snowShadeColor: '#5a6470',
    snowShadeExaggeration: 0.4,
    aoOpacity: 0.6,
    sky: { sky: '#9ec3e6', horizon: '#eef3f7', fog: '#e6ecf1' },
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
