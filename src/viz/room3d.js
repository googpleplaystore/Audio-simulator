// 3D room view: a dependency-free perspective renderer (Canvas 2D, painter's
// algorithm with back-face culling and near-plane clipping) with orbit/zoom
// controls and direct manipulation — drag speakers, subwoofers and the
// listener across the floor (Shift+drag changes height). Emits the same
// events as the 2D RoomEditor: select, moved, pick-model, delete.

import { Emitter } from '../util/emitter.js';
import { fitCanvas, onFrame } from './canvas.js';
import { getHardware } from '../hardware/index.js';
import { MATERIALS } from '../acoustics/materials.js';
import { aimYaw, yawVector } from '../audio/plan.js';
import { clamp } from '../util/math.js';
import { heatCell } from './heatColors.js';

const FOV = (50 * Math.PI) / 180;
const NEAR = 0.05;
const HEAD_R = 0.11;

const v3 = (x, y, z) => ({ x, y, z });
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const norm = (a) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [120, 120, 140];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shade([r, g, b], k, a = 1) {
  return `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`;
}

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export class Room3D extends Emitter {
  constructor(canvas, app) {
    super();
    this.canvas = canvas;
    this.app = app;
    this.store = app.store;
    this.selected = { type: 'listener', id: 'listener' };
    this.cam = { yaw: 0.5, pitch: 0.62, dist: null, target: null };
    this.dirty = true;
    this.drag = null;
    this.pointers = new Map();
    this.heatmap = null;
    this.waves = [];
    this.lastWave = 0;
    this.canvas.tabIndex = 0;
    this._bind();
    this.offFrame = onFrame((t) => this._frame(t));
    this.offStore = this.store.subscribe(['room', 'listener', 'speakers', 'subs', 'ui'], () => (this.dirty = true));
    this.ro = new ResizeObserver(() => (this.dirty = true));
    this.ro.observe(canvas);
  }

  get state() {
    return this.store.state;
  }

  select(sel) {
    this.selected = sel;
    this.dirty = true;
    this.emit('select', sel);
  }

  setHeatmap(hm) {
    this.heatmap = hm;
    this.dirty = true;
  }

  resetView() {
    this.cam = { yaw: 0.5, pitch: 0.62, dist: null, target: null };
    this.dirty = true;
  }

  // ---------------------------------------------------------- camera
  _camera(w, h) {
    if (!this.cam.dist) {
      // Frame the room once the canvas has a real size.
      if (w < 60 || h < 60) return this._setView(w, h, Math.hypot(this.state.room.width, this.state.room.depth, this.state.room.height) * 1.2);
      this.cam.dist = this._fitDistance(w, h);
    }
    return this._setView(w, h, this.cam.dist);
  }

  /** Smallest distance at which the whole room is framed with a margin. */
  _fitDistance(w, h) {
    const { width: W, depth: D, height: H } = this.state.room;
    const corners = [];
    for (const x of [0, W]) for (const y of [0, H]) for (const z of [0, D]) corners.push(v3(x, y, z));
    const margin = 24;
    const fits = (dist) => {
      this._setView(w, h, dist);
      return corners.every((p) => {
        const c = this._toCam(p);
        if (c.z < NEAR) return false;
        const [x, y] = this._proj(c);
        return x >= margin && x <= w - margin && y >= margin && y <= h - margin;
      });
    };
    const diag = Math.hypot(W, D, H);
    let lo = diag * 0.3;
    let hi = diag * 6;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  _setView(w, h, dist) {
    const room = this.state.room;
    const target = this.cam.target || v3(room.width / 2, room.height * 0.35, room.depth / 2);
    const { yaw, pitch } = this.cam;
    const eye = add(target, v3(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist));
    const f = norm(sub(target, eye));
    const r = norm(cross(f, v3(0, 1, 0)));
    const u = cross(r, f);
    const focal = h / 2 / Math.tan(FOV / 2);
    this.view = { eye, f, r, u, focal, cx: w / 2, cy: h / 2, w, h, target };
    return this.view;
  }

  /** World → camera space (x right, y up, z forward). */
  _toCam(p) {
    const v = this.view;
    const d = sub(p, v.eye);
    return v3(dot(d, v.r), dot(d, v.u), dot(d, v.f));
  }

  _proj(c) {
    const v = this.view;
    return [v.cx + (v.focal * c.x) / c.z, v.cy - (v.focal * c.y) / c.z];
  }

  project(p) {
    const c = this._toCam(p);
    if (c.z < NEAR) return null;
    return this._proj(c);
  }

  /** Clip a camera-space polygon against the near plane. */
  _clip(poly) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ain = a.z >= NEAR;
      const bin = b.z >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) {
        const t = (NEAR - a.z) / (b.z - a.z);
        out.push(v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, NEAR));
      }
    }
    return out;
  }

  _polygon(ctx, world, fill, stroke, lw = 1) {
    const cam = this._clip(world.map((p) => this._toCam(p)));
    if (cam.length < 3) return null;
    const pts = cam.map((c) => this._proj(c));
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    return pts;
  }

  _line(ctx, a, b, color, lw = 1, dash = null) {
    let ca = this._toCam(a);
    let cb = this._toCam(b);
    if (ca.z < NEAR && cb.z < NEAR) return;
    if (ca.z < NEAR || cb.z < NEAR) {
      const t = (NEAR - ca.z) / (cb.z - ca.z);
      const m = v3(ca.x + (cb.x - ca.x) * t, ca.y + (cb.y - ca.y) * t, NEAR);
      if (ca.z < NEAR) ca = m;
      else cb = m;
    }
    const [x1, y1] = this._proj(ca);
    const [x2, y2] = this._proj(cb);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Ray from the camera through a screen point. */
  _ray(px, py) {
    const v = this.view;
    const dir = norm(add(add(mul(v.r, (px - v.cx) / v.focal), mul(v.u, -(py - v.cy) / v.focal)), v.f));
    return { o: v.eye, d: dir };
  }

  _rayPlaneY(ray, y) {
    if (Math.abs(ray.d.y) < 1e-6) return null;
    const t = (y - ray.o.y) / ray.d.y;
    if (t <= 0) return null;
    return add(ray.o, mul(ray.d, t));
  }

  // ---------------------------------------------------------- scene model
  _objects() {
    const s = this.state;
    const out = [];
    for (const sp of s.speakers) {
      const hw = getHardware(sp.modelId);
      const yaw = sp.aim !== false ? aimYaw(sp, s.listener) : sp.yaw ?? 180;
      const d = hw?.dims || { w: 20, h: 32, d: 25 };
      out.push({ type: 'speaker', id: sp.id, src: sp, hw, x: sp.x, y: sp.y ?? 1, z: sp.z, yaw, w: d.w / 100, h: d.h / 100, d: d.d / 100, cy: sp.y ?? 1 });
    }
    for (const sb of s.subs) {
      const hw = getHardware(sb.modelId);
      const d = hw?.dims || { w: 38, h: 40, d: 40 };
      const hh = d.h / 100;
      out.push({ type: 'sub', id: sb.id, src: sb, hw, x: sb.x, y: sb.y ?? 0.25, z: sb.z, yaw: sb.yaw ?? 180, w: d.w / 100, h: hh, d: d.d / 100, cy: hh / 2 });
    }
    const l = s.listener;
    out.push({ type: 'listener', id: 'listener', src: l, x: l.x, y: l.y ?? 1.15, z: l.z, yaw: l.yaw || 0, w: HEAD_R * 2, h: HEAD_R * 2, d: HEAD_R * 2, cy: l.y ?? 1.15 });
    return out;
  }

  _boxCorners(o) {
    const f = yawVector(o.yaw);
    const F = v3(f.x, 0, f.z);
    const R = v3(-f.z, 0, f.x);
    const c = v3(o.x, o.cy, o.z);
    const hw = o.w / 2;
    const hd = o.d / 2;
    const hh = o.h / 2;
    const P = (sx, sy, sz) => add(add(add(c, mul(R, sx * hw)), v3(0, sy * hh, 0)), mul(F, sz * hd));
    return { P, F, R, c, hw, hh, hd };
  }

  _hitObject(px, py) {
    let best = null;
    for (const o of this._objects()) {
      const cc = this._toCam(v3(o.x, o.cy, o.z));
      if (cc.z < NEAR) continue;
      const [sx, sy] = this._proj(cc);
      const r = Math.max(14, (this.view.focal * (Math.max(o.w, o.h, o.d) / 2)) / cc.z + 4);
      const dd = Math.hypot(px - sx, py - sy);
      if (dd < r && (!best || cc.z < best.z)) best = { obj: o, z: cc.z };
    }
    return best?.obj || null;
  }

  // ---------------------------------------------------------- interaction
  _bind() {
    const c = this.canvas;
    const local = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener('pointerdown', (e) => {
      c.focus({ preventScroll: true });
      this.pointers.set(e.pointerId, local(e));
      c.setPointerCapture(e.pointerId);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.drag = { pinch: true, d0: Math.hypot(a[0] - b[0], a[1] - b[1]), dist0: this.cam.dist };
        return;
      }
      if (!this.view) return;
      const [px, py] = local(e);
      const o = this._hitObject(px, py);
      if (o) {
        this.select({ type: o.type, id: o.id });
        const hit = this._rayPlaneY(this._ray(px, py), o.y);
        this.drag = { obj: o, dx: hit ? hit.x - o.x : 0, dz: hit ? hit.z - o.z : 0, y0: o.y, py0: py, moved: false, vertical: e.shiftKey };
        c.style.cursor = 'grabbing';
        return;
      }
      const wall = this._hitWall(px, py);
      if (wall) this.select({ type: 'wall', id: wall });
      else if (this.selected.type !== 'room') this.select({ type: 'room', id: 'room' });
      this.drag = { orbit: true, x: px, y: py, yaw: this.cam.yaw, pitch: this.cam.pitch };
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, local(e));
      const d = this.drag;
      if (!d) {
        if (!this.view) return;
        const [px, py] = local(e);
        c.style.cursor = this._hitObject(px, py) ? 'grab' : 'default';
        return;
      }
      if (d.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dd = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this._zoomTo(d.dist0 * (d.d0 / Math.max(10, dd)));
        return;
      }
      const [px, py] = local(e);
      if (d.orbit) {
        this.cam.yaw = d.yaw - (px - d.x) * 0.008;
        this.cam.pitch = clamp(d.pitch + (py - d.y) * 0.006, 0.08, 1.45);
        this.dirty = true;
        return;
      }
      if (d.obj) {
        d.moved = true;
        const room = this.state.room;
        if (d.vertical || e.shiftKey) {
          // Height: screen-space drag scaled by distance.
          const cc = this._toCam(v3(d.obj.x, d.y0, d.obj.z));
          const dy = ((d.py0 - py) * cc.z) / this.view.focal;
          const y = clamp(Math.round((d.y0 + dy) * 100) / 100, 0.05, room.height - 0.05);
          this._update(d.obj, { y });
          return;
        }
        const hit = this._rayPlaneY(this._ray(px, py), d.obj.y);
        if (!hit) return;
        let x = hit.x - d.dx;
        let z = hit.z - d.dz;
        if (this.state.ui.snap && !e.altKey) {
          x = Math.round(x / 0.05) * 0.05;
          z = Math.round(z / 0.05) * 0.05;
        }
        const m = d.obj.type === 'listener' ? HEAD_R : Math.min(d.obj.w, d.obj.d) / 2 + 0.02;
        this._update(d.obj, { x: Math.round(clamp(x, m, room.width - m) * 1000) / 1000, z: Math.round(clamp(z, m, room.depth - m) * 1000) / 1000 });
      }
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.drag?.obj && this.drag.moved) this.emit('moved', this.drag.obj);
      if (this.pointers.size === 0 || this.drag?.pinch) this.drag = null;
      c.style.cursor = 'default';
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this._zoomTo(this.cam.dist * Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
    c.addEventListener('dblclick', (e) => {
      const [px, py] = local(e);
      const o = this._hitObject(px, py);
      if (o && o.type !== 'listener') this.emit('pick-model', o);
      else if (!o) this.resetView();
    });
    c.addEventListener('keydown', (e) => {
      const sel = this._objects().find((o) => o.type === this.selected.type && o.id === this.selected.id);
      if (!sel) return;
      const step = e.shiftKey ? 0.25 : 0.05;
      const room = this.state.room;
      // Arrow keys move relative to the view direction, so "up" is always away from you.
      const fwd = norm(v3(this.view.f.x, 0, this.view.f.z));
      const right = v3(-fwd.z, 0, fwd.x);
      let mv = null;
      if (e.key === 'ArrowUp') mv = fwd;
      else if (e.key === 'ArrowDown') mv = mul(fwd, -1);
      else if (e.key === 'ArrowRight') mv = right;
      else if (e.key === 'ArrowLeft') mv = mul(right, -1);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.type !== 'listener') {
        e.preventDefault();
        this.emit('delete', sel);
        return;
      } else if (e.key === '[' || e.key === ']') {
        const rotatable = sel.type === 'listener' || (sel.type === 'speaker' && sel.src.aim === false);
        if (rotatable) this._update(sel, { yaw: (sel.yaw + (e.key === ']' ? 5 : -5) + 360) % 360 });
        return;
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        this._update(sel, { y: clamp(sel.y + (e.key === 'PageUp' ? 0.05 : -0.05), 0.05, room.height - 0.05) });
        return;
      }
      if (!mv) return;
      e.preventDefault();
      e.stopPropagation();
      this._update(sel, { x: clamp(sel.x + mv.x * step, 0.05, room.width - 0.05), z: clamp(sel.z + mv.z * step, 0.05, room.depth - 0.05) });
    });
  }

  _zoomTo(dist) {
    const room = this.state.room;
    const diag = Math.hypot(room.width, room.depth, room.height);
    this.cam.dist = clamp(dist, diag * 0.25, diag * 4);
    this.dirty = true;
  }

  _update(o, patch) {
    if (o.type === 'listener') this.store.patch('listener', patch);
    else this.store.updateItem(o.type === 'sub' ? 'subs' : 'speakers', o.id, patch);
    Object.assign(o, patch);
    if (patch.y !== undefined && o.type === 'speaker') o.cy = patch.y;
    this.dirty = true;
  }

  // ---------------------------------------------------------- room geometry
  _walls() {
    const { width: W, depth: D, height: H, materials } = this.state.room;
    return [
      { id: 'front', mat: materials.front, pts: [v3(0, 0, 0), v3(W, 0, 0), v3(W, H, 0), v3(0, H, 0)], n: v3(0, 0, 1) },
      { id: 'back', mat: materials.back, pts: [v3(W, 0, D), v3(0, 0, D), v3(0, H, D), v3(W, H, D)], n: v3(0, 0, -1) },
      { id: 'left', mat: materials.left, pts: [v3(0, 0, D), v3(0, 0, 0), v3(0, H, 0), v3(0, H, D)], n: v3(1, 0, 0) },
      { id: 'right', mat: materials.right, pts: [v3(W, 0, 0), v3(W, 0, D), v3(W, H, D), v3(W, H, 0)], n: v3(-1, 0, 0) },
      { id: 'ceiling', mat: materials.ceiling, pts: [v3(0, H, 0), v3(W, H, 0), v3(W, H, D), v3(0, H, D)], n: v3(0, -1, 0) },
      { id: 'floor', mat: materials.floor, pts: [v3(0, 0, 0), v3(0, 0, D), v3(W, 0, D), v3(W, 0, 0)], n: v3(0, 1, 0) },
    ];
  }

  /** Walls whose inside faces the camera (the ones we draw solid). */
  _visibleWalls() {
    return this._walls().filter((w) => dot(w.n, sub(this.view.eye, w.pts[0])) > 0);
  }

  _hitWall(px, py) {
    for (const w of this._visibleWalls()) {
      if (w.id === 'floor' || w.id === 'ceiling') continue;
      const cam = this._clip(w.pts.map((p) => this._toCam(p)));
      if (cam.length < 3) continue;
      if (pointInPoly(px, py, cam.map((c) => this._proj(c)))) return w.id;
    }
    return null;
  }

  // ---------------------------------------------------------- drawing
  _frame(t) {
    if (!this.canvas.isConnected || document.hidden) return;
    const playing = this.app.player.playing && this.state.engine.simulation;
    if (playing && t - this.lastWave > 420) {
      this.lastWave = t;
      for (const o of this._objects()) if (o.type !== 'listener' && !o.src.muted) this.waves.push({ x: o.x, z: o.z, born: t, sub: o.type === 'sub' });
      if (this.waves.length > 60) this.waves.splice(0, this.waves.length - 60);
    }
    if (!this.dirty && !playing && !this.waves.length) return;
    this.dirty = false;
    this.draw(t);
  }

  draw(t = performance.now()) {
    const { ctx, w, h } = fitCanvas(this.canvas);
    const s = this.state;
    const room = s.room;
    this._camera(w, h);
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0d0d15');
    bg.addColorStop(1, '#07070b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Room shell: solid inside faces (far walls), floor, then grid.
    const visible = this._visibleWalls();
    const order = visible.map((wall) => ({ wall, z: this._toCam(wall.pts.reduce((a, p) => add(a, mul(p, 0.25)), v3(0, 0, 0))).z })).sort((a, b) => b.z - a.z);
    for (const { wall } of order) {
      const mat = MATERIALS[wall.mat];
      const rgb = hexToRgb(mat?.color);
      const sel = this.selected.type === 'wall' && this.selected.id === wall.id;
      const k = wall.id === 'floor' ? 0.32 : wall.id === 'ceiling' ? 0.22 : 0.42;
      this._polygon(ctx, wall.pts, shade(rgb, k, wall.id === 'floor' ? 0.9 : 0.55), sel ? 'rgba(141,125,255,0.95)' : 'rgba(255,255,255,0.10)', sel ? 2.5 : 1);
    }
    // Floor grid (1 m)
    for (let x = 1; x < room.width; x += 1) this._line(ctx, v3(x, 0.001, 0), v3(x, 0.001, room.depth), 'rgba(255,255,255,0.06)');
    for (let z = 1; z < room.depth; z += 1) this._line(ctx, v3(0, 0.001, z), v3(room.width, 0.001, z), 'rgba(255,255,255,0.06)');
    // Bass heat map on the floor
    if (s.ui.heatmap && this.heatmap) this._drawHeatmap(ctx);

    const objs = this._objects();
    const lis = s.listener;
    const head = v3(lis.x, lis.y ?? 1.15, lis.z);

    // Wavefronts on the floor
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wv = this.waves[i];
      const age = (t - wv.born) / 1000;
      const r = age * (wv.sub ? 1.4 : 2.2);
      if (r > Math.max(room.width, room.depth) * 1.2) {
        this.waves.splice(i, 1);
        continue;
      }
      const pts = [];
      for (let k = 0; k <= 32; k++) {
        const a = (k / 32) * Math.PI * 2;
        const x = clamp(wv.x + Math.cos(a) * r, 0, room.width);
        const z = clamp(wv.z + Math.sin(a) * r, 0, room.depth);
        pts.push(v3(x, 0.003, z));
      }
      const alpha = Math.max(0, 0.35 * (1 - age / 2.2));
      for (let k = 0; k < 32; k++) this._line(ctx, pts[k], pts[k + 1], wv.sub ? `rgba(255,107,154,${alpha})` : `rgba(54,226,207,${alpha})`, 1.2);
    }

    // Shadows
    for (const o of objs) {
      const pts = [];
      const rr = Math.max(o.w, o.d) * 0.62;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        pts.push(v3(o.x + Math.cos(a) * rr, 0.002, o.z + Math.sin(a) * rr * 0.9));
      }
      this._polygon(ctx, pts, 'rgba(0,0,0,0.35)', null);
    }

    // Direct sound paths and first reflections of the selected speaker.
    if (s.ui.showRays !== false) {
      for (const o of objs) {
        if (o.type === 'listener' || o.src.muted) continue;
        this._line(ctx, v3(o.x, o.type === 'sub' ? o.cy : o.y, o.z), head, o.type === 'sub' ? 'rgba(255,107,154,0.5)' : 'rgba(54,226,207,0.55)', 1.4);
      }
      const sel = objs.find((o) => o.type === 'speaker' && o.id === this.selected.id && this.selected.type === 'speaker');
      if (sel) this._drawReflections(ctx, v3(sel.x, sel.y, sel.z), head);
    }

    // Objects, far to near.
    const sorted = objs.map((o) => ({ o, z: this._toCam(v3(o.x, o.cy, o.z)).z })).sort((a, b) => b.z - a.z);
    for (const { o } of sorted) {
      if (o.type === 'listener') this._drawListener(ctx, o);
      else this._drawBox(ctx, o);
    }

    // Cut-away near walls: outline only.
    const hidden = this._walls().filter((wl) => !visible.includes(wl));
    for (const wl of hidden) {
      const sel = this.selected.type === 'wall' && this.selected.id === wl.id;
      this._polygon(ctx, wl.pts, null, sel ? 'rgba(141,125,255,0.9)' : 'rgba(255,255,255,0.16)', sel ? 2 : 1);
    }
    // Front marker
    const fp = this.project(v3(room.width / 2, room.height + 0.12, 0));
    if (fp) {
      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.textAlign = 'center';
      ctx.fillText('FRONT', fp[0], fp[1]);
    }
  }

  _drawHeatmap(ctx) {
    const hm = this.heatmap;
    const room = this.state.room;
    const dx = room.width / hm.cols;
    const dz = room.depth / hm.rows;
    for (let r = 0; r < hm.rows; r++) {
      for (let c = 0; c < hm.cols; c++) {
        const [cr, cg, cb] = heatCell(hm, r * hm.cols + c);
        const x = c * dx;
        const z = r * dz;
        this._polygon(ctx, [v3(x, 0.002, z), v3(x + dx, 0.002, z), v3(x + dx, 0.002, z + dz), v3(x, 0.002, z + dz)], `rgba(${Math.round(cr)},${Math.round(cg)},${Math.round(cb)},0.55)`, null);
      }
    }
    if (hm.best) {
      const ring = [];
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        ring.push(v3(hm.best.x + Math.cos(a) * 0.22, 0.004, hm.best.z + Math.sin(a) * 0.22));
      }
      this._polygon(ctx, ring, 'rgba(124,240,200,0.25)', '#7cf0c8', 2.5);
      const lp = this.project(v3(hm.best.x, 0.35, hm.best.z));
      if (lp) {
        ctx.font = '700 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#7cf0c8';
        ctx.textAlign = 'center';
        ctx.fillText('best seat', lp[0], lp[1]);
      }
    }
  }

  _drawReflections(ctx, src, lis) {
    const { width: W, depth: D, height: H } = this.state.room;
    const planes = [
      { axis: 'x', v: 0 },
      { axis: 'x', v: W },
      { axis: 'z', v: 0 },
      { axis: 'z', v: D },
      { axis: 'y', v: 0 },
      { axis: 'y', v: H },
    ];
    for (const pl of planes) {
      const img = { ...src };
      img[pl.axis] = 2 * pl.v - src[pl.axis];
      const denom = lis[pl.axis] - img[pl.axis];
      if (Math.abs(denom) < 1e-9) continue;
      const t = (pl.v - img[pl.axis]) / denom;
      if (t <= 0 || t >= 1) continue;
      const p = v3(img.x + (lis.x - img.x) * t, img.y + (lis.y - img.y) * t, img.z + (lis.z - img.z) * t);
      if (p.x < 0 || p.x > W || p.y < 0 || p.y > H || p.z < 0 || p.z > D) continue;
      this._line(ctx, src, p, 'rgba(255,181,71,0.55)', 1, [4, 4]);
      this._line(ctx, p, lis, 'rgba(255,181,71,0.55)', 1, [4, 4]);
      const pp = this.project(p);
      if (pp) {
        ctx.beginPath();
        ctx.arc(pp[0], pp[1], 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffb547';
        ctx.fill();
      }
    }
  }

  _drawBox(ctx, o) {
    const { P, F, R, c, hw, hh, hd } = this._boxCorners(o);
    const sel = this.selected.type === o.type && this.selected.id === o.id;
    const base = o.type === 'sub' ? [52, 40, 58] : [46, 44, 64];
    const eye = this.view.eye;
    // Stand for elevated speakers.
    if (o.type === 'speaker' && c.y - hh > 0.05) {
      this._line(ctx, v3(o.x, 0, o.z), v3(o.x, c.y - hh, o.z), 'rgba(160,160,180,0.55)', 3);
    }
    const faces = [
      { n: F, pts: [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], front: true },
      { n: mul(F, -1), pts: [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)] },
      { n: R, pts: [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)] },
      { n: mul(R, -1), pts: [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)] },
      { n: v3(0, 1, 0), pts: [P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)] },
      { n: v3(0, -1, 0), pts: [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)] },
    ];
    const light = norm(v3(-0.4, 0.9, 0.5));
    for (const face of faces) {
      const centre = face.pts.reduce((a, p) => add(a, mul(p, 0.25)), v3(0, 0, 0));
      if (dot(face.n, sub(eye, centre)) <= 0) continue; // back-face culling
      const k = 0.55 + 0.6 * Math.max(0, dot(face.n, light));
      this._polygon(ctx, face.pts, shade(base, k * (face.front ? 1.15 : 1), 1), sel ? 'rgba(141,125,255,0.95)' : 'rgba(255,255,255,0.12)', sel ? 2 : 1);
      if (face.front) this._drawDrivers(ctx, o, c, F, R, hw, hh, hd);
    }
    // Label
    const lp = this.project(v3(o.x, c.y + hh + 0.12, o.z));
    if (lp) {
      ctx.font = '800 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.fillText(o.type === 'sub' ? 'SUB' : o.src.channel, lp[0], lp[1]);
    }
  }

  _drawDrivers(ctx, o, c, F, R, hw, hh, hd) {
    const front = add(c, mul(F, hd + 0.002));
    const circle = (centre, r, fill) => {
      const pts = [];
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        pts.push(add(add(centre, mul(R, Math.cos(a) * r)), v3(0, Math.sin(a) * r, 0)));
      }
      this._polygon(ctx, pts, fill, 'rgba(0,0,0,0.4)', 0.8);
    };
    if (o.type === 'sub') {
      circle(front, Math.min(hw, hh) * 0.75, 'rgba(20,18,26,0.95)');
      circle(front, Math.min(hw, hh) * 0.28, 'rgba(60,56,72,0.95)');
    } else {
      const wr = Math.min(hw * 0.78, hh * 0.38);
      circle(add(front, v3(0, -hh * 0.3, 0)), wr, 'rgba(18,18,24,0.95)');
      circle(add(front, v3(0, hh * 0.5, 0)), Math.min(wr * 0.35, hh * 0.14), 'rgba(200,200,215,0.9)');
    }
  }

  _drawListener(ctx, o) {
    const sel = this.selected.type === 'listener';
    const head = v3(o.x, o.y, o.z);
    const cc = this._toCam(head);
    if (cc.z < NEAR) return;
    const f = yawVector(o.yaw);
    // Seat
    const seatY = Math.max(0.2, o.y - 0.7);
    const R = v3(-f.z, 0, f.x);
    const F = v3(f.x, 0, f.z);
    const seat = (sx, sy, sz) => add(add(v3(o.x, 0, o.z), mul(R, sx)), add(v3(0, sy, 0), mul(F, sz)));
    this._polygon(ctx, [seat(-0.32, seatY, 0.15), seat(0.32, seatY, 0.15), seat(0.32, seatY, -0.35), seat(-0.32, seatY, -0.35)], 'rgba(90,84,120,0.55)', 'rgba(255,255,255,0.1)');
    this._polygon(ctx, [seat(-0.32, seatY, -0.35), seat(0.32, seatY, -0.35), seat(0.32, seatY + 0.55, -0.4), seat(-0.32, seatY + 0.55, -0.4)], 'rgba(80,74,110,0.55)', 'rgba(255,255,255,0.1)');
    this._line(ctx, v3(o.x, seatY, o.z - 0.05 * f.z), v3(o.x, o.y - HEAD_R, o.z), 'rgba(141,125,255,0.6)', 6);
    // Head
    const [sx, sy] = this._proj(cc);
    const r = (this.view.focal * HEAD_R) / cc.z;
    const g = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.3, r * 0.1, sx, sy, r);
    g.addColorStop(0, sel ? '#c9c0ff' : '#b0a6f0');
    g.addColorStop(1, '#5b4fc4');
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    if (sel) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // Facing direction
    this._line(ctx, head, add(head, v3(f.x * 0.35, 0, f.z * 0.35)), 'rgba(255,255,255,0.8)', 2);
  }

  destroy() {
    this.offFrame();
    this.offStore();
    this.ro.disconnect();
    this.removeAll();
  }
}
