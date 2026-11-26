// Pure label geometry: given projected points, compute where dot, box and leader
// line go. Renderer-agnostic so the DOM overlay (now) and a canvas renderer
// (video export, Phase 3) produce identical layouts. Deterministic: same input,
// same output (labels are placed greedily in input order = priority).

export interface LabelInput {
  id: string;
  x: number; // projected point, CSS px
  y: number;
  dx: number; // preferred box offset
  dy: number;
  boxWidth: number; // measured box size
  boxHeight: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LabelGeometry {
  id: string;
  point: { x: number; y: number };
  box: Rect; // top-left + size
  leader: Segment;
  visible: boolean;
}

export interface LayoutOptions {
  /** Keep boxes this far from the viewport edges */
  edgePadding?: number;
  /** Minimum gap between boxes */
  gap?: number;
}

const rectsOverlap = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function segmentsIntersect(s: Segment, t: Segment): boolean {
  const d1 = cross(t.x1, t.y1, t.x2, t.y2, s.x1, s.y1);
  const d2 = cross(t.x1, t.y1, t.x2, t.y2, s.x2, s.y2);
  const d3 = cross(s.x1, s.y1, s.x2, s.y2, t.x1, t.y1);
  const d4 = cross(s.x1, s.y1, s.x2, s.y2, t.x2, t.y2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segmentHitsRect(s: Segment, r: Rect): boolean {
  const inside = (x: number, y: number) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
  if (inside(s.x1, s.y1) || inside(s.x2, s.y2)) return true;
  const edges: Segment[] = [
    { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y },
    { x1: r.x + r.w, y1: r.y, x2: r.x + r.w, y2: r.y + r.h },
    { x1: r.x, y1: r.y + r.h, x2: r.x + r.w, y2: r.y + r.h },
    { x1: r.x, y1: r.y, x2: r.x, y2: r.y + r.h },
  ];
  return edges.some((e) => segmentsIntersect(s, e));
}

function place(l: LabelInput, dx: number, dy: number): { box: Rect; leader: Segment } {
  const toRight = dx >= 0;
  const box: Rect = {
    x: toRight ? l.x + dx : l.x + dx - l.boxWidth,
    y: l.y + dy - l.boxHeight / 2,
    w: l.boxWidth,
    h: l.boxHeight,
  };
  const leader = { x1: l.x, y1: l.y, x2: toRight ? box.x : box.x + box.w, y2: box.y + box.h / 2 };
  return { box, leader };
}

export function layoutLabels(
  inputs: LabelInput[],
  viewport: { width: number; height: number },
  opts: LayoutOptions = {},
): LabelGeometry[] {
  const pad = opts.edgePadding ?? 8;
  const gap = opts.gap ?? 4;
  const placedBoxes: Rect[] = [];
  const placedLeaders: Segment[] = [];
  const points = inputs.filter(isInView).map((l) => ({ x: l.x, y: l.y }));

  function isInView(l: LabelInput) {
    return l.x >= 0 && l.y >= 0 && l.x <= viewport.width && l.y <= viewport.height;
  }

  const inViewport = (r: Rect) =>
    r.x >= pad && r.y >= pad && r.x + r.w <= viewport.width - pad && r.y + r.h <= viewport.height - pad;

  const conflicts = (box: Rect, leader: Segment, selfX: number, selfY: number) =>
    placedBoxes.some((b) => rectsOverlap(box, b, gap)) ||
    placedBoxes.some((b) => segmentHitsRect(leader, b)) ||
    placedLeaders.some((s) => segmentsIntersect(leader, s)) ||
    placedLeaders.some((s) => segmentHitsRect(s, box)) ||
    // Don't cover other resort dots
    points.some((p) => (p.x !== selfX || p.y !== selfY) && rectsOverlap(box, { x: p.x - 5, y: p.y - 5, w: 10, h: 10 }, 0));

  return inputs.map((l) => {
    const visible = isInView(l);
    // Preferred spot first, then mirrored, then stacked further up/down on either side
    const candidates: Array<[number, number]> = [
      [l.dx, l.dy],
      [-l.dx, l.dy],
      [l.dx, -l.dy],
      [-l.dx, -l.dy],
    ];
    const step = l.boxHeight + gap;
    for (let k = 1; k <= 6; k++) {
      for (const sx of [l.dx, -l.dx]) {
        candidates.push([sx, l.dy + Math.sign(l.dy || 1) * k * step]);
        candidates.push([sx, l.dy - Math.sign(l.dy || 1) * k * step]);
      }
    }

    let chosen = place(l, l.dx, l.dy);
    if (visible) {
      const ok = candidates
        .map(([dx, dy]) => place(l, dx, dy))
        .find((c) => inViewport(c.box) && !conflicts(c.box, c.leader, l.x, l.y));
      if (ok) chosen = ok;
      else {
        // Fallback: preferred side, clamped into the viewport
        const b = chosen.box;
        b.x = Math.min(Math.max(b.x, pad), viewport.width - pad - b.w);
        b.y = Math.min(Math.max(b.y, pad), viewport.height - pad - b.h);
        const toRight = b.x + b.w / 2 >= l.x;
        chosen.leader = { x1: l.x, y1: l.y, x2: toRight ? b.x : b.x + b.w, y2: b.y + b.h / 2 };
      }
      placedBoxes.push(chosen.box);
      placedLeaders.push(chosen.leader);
    }

    return { id: l.id, point: { x: l.x, y: l.y }, box: chosen.box, leader: chosen.leader, visible };
  });
}
