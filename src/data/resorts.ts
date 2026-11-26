// Selected ski resorts. Coordinates are approximate mid-mountain points.
// `label` = preferred offset (CSS px) of the label box from the point, chosen by
// hand so neighbouring resorts don't collide (like the leader-line labels in Inspo).

export interface Resort {
  id: string;
  name: string;
  region: 'hokkaido' | 'tohoku' | 'nagano-niigata';
  lon: number;
  lat: number;
  /** Approx. base / top elevation in m (used later for elevation-aware values) */
  baseM: number;
  topM: number;
  label: { dx: number; dy: number };
}

export const RESORTS: Resort[] = [
  // Hokkaido
  { id: 'niseko', name: 'Niseko', region: 'hokkaido', lon: 140.687, lat: 42.862, baseM: 260, topM: 1200, label: { dx: -36, dy: -34 } },
  { id: 'rusutsu', name: 'Rusutsu', region: 'hokkaido', lon: 140.897, lat: 42.748, baseM: 400, topM: 994, label: { dx: 34, dy: 30 } },
  { id: 'kamui', name: 'Kamui', region: 'hokkaido', lon: 142.214, lat: 43.786, baseM: 160, topM: 750, label: { dx: -36, dy: -30 } },
  { id: 'asahidake', name: 'Asahidake', region: 'hokkaido', lon: 142.827, lat: 43.656, baseM: 1100, topM: 1600, label: { dx: 36, dy: -26 } },
  { id: 'furano', name: 'Furano', region: 'hokkaido', lon: 142.343, lat: 43.322, baseM: 245, topM: 1209, label: { dx: -36, dy: 30 } },
  // Tohoku
  { id: 'zao', name: 'Zao', region: 'tohoku', lon: 140.405, lat: 38.168, baseM: 780, topM: 1661, label: { dx: 36, dy: 0 } },
  // Nagano / Niigata
  { id: 'hakuba', name: 'Hakuba', region: 'nagano-niigata', lon: 137.830, lat: 36.700, baseM: 760, topM: 1831, label: { dx: -36, dy: 10 } },
  { id: 'myoko', name: 'Myoko', region: 'nagano-niigata', lon: 138.177, lat: 36.885, baseM: 750, topM: 1855, label: { dx: -36, dy: -34 } },
  { id: 'nozawa', name: 'Nozawa Onsen', region: 'nagano-niigata', lon: 138.630, lat: 36.922, baseM: 565, topM: 1650, label: { dx: 36, dy: -30 } },
  { id: 'shiga', name: 'Shiga Kogen', region: 'nagano-niigata', lon: 138.513, lat: 36.733, baseM: 1340, topM: 2307, label: { dx: 36, dy: 30 } },
];
