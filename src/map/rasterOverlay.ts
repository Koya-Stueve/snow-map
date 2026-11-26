import type { CanvasSource, Map as MapLibreMap } from 'maplibre-gl';
import type { ScalarCanvas } from '../render/scalarCanvas';

/**
 * Puts a ScalarCanvas on the map as a canvas source + raster layer, below the
 * hillshade so the relief shades the snow (the look from the Inspo videos).
 * Survives style changes (theme switch) by re-adding itself on style load.
 * Because it's a normal raster layer, it will drape over 3D terrain later.
 */
export class RasterOverlay {
  private sourceId: string;
  private layerId: string;

  constructor(
    private map: MapLibreMap,
    private sc: ScalarCanvas,
    id: string,
    private beforeId: string,
    private opacity = 1,
  ) {
    this.sourceId = `${id}-src`;
    this.layerId = id;
    // The style may already be loaded when we're created (data loads async), and
    // isStyleLoaded() stays false while tiles are loading – so just try now and
    // again on every style event until it sticks.
    const tryAdd = () => {
      try {
        this.add();
      } catch {
        /* style not ready yet – a later style event will retry */
      }
    };
    map.on('style.load', tryAdd);
    map.on('styledata', tryAdd);
    tryAdd();
  }

  private add() {
    if (this.map.getSource(this.sourceId)) return;
    this.map.addSource(this.sourceId, {
      type: 'canvas',
      canvas: this.sc.canvas,
      coordinates: this.sc.coordinates,
      animate: false, // we push updates explicitly in refresh()
    });
    this.map.addLayer(
      {
        id: this.layerId,
        type: 'raster',
        source: this.sourceId,
        paint: {
          'raster-opacity': this.opacity,
          'raster-resampling': 'linear',
          'raster-fade-duration': 0,
        },
      },
      this.map.getLayer(this.beforeId) ? this.beforeId : undefined,
    );
  }

  /** Call after drawing into the canvas: uploads the texture once and repaints. */
  refresh() {
    const src = this.map.getSource<CanvasSource>(this.sourceId);
    if (!src) return;
    // play() marks the texture dirty + triggers a repaint; pause() uploads it once and stops
    src.play();
    src.pause();
  }
}
