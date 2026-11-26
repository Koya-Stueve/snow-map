// Camera presets per region. 2D uses center/zoom; 3D additionally pitch/bearing.
// Also the starting points for video camera flights later (Phase 3).

export interface CameraPreset {
  id: string;
  label: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export const CAMERA_PRESETS: CameraPreset[] = [
  { id: 'hokkaido', label: 'Hokkaido', center: [142.6, 43.45], zoom: 6.4, pitch: 45, bearing: 0 },
  { id: 'niseko', label: 'Niseko / Yōtei', center: [140.76, 42.83], zoom: 10.6, pitch: 62, bearing: -20 },
  { id: 'daisetsu', label: 'Daisetsuzan / Furano', center: [142.6, 43.55], zoom: 9.6, pitch: 60, bearing: 15 },
  { id: 'tomamu', label: 'Tomamu', center: [142.64, 43.06], zoom: 11.6, pitch: 64, bearing: -35 },
  { id: 'tohoku', label: 'Tōhoku / Zaō', center: [140.4, 38.4], zoom: 7.6, pitch: 50, bearing: 0 },
  { id: 'nagano', label: 'Nagano / Niigata', center: [138.25, 36.8], zoom: 8.4, pitch: 55, bearing: 10 },
];
