import type { TimeMode, ViewTime } from '../layers/types';

export const RANGE_OPTIONS = [12, 24, 48, 96] as const;

export interface TimeState extends ViewTime {
  playing: boolean;
  /** Max window length the data allows from startIndex */
  maxRangeHours: number;
}

type Listener = (s: TimeState) => void;

/**
 * Owns the time state. Playback only advances `t`; it never renders.
 * Everything visible is derived from the state via subscribers, so a video
 * exporter can call setTime() for each frame instead of playing in real time.
 */
export class TimeController {
  private s: TimeState;
  private listeners = new Set<Listener>();
  private raf = 0;
  private lastTs = 0;
  /** Playback speed in forecast hours per real second */
  hoursPerSecond = 4;

  constructor(times: number[], now = Date.now()) {
    // Start at the current hour (or the first time if data starts later)
    let startIndex = times.findIndex((t) => t >= now - 3_600_000 / 2);
    if (startIndex < 0) startIndex = Math.max(0, times.length - 2);
    const maxRangeHours = times.length - 1 - startIndex;
    this.s = {
      startIndex,
      maxRangeHours,
      rangeHours: Math.min(48, maxRangeHours),
      t: 0,
      mode: 'accumulated',
      playing: false,
    };
  }

  get state(): Readonly<TimeState> {
    return this.s;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.s);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.s);
  }

  private patch(p: Partial<TimeState>) {
    this.s = { ...this.s, ...p };
    this.emit();
  }

  setTime(t: number) {
    this.patch({ t: Math.min(Math.max(t, 0), this.s.rangeHours) });
  }

  setRange(hours: number) {
    const rangeHours = Math.min(hours, this.s.maxRangeHours);
    this.patch({ rangeHours, t: Math.min(this.s.t, rangeHours) });
  }

  setMode(mode: TimeMode) {
    this.patch({ mode });
  }

  /** Jump to the next/previous full hour */
  step(dir: 1 | -1) {
    this.pause();
    const t = dir > 0 ? Math.floor(this.s.t + 1e-6) + 1 : Math.ceil(this.s.t - 1e-6) - 1;
    this.setTime(t);
  }

  play() {
    if (this.s.playing) return;
    if (this.s.t >= this.s.rangeHours) this.s = { ...this.s, t: 0 };
    this.patch({ playing: true });
    this.lastTs = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    if (!this.s.playing) return;
    cancelAnimationFrame(this.raf);
    this.patch({ playing: false });
  }

  toggle() {
    if (this.s.playing) this.pause();
    else this.play();
  }

  private tick = (ts: number) => {
    if (!this.s.playing) return;
    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.1) : 0;
    this.lastTs = ts;
    const t = this.s.t + dt * this.hoursPerSecond;
    if (t >= this.s.rangeHours) {
      this.patch({ t: this.s.rangeHours, playing: false });
      return;
    }
    this.patch({ t });
    this.raf = requestAnimationFrame(this.tick);
  };
}
