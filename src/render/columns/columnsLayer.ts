import * as maplibregl from 'maplibre-gl';
import type { ColumnGrid } from './columnGrid';

// Snow as 3D columns (Inspo clip 09-24-24): one instanced box per column, height
// from the snow value, colour graded along the height: dark blue at the ground
// (melts into the background) → white → pink at the top of tall columns.

export interface ColumnStyle {
  low: [number, number, number]; // 0..1 rgb at the ground
  mid: [number, number, number];
  high: [number, number, number];
  /** Height above ground (m, before exaggeration) where the colour reaches `high` */
  colorRefMeters: number;
}

const VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform float u_exag;        // terrain exaggeration (0 in 2D)
uniform float u_heightExag;  // column height exaggeration
in vec3 a_corner;            // unit box: xy in [-.5,.5], z in {0,1}
in vec3 a_normal;
in vec2 a_center;            // mercator
in vec2 a_half;              // mercator half size
in vec3 a_z;                 // ground (m), groundMin (m), mercator units per metre
in float a_height;           // column height (m)
out float v_rel;             // height above ground (m, unexaggerated)
out vec3 v_normal;
void main() {
  if (a_height < 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ground = a_z.x * u_exag;
  float bottom = a_z.y * u_exag - 30.0;
  float top = ground + a_height * u_heightExag;
  float zm = a_corner.z > 0.5 ? top : bottom;
  v_rel = a_corner.z > 0.5 ? a_height : (a_z.y - a_z.x);
  v_normal = a_normal;
  gl_Position = u_matrix * vec4(a_center + a_corner.xy * 2.0 * a_half, zm * a_z.z, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform vec3 u_low;
uniform vec3 u_mid;
uniform vec3 u_high;
uniform float u_ref;
in float v_rel;
in vec3 v_normal;
out vec4 fragColor;
void main() {
  float t = clamp(v_rel / u_ref, 0.0, 1.0);
  vec3 c = t < 0.5 ? mix(u_low, u_mid, smoothstep(0.0, 1.0, t / 0.5)) : mix(u_mid, u_high, smoothstep(0.0, 1.0, (t - 0.5) / 0.5));
  // simple light from the north-west + sky
  vec3 l = normalize(vec3(-0.55, 0.55, 0.65));
  float shade = 0.55 + 0.45 * max(dot(normalize(v_normal), l), 0.0);
  fragColor = vec4(c * shade, 1.0);
}`;

/** Column width as a fraction of the grid spacing */
const FOOTPRINT = 0.55;

// Box without bottom: 5 faces × 2 triangles × 3 vertices
function unitBox(): { corners: Float32Array; normals: Float32Array } {
  const faces: Array<{ n: number[]; v: number[][] }> = [
    { n: [0, 0, 1], v: [[-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1]] },
    { n: [0, -1, 0], v: [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, -0.5, 1], [-0.5, -0.5, 1]] },
    { n: [0, 1, 0], v: [[0.5, 0.5, 0], [-0.5, 0.5, 0], [-0.5, 0.5, 1], [0.5, 0.5, 1]] },
    { n: [1, 0, 0], v: [[0.5, -0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 1], [0.5, -0.5, 1]] },
    { n: [-1, 0, 0], v: [[-0.5, 0.5, 0], [-0.5, -0.5, 0], [-0.5, -0.5, 1], [-0.5, 0.5, 1]] },
  ];
  const c: number[] = [];
  const n: number[] = [];
  for (const f of faces)
    for (const i of [0, 1, 2, 0, 2, 3]) {
      c.push(...f.v[i]);
      // mercator y points south: flip the y component of the normal for lighting
      n.push(f.n[0], -f.n[1], f.n[2]);
    }
  return { corners: new Float32Array(c), normals: new Float32Array(n) };
}

export class ColumnsLayer implements maplibregl.CustomLayerInterface {
  id = 'snow-columns';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  private map?: maplibregl.Map;
  private program?: WebGLProgram;
  private vao?: WebGLVertexArrayObject;
  private heightBuf?: WebGLBuffer;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private heights: Float32Array;
  private dirty = true;
  visible = true;
  heightExaggeration = 1;
  /** Debug: number of draw calls so far */
  renders = 0;

  constructor(
    readonly grid: ColumnGrid,
    public style: ColumnStyle,
  ) {
    this.heights = new Float32Array(grid.count);
  }

  /** Column heights in metres (unexaggerated), one per column */
  setHeights(h: Float32Array) {
    this.heights.set(h);
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  onAdd(map: maplibregl.Map, glCtx: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    const gl = glCtx as WebGL2RenderingContext;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.program = p;
    for (const u of ['u_matrix', 'u_exag', 'u_heightExag', 'u_low', 'u_mid', 'u_high', 'u_ref']) this.uniforms[u] = gl.getUniformLocation(p, u);

    const g = this.grid;
    const n = g.count;
    const center = new Float32Array(n * 2);
    const half = new Float32Array(n * 2);
    const z = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const c = maplibregl.MercatorCoordinate.fromLngLat([g.lon[i], g.lat[i]]);
      const e = maplibregl.MercatorCoordinate.fromLngLat([g.lon[i] + g.dLon / 2, g.lat[i] - g.dLat / 2]);
      center[i * 2] = c.x;
      center[i * 2 + 1] = c.y;
      // slim columns with clear gaps (Inspo look)
      half[i * 2] = Math.abs(e.x - c.x) * FOOTPRINT;
      half[i * 2 + 1] = Math.abs(e.y - c.y) * FOOTPRINT;
      z[i * 3] = g.ground[i];
      z[i * 3 + 1] = g.groundMin[i];
      z[i * 3 + 2] = c.meterInMercatorCoordinateUnits();
    }
    const box = unitBox();

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const attr = (name: string, data: Float32Array, size: number, divisor: number, usage: number = gl.STATIC_DRAW) => {
      const loc = gl.getAttribLocation(p, name);
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, divisor);
      return buf;
    };
    attr('a_corner', box.corners, 3, 0);
    attr('a_normal', box.normals, 3, 0);
    attr('a_center', center, 2, 1);
    attr('a_half', half, 2, 1);
    attr('a_z', z, 3, 1);
    this.heightBuf = attr('a_height', this.heights, 1, 1, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  render(glCtx: WebGLRenderingContext | WebGL2RenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (!this.visible || !this.program || !this.vao) return;
    this.renders++;
    const gl = glCtx as WebGL2RenderingContext;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.heightBuf!);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.heights);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.dirty = false;
    }
    const s = this.style;
    // mainMatrix maps web-mercator 0..1 (x, y, conformal z) to clip space
    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, options.defaultProjectionData.mainMatrix as Float32Array);
    gl.uniform1f(this.uniforms.u_exag, this.map?.getTerrain()?.exaggeration ?? 0);
    gl.uniform1f(this.uniforms.u_heightExag, this.heightExaggeration);
    gl.uniform3fv(this.uniforms.u_low, s.low);
    gl.uniform3fv(this.uniforms.u_mid, s.mid);
    gl.uniform3fv(this.uniforms.u_high, s.high);
    gl.uniform1f(this.uniforms.u_ref, s.colorRefMeters);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE); // depth test is enough; winding flips in mercator (y down)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, this.grid.count);
    gl.bindVertexArray(null);
  }

  onRemove() {
    // GL objects die with the context on style changes; nothing to keep
    this.program = undefined;
    this.vao = undefined;
  }
}
