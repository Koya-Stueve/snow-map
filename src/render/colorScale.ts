// Snow color scale (cm), logarithmic stops similar to the Powderguide / snow_sure look.
// Shared by the snow raster layer, the legend and the label values so everything matches.

export interface ColorStop {
  value: number;
  color: [number, number, number];
}

export const SNOW_STOPS: ColorStop[] = [
  { value: 1, color: [64, 224, 255] },
  { value: 5, color: [46, 150, 255] },
  { value: 10, color: [104, 96, 255] },
  { value: 20, color: [170, 80, 255] },
  { value: 30, color: [226, 80, 220] },
  { value: 50, color: [255, 92, 150] },
  { value: 100, color: [255, 170, 40] },
  { value: 200, color: [255, 60, 30] },
];

/** Interpolate the scale in log space. Returns null below the first stop. */
export function snowColor(cm: number, stops: ColorStop[] = SNOW_STOPS): [number, number, number] | null {
  if (!(cm >= stops[0].value)) return null;
  const last = stops[stops.length - 1];
  if (cm >= last.value) return last.color;
  const lv = Math.log(cm);
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (cm <= b.value) {
      const a = stops[i - 1];
      const t = (lv - Math.log(a.value)) / (Math.log(b.value) - Math.log(a.value));
      return [0, 1, 2].map((k) => Math.round(a.color[k] + (b.color[k] - a.color[k]) * t)) as [number, number, number];
    }
  }
  return last.color;
}
