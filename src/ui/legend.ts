import type { ColorStop } from '../render/colorScale';
import { LUT_SIZE, type ColorLut } from '../render/palette';

/** Horizontal log-scale colour bar with tick labels, drawn from the same LUT as the map. */
export class Legend {
  private el: HTMLDivElement;
  private title: HTMLDivElement;
  private bar: HTMLCanvasElement;
  private ticks: HTMLDivElement;
  private key = '';

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'legend';
    this.el.innerHTML = '<div class="legend-title"></div><canvas class="legend-bar" width="256" height="1"></canvas><div class="legend-ticks"></div>';
    this.title = this.el.querySelector('.legend-title')!;
    this.bar = this.el.querySelector('.legend-bar')!;
    this.ticks = this.el.querySelector('.legend-ticks')!;
    container.appendChild(this.el);
  }

  update(title: string, stops: ColorStop[], lut: ColorLut) {
    // Cheap change detection: title, stop values and a few LUT samples
    const key = `${title}|${stops.map((s) => s.value).join(',')}|${lut.rgba[LUT_SIZE]},${lut.rgba[LUT_SIZE * 2]},${lut.rgba[LUT_SIZE * 3]}`;
    if (key === this.key) return;
    this.key = key;
    this.title.textContent = title;

    // Bar covers [first stop … last stop] in log space
    const ctx = this.bar.getContext('2d')!;
    const img = ctx.createImageData(this.bar.width, 1);
    const lnA = Math.log(stops[0].value);
    const lnB = Math.log(stops[stops.length - 1].value);
    for (let x = 0; x < this.bar.width; x++) {
      const lv = lnA + ((lnB - lnA) * x) / (this.bar.width - 1);
      const e = Math.min(LUT_SIZE - 1, Math.round(((lv - lut.lnLo) / (lut.lnHi - lut.lnLo)) * (LUT_SIZE - 1))) * 4;
      img.data.set([lut.rgba[e], lut.rgba[e + 1], lut.rgba[e + 2], Math.max(lut.rgba[e + 3], 200)], x * 4);
    }
    ctx.putImageData(img, 0, 0);

    // Skip ticks that would crowd their neighbour (always keep first + last)
    this.ticks.innerHTML = '';
    const MIN_GAP = 0.1;
    const pos = stops.map((s) => (Math.log(s.value) - lnA) / (lnB - lnA));
    let last = -1;
    stops.forEach((s, i) => {
      const isLast = i === stops.length - 1;
      if (i > 0 && !isLast && (pos[i] - last < MIN_GAP || 1 - pos[i] < MIN_GAP)) return;
      const t = document.createElement('span');
      t.style.left = `${pos[i] * 100}%`;
      t.textContent = String(s.value).replace('.', ',');
      this.ticks.appendChild(t);
      last = pos[i];
    });
  }
}
