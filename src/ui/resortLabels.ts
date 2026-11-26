import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Resort } from '../data/resorts';
import { layoutLabels, type LabelInput } from '../render/labelLayout';
import { snowColorCss } from '../render/colorScale';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * DOM overlay with resort labels ("NISEKO  141 cm") and leader lines.
 * Values are pushed in via setValues(); the overlay re-projects on every map render.
 */
export class ResortLabels {
  private root: HTMLDivElement;
  private svg: SVGSVGElement;
  private items = new Map<string, { box: HTMLDivElement; value: HTMLSpanElement; line: SVGLineElement; dot: SVGCircleElement }>();
  private frame = 0;

  constructor(
    private map: MapLibreMap,
    private resorts: Resort[],
  ) {
    this.root = document.createElement('div');
    this.root.className = 'resort-labels';
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('resort-lines');
    this.root.appendChild(this.svg);

    for (const r of resorts) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.classList.add('resort-leader');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.classList.add('resort-dot');
      dot.setAttribute('r', '5');
      this.svg.append(line, dot);

      const box = document.createElement('div');
      box.className = 'resort-box';
      const name = document.createElement('span');
      name.className = 'resort-name';
      name.textContent = r.name;
      const value = document.createElement('span');
      value.className = 'resort-value';
      box.append(name, value);
      this.root.appendChild(box);
      this.items.set(r.id, { box, value, line, dot });
    }

    map.getContainer().appendChild(this.root);
    map.on('render', () => this.schedule());
    window.addEventListener('resize', () => this.schedule());
    this.setValues({});
  }

  /** cm per resort id; missing/null renders as "–" */
  setValues(values: Record<string, number | null | undefined>): void {
    for (const r of this.resorts) {
      const el = this.items.get(r.id)!.value;
      const v = values[r.id];
      if (v == null || Number.isNaN(v)) {
        el.innerHTML = '–';
        el.style.color = '';
      } else {
        el.innerHTML = `${Math.round(v)}<small> cm</small>`;
        el.style.color = snowColorCss(v);
      }
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  private update(): void {
    const { clientWidth: width, clientHeight: height } = this.map.getContainer();
    const inputs: LabelInput[] = this.resorts.map((r) => {
      const p = this.map.project([r.lon, r.lat]);
      const { box } = this.items.get(r.id)!;
      return {
        id: r.id,
        x: p.x,
        y: p.y,
        dx: r.label.dx,
        dy: r.label.dy,
        boxWidth: box.offsetWidth,
        boxHeight: box.offsetHeight,
      };
    });

    for (const g of layoutLabels(inputs, { width, height })) {
      const it = this.items.get(g.id)!;
      const display = g.visible ? '' : 'none';
      it.box.style.display = display;
      it.line.style.display = display;
      it.dot.style.display = display;
      if (!g.visible) continue;
      it.box.style.transform = `translate(${g.box.x}px, ${g.box.y}px)`;
      it.line.setAttribute('x1', String(g.leader.x1));
      it.line.setAttribute('y1', String(g.leader.y1));
      it.line.setAttribute('x2', String(g.leader.x2));
      it.line.setAttribute('y2', String(g.leader.y2));
      it.dot.setAttribute('cx', String(g.point.x));
      it.dot.setAttribute('cy', String(g.point.y));
    }
  }
}
