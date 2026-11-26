import * as maplibregl from 'maplibre-gl';
import type { FrameMsg, InitMsg, TileMsg } from './surface.worker';

export const SURFACE_SOURCE_ID = 'surface';
export const SURFACE_LAYER_ID = 'surface';
const PROTOCOL = 'snowsurf';
export const surfaceTiles = (version: number) => `${PROTOCOL}://{z}/{x}/{y}?v=${version}`;

type FrameData = Omit<FrameMsg, 'type' | 'version'>;

/**
 * Renders the map surface (terrain light + AO + snow) in a pool of workers and
 * serves it to MapLibre via the snowsurf:// protocol. Each tile always goes to
 * the same worker, so per-tile caches aren't duplicated.
 */
export class SurfaceRenderer {
  private workers: Worker[] = [];
  private pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  version = 0;
  /** Timing stats for debugging/perf tuning */
  stats = { tiles: 0, staticMs: 0, shadeMs: 0 };

  constructor(init: Omit<InitMsg, 'type'>, workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('./surface.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string; staticMs?: number; shadeMs?: number }>) => {
        if (ev.data.bitmap) {
          this.stats.tiles++;
          this.stats.staticMs += ev.data.staticMs ?? 0;
          this.stats.shadeMs += ev.data.shadeMs ?? 0;
        }
        const p = this.pending.get(ev.data.id);
        if (!p) {
          ev.data.bitmap?.close();
          return;
        }
        this.pending.delete(ev.data.id);
        if (ev.data.bitmap) p.resolve(ev.data.bitmap);
        else p.reject(new Error(ev.data.error ?? 'surface tile failed'));
      };
      w.postMessage({ type: 'init', ...init } satisfies InitMsg);
      this.workers.push(w);
    }

    maplibregl.addProtocol(PROTOCOL, (params, abort) => {
      const [z, x, y] = params.url
        .replace(`${PROTOCOL}://`, '')
        .split('?')[0]
        .split('/')
        .map(Number);
      return this.renderTile(z, x, y, abort.signal).then((bitmap) => ({ data: bitmap }));
    });
  }

  /** Send new time/mode/theme data to all workers; returns the new version. */
  setFrame(data: FrameData): number {
    this.version++;
    const msg: FrameMsg = { type: 'frame', version: this.version, ...data };
    for (const w of this.workers) w.postMessage(msg);
    return this.version;
  }

  private renderTile(z: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap> {
    const id = this.nextId++;
    const worker = this.workers[(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) % this.workers.length];
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal.addEventListener('abort', () => {
        if (this.pending.delete(id)) reject(new DOMException('aborted', 'AbortError'));
      });
      worker.postMessage({ type: 'tile', id, z, x, y } satisfies TileMsg);
    });
  }
}

/**
 * Keeps the MapLibre surface source in sync with the renderer: after a frame
 * change, reloads the tiles with a new version – but only once the previous
 * reload has finished, so fast playback doesn't pile up requests.
 */
export class SurfaceSync {
  private shown = 0; // version the source currently requests
  private wanted = 0;
  /** True between setTiles() and the first tile of that version arriving */
  private awaitingTiles = false;
  private waiters: Array<{ version: number; resolve: () => void }> = [];

  constructor(private map: maplibregl.Map) {
    map.on('sourcedata', (e) => {
      if (e.sourceId !== SURFACE_SOURCE_ID) return;
      // Right after setTiles() the source still reports "loaded" (old tiles) –
      // only trust that once a tile of the new request set has come in
      if (e.tile) this.awaitingTiles = false;
      if (!this.awaitingTiles && map.isSourceLoaded(SURFACE_SOURCE_ID) && this.wanted !== this.shown) this.apply();
    });
    // Waiters (frame export) need everything on screen: resolve on 'idle'
    map.on('idle', () => {
      if (this.wanted !== this.shown) {
        this.apply();
        return;
      }
      if (!this.awaitingTiles) this.resolveWaiters();
    });
    // After a style rebuild (theme switch) the source starts over with version 0
    map.on('style.load', () => {
      this.shown = 0;
      this.apply();
    });
  }

  /** Ask the map to show `version` (coalesced while a reload is still running). */
  request(version: number) {
    this.wanted = version;
    const busy = this.awaitingTiles || !this.map.isSourceLoaded(SURFACE_SOURCE_ID);
    if (this.shown === 0 || !busy) this.apply();
  }

  /** Resolves once tiles of at least `version` are loaded and the map is idle (exact frame export). */
  waitForVersion(version: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ version, resolve });
      this.map.triggerRepaint();
    });
  }

  private apply() {
    const src = this.map.getSource<maplibregl.RasterTileSource>(SURFACE_SOURCE_ID);
    if (!src || this.wanted === this.shown) return;
    this.shown = this.wanted;
    this.awaitingTiles = true;
    src.setTiles([surfaceTiles(this.shown)]);
  }

  private resolveWaiters() {
    this.waiters = this.waiters.filter((w) => {
      if (w.version <= this.shown) {
        w.resolve();
        return false;
      }
      return true;
    });
  }
}
