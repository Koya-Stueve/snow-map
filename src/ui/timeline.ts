import type { TimeController, TimeState } from '../time/timeController';
import { RANGE_OPTIONS } from '../time/timeController';
import type { TimeMode } from '../layers/types';
import { HOUR_MS } from '../data/types';
import { formatDay, hourInTz } from './timeFormat';

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>';
const ICON_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.5v14H6zM20 5v14L9.5 12z"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5H18v14h-2.5zM4 5v14l10.5-7z"/></svg>';

/** Bottom control bar: play/pause, step, scrub slider with day ticks, range + mode chips. */
export class Timeline {
  private el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private slider: HTMLInputElement;
  private ticks: HTMLDivElement;
  private rangeBtns = new Map<number, HTMLButtonElement>();
  private modeBtns = new Map<TimeMode, HTMLButtonElement>();
  private lastTickKey = '';

  constructor(
    container: HTMLElement,
    tc: TimeController,
    private times: number[],
  ) {
    this.el = document.createElement('div');
    this.el.className = 'timeline';
    this.el.innerHTML = `
      <div class="tl-row tl-main">
        <button class="tl-btn" data-act="prev" aria-label="Eine Stunde zurück">${ICON_PREV}</button>
        <button class="tl-btn tl-play" data-act="play" aria-label="Abspielen">${ICON_PLAY}</button>
        <button class="tl-btn" data-act="next" aria-label="Eine Stunde vor">${ICON_NEXT}</button>
        <div class="tl-track">
          <input class="tl-slider" type="range" min="0" step="any" aria-label="Zeitpunkt" />
          <div class="tl-ticks"></div>
        </div>
      </div>
      <div class="tl-row tl-options">
        <div class="tl-chips" role="group" aria-label="Zeitraum"></div>
        <div class="tl-chips" role="group" aria-label="Darstellung"></div>
      </div>`;
    container.prepend(this.el); // source line stays below the controls

    this.playBtn = this.el.querySelector('.tl-play')!;
    this.slider = this.el.querySelector('.tl-slider')!;
    this.ticks = this.el.querySelector('.tl-ticks')!;
    const [rangeGroup, modeGroup] = this.el.querySelectorAll<HTMLDivElement>('.tl-chips');

    for (const h of RANGE_OPTIONS) {
      const b = chip(h <= 48 ? `${h} h` : `${h / 24} Tage`);
      b.addEventListener('click', () => tc.setRange(h));
      rangeGroup.appendChild(b);
      this.rangeBtns.set(h, b);
    }
    for (const [mode, label] of [
      ['accumulated', 'Summe'],
      ['hourly', 'Stündlich'],
    ] as const) {
      const b = chip(label);
      b.addEventListener('click', () => tc.setMode(mode));
      modeGroup.appendChild(b);
      this.modeBtns.set(mode, b);
    }

    this.el.querySelector('[data-act="prev"]')!.addEventListener('click', () => tc.step(-1));
    this.el.querySelector('[data-act="next"]')!.addEventListener('click', () => tc.step(1));
    this.playBtn.addEventListener('click', () => tc.toggle());
    this.slider.addEventListener('input', () => {
      tc.pause();
      tc.setTime(Number(this.slider.value));
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target !== this.slider) return;
      if (e.code === 'Space') {
        e.preventDefault();
        tc.toggle();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        tc.step(1);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        tc.step(-1);
      }
    });

    tc.subscribe((s) => this.render(s));
  }

  private render(s: TimeState) {
    this.playBtn.innerHTML = s.playing ? ICON_PAUSE : ICON_PLAY;
    this.playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Abspielen');
    this.slider.max = String(s.rangeHours);
    this.slider.value = String(s.t);
    this.slider.style.setProperty('--progress', `${(s.t / s.rangeHours) * 100}%`);

    // An option beyond the data means "as far as the data goes"; only the first such option stays enabled
    const firstBeyond = RANGE_OPTIONS.find((h) => h > s.maxRangeHours);
    for (const [h, b] of this.rangeBtns) {
      b.classList.toggle('active', Math.min(h, s.maxRangeHours) === s.rangeHours);
      b.disabled = h > s.maxRangeHours && h !== firstBeyond;
    }
    for (const [m, b] of this.modeBtns) b.classList.toggle('active', m === s.mode);

    const key = `${s.startIndex}:${s.rangeHours}`;
    if (key !== this.lastTickKey) {
      this.lastTickKey = key;
      this.renderTicks(s);
    }
  }

  /** Day labels at local (JST) midnights inside the window */
  private renderTicks(s: TimeState) {
    this.ticks.innerHTML = '';
    const start = this.times[s.startIndex];
    for (let h = 0; h <= s.rangeHours; h++) {
      const ms = start + h * HOUR_MS;
      if (hourInTz(ms) !== 0 || h === 0) continue;
      const t = document.createElement('div');
      t.className = 'tl-tick';
      t.style.left = `${(h / s.rangeHours) * 100}%`;
      t.textContent = s.rangeHours <= 96 ? formatDay(ms) : '';
      this.ticks.appendChild(t);
    }
  }
}

function chip(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'tl-chip';
  b.type = 'button';
  b.textContent = label;
  return b;
}
