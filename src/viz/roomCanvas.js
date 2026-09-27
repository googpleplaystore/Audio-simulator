// Interactive top-down room editor.

import { Emitter } from '../util/emitter.js';
import { fitCanvas, onFrame } from './canvas.js';
import { getHardware } from '../hardware/index.js';
import { MATERIALS } from '../acoustics/materials.js';
import { boundaryGain, roomSpeedOfSound } from '../acoustics/room.js';
import { aimYaw, yawVector } from '../audio/plan.js';
import { clamp } from '../util/math.js';

const MARGIN = 54;
const HEAD_R = 0.14;

function divergingColor(t) {
  // t in [-1, 1]: blue (weak) → dark → orange/red (strong)
  const a = clamp(t, -1, 1);
  if (a < 0) {
    const k = -a;
    return [20 + 20 * (1 - k), 60 + 80 * k, 120 + 135 * k];
  }
  return [40 + 215 * a, 40 + 120 * a * (1 - a * 0.4), 60 * (1 - a)];
}

export class RoomEditor extends Emitter {
  constructor(canvas, app) {
    super();
    this.canvas = canvas;
    this.app = app;
    this.store = app.store;
    this.selected = { type: 'listener', id: 'listener' };
    this.heatmap = null;
    this.heatImg = null;
    this.waves = [];
    this.pulses = [];
    this.dirty = true;
    this.drag = null;
    this.hover = null;
    this.lastWave = 0;
    this._bind();
    this.offFrame = onFrame((t) => this._frame(t));
    this.offStore = this.store.subscribe(['room', 'listener', 'speakers', 'subs', 'ui', 'crossover'], () => (this.dirty = true));
    this.offPulse = app.haptics.on('pulse', (p) => {
      const l = this.store.state.listener;
      this.pulses.push({ x: l.x, z: l.z, born: performance.now(), s: p.strength });
    });
    this.ro = new ResizeObserver(() => (this.dirty = true));
    this.ro.observe(canvas);
  }

  get state() {
    return this.store.state;
  }

  setHeatmap(hm) {
    this.heatmap = hm;
    this.heatImg = null;
    if (hm) {
      const c = document.createElement('canvas');
      c.width = hm.cols;
      c.height = hm.rows;
      const g = c.getContext('2d');
      const img = g.createImageData(hm.cols, hm.rows);
      const ref = hm.ref;
      for (let i = 0; i < hm.data.length; i++) {
        const t = (hm.data[i] - ref) / 12;
        const [r, gg, b] = divergingColor(t);
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = gg;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      this.heatImg = c;
    }
    this.dirty = true;
  }

  select(sel) {
    this.selected = sel;
    this.dirty = true;
    this.emit('select', sel);
  }

  // ---------------------------------------------------------- geometry
  _layout(w, h) {
    const room = this.state.room;
    const scale = Math.min((w - MARGIN * 2) / room.width, (h - MARGIN * 2) / room.depth);
    const ox = (w - room.width * scale) / 2;
    const oy = (h - room.depth * scale) / 2;
    this.geo = { scale, ox, oy, w, h };
    return this.geo;
  }

  px(x, z) {
    const g = this.geo;
    return [g.ox + x * g.scale, g.oy + z * g.scale];
  }

  toRoom(px, py) {
    const g = this.geo;
    return { x: (px - g.ox) / g.scale, z: (py - g.oy) / g.scale };
  }

  _objects() {
    const s = this.state;
    const out = [];
    for (const sp of s.speakers) {
      const hw = getHardware(sp.modelId);
      const yaw = sp.aim !== false ? aimYaw(sp, s.listener) : sp.yaw ?? 180;
      out.push({ type: 'speaker', id: sp.id, src: sp, hw, x: sp.x, z: sp.z, yaw, w: (hw?.dims?.w || 20) / 100, d: (hw?.dims?.d || 25) / 100 });
    }
    for (const sb of s.subs) {
      const hw = getHardware(sb.modelId);
      out.push({ type: 'sub', id: sb.id, src: sb, hw, x: sb.x, z: sb.z, yaw: sb.yaw ?? 180, w: (hw?.dims?.w || 38) / 100, d: (hw?.dims?.d || 40) / 100 });
    }
    out.push({ type: 'listener', id: 'listener', src: s.listener, x: s.listener.x, z: s.listener.z, yaw: s.listener.yaw || 0, w: HEAD_R * 2, d: HEAD_R * 2 });
    return out;
  }

  _hit(px, py) {
    const objs = this._objects();
    const g = this.geo;
    // Rotation handle of the selection first.
    const sel = objs.find((o) => o.type === this.selected.type && o.id === this.selected.id);
    if (sel && this._rotatable(sel)) {
      const [hx, hy] = this._handlePos(sel);
      if (Math.hypot(px - hx, py - hy) < 12) return { obj: sel, handle: true };
    }
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      const [cx, cy] = this.px(o.x, o.z);
      const r = Math.max(14, (Math.max(o.w, o.d) / 2) * g.scale + 4);
      if (Math.hypot(px - cx, py - cy) < r) return { obj: o };
    }
    // Walls
    const room = this.state.room;
    const [x0, y0] = this.px(0, 0);
    const [x1, y1] = this.px(room.width, room.depth);
    const near = 12;
    if (px > x0 - near && px < x1 + near && py > y0 - near && py < y1 + near) {
      if (Math.abs(py - y0) < near) return { wall: 'front' };
      if (Math.abs(py - y1) < near) return { wall: 'back' };
      if (Math.abs(px - x0) < near) return { wall: 'left' };
      if (Math.abs(px - x1) < near) return { wall: 'right' };
    }
    return null;
  }

  _rotatable(o) {
    if (o.type === 'listener') return true;
    if (o.type === 'speaker') return o.src.aim === false;
    return false;
  }

  _handlePos(o) {
    const v = yawVector(o.yaw);
    const dist = Math.max(o.w, o.d) / 2 + 0.3;
    return this.px(o.x + v.x * dist, o.z + v.z * dist);
  }

  // ---------------------------------------------------------- interaction
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const hit = this._hit(px, py);
      if (!hit) {
        this.select({ type: 'room', id: 'room' });
        return;
      }
      if (hit.wall) {
        this.select({ type: 'wall', id: hit.wall });
        return;
      }
      const o = hit.obj;
      this.select({ type: o.type, id: o.id });
      c.setPointerCapture(e.pointerId);
      const p = this.toRoom(px, py);
      this.drag = { obj: o, handle: !!hit.handle, dx: p.x - o.x, dz: p.z - o.z, moved: false };
      c.style.cursor = hit.handle ? 'grabbing' : 'move';
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      if (!this.drag) {
        const hit = this._hit(px, py);
        c.style.cursor = hit ? (hit.handle ? 'grab' : hit.wall ? 'pointer' : 'move') : 'default';
        const hk = hit ? hit.wall || `${hit.obj?.type}:${hit.obj?.id}` : null;
        if (hk !== this.hover) {
          this.hover = hk;
          this.dirty = true;
        }
        return;
      }
      const p = this.toRoom(px, py);
      const d = this.drag;
      const room = this.state.room;
      d.moved = true;
      if (d.handle) {
        const yaw = Math.round((Math.atan2(p.x - d.obj.x, -(p.z - d.obj.z)) * 180) / Math.PI);
        this._update(d.obj, { yaw: e.shiftKey ? Math.round(yaw / 15) * 15 : yaw });
      } else {
        let x = p.x - d.dx;
        let z = p.z - d.dz;
        const snap = this.state.ui.snap && !e.altKey;
        if (snap) {
          x = Math.round(x / 0.05) * 0.05;
          z = Math.round(z / 0.05) * 0.05;
        }
        const mx = d.obj.type === 'listener' ? HEAD_R : Math.min(d.obj.w, d.obj.d) / 2 + 0.02;
        x = clamp(x, mx, room.width - mx);
        z = clamp(z, mx, room.depth - mx);
        this._update(d.obj, { x: Math.round(x * 1000) / 1000, z: Math.round(z * 1000) / 1000 });
      }
    });
    const up = () => {
      if (this.drag && this.drag.moved) this.emit('moved', this.drag.obj);
      this.drag = null;
      c.style.cursor = 'default';
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      const hit = this._hit(e.clientX - r.left, e.clientY - r.top);
      if (hit && hit.obj && hit.obj.type !== 'listener') this.emit('pick-model', hit.obj);
    });
    c.tabIndex = 0;
    c.addEventListener('keydown', (e) => {
      const sel = this._objects().find((o) => o.type === this.selected.type && o.id === this.selected.id);
      if (!sel) return;
      const step = e.shiftKey ? 0.25 : 0.05;
      const room = this.state.room;
      let { x, z } = sel;
      if (e.key === 'ArrowLeft') x -= step;
      else if (e.key === 'ArrowRight') x += step;
      else if (e.key === 'ArrowUp') z -= step;
      else if (e.key === 'ArrowDown') z += step;
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.type !== 'listener') {
        e.preventDefault();
        this.emit('delete', sel);
        return;
      } else if (e.key === '[' || e.key === ']') {
        if (this._rotatable(sel)) this._update(sel, { yaw: (sel.yaw + (e.key === ']' ? 5 : -5) + 360) % 360 });
        return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
      this._update(sel, { x: clamp(x, 0.05, room.width - 0.05), z: clamp(z, 0.05, room.depth - 0.05) });
    });
  }

  _update(o, patch) {
    if (o.type === 'listener') this.store.patch('listener', patch);
    else this.store.updateItem(o.type === 'sub' ? 'subs' : 'speakers', o.id, patch);
    Object.assign(o, patch);
    this.dirty = true;
  }

  // ---------------------------------------------------------- drawing
  _frame(t) {
    if (!this.canvas.isConnected || document.hidden) return;
    const playing = this.app.player.playing && this.state.engine.simulation;
    const animating = playing || this.pulses.length || this.waves.length;
    if (!this.dirty && !animating) return;
    this.dirty = false;
    if (playing && t - this.lastWave > 380) {
      this.lastWave = t;
      const meters = this.app.engine.meters.sources;
      for (const o of this._objects()) {
        if (o.type === 'listener' || o.src.muted) continue;
        const m = meters[o.id];
        const s = m ? clamp(Math.log10(1 + m.watts * 4) / 2.2, 0.05, 1) : 0.2;
        this.waves.push({ x: o.x, z: o.z, born: t, s, sub: o.type === 'sub' });
      }
      if (this.waves.length > 80) this.waves.splice(0, this.waves.length - 80);
    }
    this.draw(t);
  }

  draw(t = performance.now()) {
    const { ctx, w, h } = fitCanvas(this.canvas);
    const s = this.state;
    const room = s.room;
    const g = this._layout(w, h);
    ctx.clearRect(0, 0, w, h);
    const [x0, y0] = this.px(0, 0);
    const [x1, y1] = this.px(room.width, room.depth);
    // Floor
    const floorMat = MATERIALS[room.materials.floor];
    const fg = ctx.createLinearGradient(x0, y0, x1, y1);
    fg.addColorStop(0, '#15151e');
    fg.addColorStop(1, '#0f0f16');
    ctx.fillStyle = fg;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = `${floorMat?.color || '#444'}22`;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    // Heatmap
    if (s.ui.heatmap && this.heatImg) {
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.heatImg, x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
    // Grid
    ctx.lineWidth = 1;
    const minor = g.scale * 0.5 > 16 ? 0.5 : 1;
    for (let x = minor; x < room.width; x += minor) {
      const px = Math.round(x0 + x * g.scale) + 0.5;
      ctx.strokeStyle = Math.abs(x - Math.round(x)) < 1e-6 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
      ctx.beginPath();
      ctx.moveTo(px, y0);
      ctx.lineTo(px, y1);
      ctx.stroke();
    }
    for (let z = minor; z < room.depth; z += minor) {
      const py = Math.round(y0 + z * g.scale) + 0.5;
      ctx.strokeStyle = Math.abs(z - Math.round(z)) < 1e-6 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
      ctx.beginPath();
      ctx.moveTo(x0, py);
      ctx.lineTo(x1, py);
      ctx.stroke();
    }
    // Walls
    const walls = [
      ['front', x0, y0, x1, y0],
      ['back', x0, y1, x1, y1],
      ['left', x0, y0, x0, y1],
      ['right', x1, y0, x1, y1],
    ];
    for (const [id, ax, ay, bx, by] of walls) {
      const m = MATERIALS[room.materials[id]];
      const sel = this.selected.type === 'wall' && this.selected.id === id;
      const hov = this.hover === id;
      ctx.strokeStyle = m?.color || '#888';
      ctx.lineWidth = sel ? 9 : hov ? 8 : 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      if (sel) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.lineCap = 'butt';
    // Wall labels + dimensions
    ctx.font = '700 10.5px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`FRONT WALL · ${MATERIALS[room.materials.front]?.name || ''}`, (x0 + x1) / 2, y0 - 20);
    ctx.fillText(`BACK · ${MATERIALS[room.materials.back]?.name || ''} · ${room.width.toFixed(2)} m`, (x0 + x1) / 2, y1 + 20);
    ctx.save();
    ctx.translate(x0 - 20, (y0 + y1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`LEFT · ${MATERIALS[room.materials.left]?.name || ''}`, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(x1 + 20, (y0 + y1) / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(`RIGHT · ${MATERIALS[room.materials.right]?.name || ''} · ${room.depth.toFixed(2)} m`, 0, 0);
    ctx.restore();

    const objs = this._objects();
    const lis = s.listener;
    const [lx, ly] = this.px(lis.x, lis.z);
    const c = roomSpeedOfSound(room);
    // Waves
    const now = t;
    this.waves = this.waves.filter((wv) => now - wv.born < 2600);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    for (const wv of this.waves) {
      const age = (now - wv.born) / 1000;
      const rad = age * 1.6 * g.scale;
      const alpha = (1 - age / 2.6) * 0.35 * wv.s;
      const [wx, wy] = this.px(wv.x, wv.z);
      ctx.strokeStyle = wv.sub ? `rgba(255,107,154,${alpha})` : `rgba(141,125,255,${alpha})`;
      ctx.lineWidth = wv.sub ? 3 : 1.5;
      ctx.beginPath();
      ctx.arc(wx, wy, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    // Rays & reflections
    if (s.ui.showRays !== false) {
      const placed = [];
      for (const o of objs) {
        if (o.type === 'listener') continue;
        const [ox, oy] = this.px(o.x, o.z);
        const dist = Math.hypot(o.x - lis.x, (o.src.y ?? 1) - (lis.y ?? 1.15), o.z - lis.z);
        ctx.strokeStyle = o.type === 'sub' ? 'rgba(255,107,154,0.35)' : 'rgba(141,125,255,0.4)';
        ctx.setLineDash([4, 5]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(lx, ly);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = `${dist.toFixed(2)} m · ${((dist / c) * 1000).toFixed(1)} ms`;
        ctx.font = '600 10px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(label).width + 10;
        // Place the label along the ray, sliding it to avoid overlapping others.
        let mx = 0;
        let my = 0;
        for (const f of [0.45, 0.3, 0.6, 0.2, 0.7]) {
          mx = ox + (lx - ox) * f;
          my = oy + (ly - oy) * f;
          const box = { x: mx - tw / 2, y: my - 8, w: tw, h: 16 };
          if (!placed.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) {
            placed.push(box);
            break;
          }
        }
        ctx.fillStyle = 'rgba(10,10,16,0.8)';
        ctx.fillRect(mx - tw / 2, my - 8, tw, 16);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.textAlign = 'center';
        ctx.fillText(label, mx, my);
      }
      // First reflections of the selected speaker (mirror-point method).
      const sel = objs.find((o) => o.type === 'speaker' && o.id === this.selected.id && this.selected.type === 'speaker');
      if (sel) {
        const mirrors = [
          { wall: 'left', p: { x: -sel.x, z: sel.z } },
          { wall: 'right', p: { x: 2 * room.width - sel.x, z: sel.z } },
          { wall: 'front', p: { x: sel.x, z: -sel.z } },
          { wall: 'back', p: { x: sel.x, z: 2 * room.depth - sel.z } },
        ];
        for (const m of mirrors) {
          // Intersection of line (mirror → listener) with the wall.
          let rp;
          if (m.wall === 'left' || m.wall === 'right') {
            const wx = m.wall === 'left' ? 0 : room.width;
            const tt = (wx - m.p.x) / (lis.x - m.p.x);
            rp = { x: wx, z: m.p.z + (lis.z - m.p.z) * tt };
          } else {
            const wz = m.wall === 'front' ? 0 : room.depth;
            const tt = (wz - m.p.z) / (lis.z - m.p.z);
            rp = { x: m.p.x + (lis.x - m.p.x) * tt, z: wz };
          }
          if (!(rp.x >= 0 && rp.x <= room.width && rp.z >= 0 && rp.z <= room.depth)) continue;
          const [sx, sy] = this.px(sel.x, sel.z);
          const [rx, ry] = this.px(rp.x, rp.z);
          ctx.strokeStyle = 'rgba(255,181,71,0.55)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(rx, ry);
          ctx.lineTo(lx, ly);
          ctx.stroke();
          ctx.fillStyle = '#ffb547';
          ctx.beginPath();
          ctx.arc(rx, ry, 5, 0, Math.PI * 2);
          ctx.fill();
          const pathLen = Math.hypot(sel.x - rp.x, sel.z - rp.z) + Math.hypot(rp.x - lis.x, rp.z - lis.z);
          const direct = Math.hypot(sel.x - lis.x, sel.z - lis.z);
          ctx.fillStyle = 'rgba(255,215,154,0.9)';
          ctx.font = '600 9.5px Inter, system-ui, sans-serif';
          ctx.textAlign = m.wall === 'left' ? 'left' : m.wall === 'right' ? 'right' : 'center';
          const off = m.wall === 'left' ? 8 : m.wall === 'right' ? -8 : 0;
          const offy = m.wall === 'front' ? 12 : m.wall === 'back' ? -12 : 0;
          ctx.fillText(`+${(((pathLen - direct) / c) * 1000).toFixed(1)} ms`, rx + off, ry + offy);
        }
      }
    }
    // Objects
    const selKey = `${this.selected.type}:${this.selected.id}`;
    for (const o of objs) {
      const [cx, cy] = this.px(o.x, o.z);
      const isSel = selKey === `${o.type}:${o.id}`;
      const isHover = this.hover === `${o.type}:${o.id}`;
      ctx.save();
      ctx.translate(cx, cy);
      if (o.type === 'listener') {
        this._drawListener(ctx, o, isSel, t);
      } else {
        ctx.rotate((o.yaw * Math.PI) / 180);
        this._drawSource(ctx, o, g.scale, isSel || isHover);
      }
      ctx.restore();
      if (o.type !== 'listener') {
        // Labels
        ctx.font = '800 10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = o.src.muted ? 'rgba(255,255,255,0.35)' : '#fff';
        const lab = o.type === 'sub' ? 'SUB' : o.src.channel;
        const r = Math.max(o.w, o.d) * g.scale * 0.5;
        ctx.fillText(lab, cx, cy - r - 12);
        if (o.type === 'sub' && (s.room.boundary || s.room.modes)) {
          const bg = boundaryGain(room, o.src);
          const info = this.app.engine.roomInfo?.results?.[o.id];
          const db = s.room.modes && info ? info.boundaryDb : bg.gainDb;
          const txt = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB loading`;
          ctx.font = '700 9.5px Inter, system-ui, sans-serif';
          const tw = ctx.measureText(txt).width + 10;
          ctx.fillStyle = db > 5 ? 'rgba(255,107,154,0.85)' : 'rgba(40,40,56,0.9)';
          ctx.fillRect(cx - tw / 2, cy + r + 6, tw, 15);
          ctx.fillStyle = '#fff';
          ctx.fillText(txt, cx, cy + r + 14);
        }
      }
      if (isSel && this._rotatable(o)) {
        const [hx, hy] = this._handlePos(o);
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#36e2cf';
        ctx.beginPath();
        ctx.arc(hx, hy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0a0a10';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    // Haptic pulses around the listener
    this.pulses = this.pulses.filter((p) => t - p.born < 600);
    for (const p of this.pulses) {
      const age = (t - p.born) / 600;
      ctx.strokeStyle = `rgba(255,107,154,${(1 - age) * 0.7})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(lx, ly, 18 + age * 40 * (0.5 + p.s), 0, Math.PI * 2);
      ctx.stroke();
    }
    // Scale bar
    const sbm = g.scale > 60 ? 1 : 2;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(x0, y1 + 34, sbm * g.scale, 2);
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${sbm} m`, x0 + sbm * g.scale + 6, y1 + 35);
  }

  _drawSource(ctx, o, scale, highlight) {
    const w = Math.max(o.w * scale, 16);
    const d = Math.max(o.d * scale, 14);
    const st = o.hw?.style || { cabinet: '#222', woofer: '#444', accent: '#999' };
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = st.cabinet;
    ctx.strokeStyle = highlight ? '#fff' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = highlight ? 2 : 1;
    const r = 3;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-w / 2, -d / 2, w, d, r);
    else ctx.rect(-w / 2, -d / 2, w, d);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    // Front baffle edge (towards -y in local coords = facing direction)
    ctx.fillStyle = o.type === 'sub' ? '#ff6b9a' : '#8d7dff';
    ctx.fillRect(-w / 2 + 2, -d / 2, w - 4, 3);
    if (o.type === 'sub') {
      ctx.fillStyle = st.woofer;
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(w, d) * 0.32, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.arc(0, -d / 2 + 6, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (o.src.muted) {
      ctx.strokeStyle = '#ff5470';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-w / 2, -d / 2);
      ctx.lineTo(w / 2, d / 2);
      ctx.stroke();
    }
  }

  _drawListener(ctx, o, sel, t) {
    const r = Math.max(13, HEAD_R * this.geo.scale);
    ctx.rotate((o.yaw * Math.PI) / 180);
    if (sel) {
      ctx.strokeStyle = 'rgba(54,226,207,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r + 8 + Math.sin(t / 300) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Shoulders
    ctx.fillStyle = '#23233a';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.45, r * 1.9, r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    const hg = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 1, 0, 0, r);
    hg.addColorStop(0, '#9ff3e8');
    hg.addColorStop(1, '#23a597');
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    ctx.fillStyle = '#1b8f83';
    ctx.beginPath();
    ctx.ellipse(-r, 0, r * 0.22, r * 0.38, 0, 0, Math.PI * 2);
    ctx.ellipse(r, 0, r * 0.22, r * 0.38, 0, 0, Math.PI * 2);
    ctx.fill();
    // Nose (facing)
    ctx.fillStyle = '#e8fffb';
    ctx.beginPath();
    ctx.moveTo(0, -r - 7);
    ctx.lineTo(-5, -r + 2);
    ctx.lineTo(5, -r + 2);
    ctx.closePath();
    ctx.fill();
  }

  destroy() {
    this.offFrame();
    this.offStore();
    this.offPulse();
    this.ro.disconnect();
    this.removeAll();
  }
}
