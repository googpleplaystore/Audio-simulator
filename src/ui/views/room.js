// Room Simulator: interactive placement + room/acoustics settings.

import { h, icon, clear, viewDebounce } from '../dom.js';
import { RoomEditor } from '../../viz/roomCanvas.js';
import { ResponsePlot } from '../../viz/responsePlot.js';
import { sliderRow, toggle, select, segmented, numberInput, knob } from '../components/controls.js';
import { toast, confirmDialog } from '../components/overlays.js';
import { pickModel, specLine } from '../components/modelPicker.js';
import { hardwareSvg } from '../hardwareArt.js';
import { getHardware } from '../../hardware/index.js';
import { MATERIALS, MATERIAL_IDS, BANDS } from '../../acoustics/materials.js';
import {
  ROOM_PRESETS, roomFromPreset, defaultLayout, rt60Bands, schroederFrequency, criticalDistance, volume, meanAlpha, roomModes, boundaryGain, modalCrossover,
} from '../../acoustics/room.js';
import { makeSpeaker, makeSub } from '../../core/settings.js';
import { aimYaw } from '../../audio/plan.js';
import { Response, cascadeMagnitudeDb } from '../../dsp/biquad.js';
import { octaveGrid, clamp } from '../../util/math.js';
import { formatHz } from '../../util/format.js';

const CHANNELS = [
  { value: 'L', label: 'Left (L)' },
  { value: 'R', label: 'Right (R)' },
  { value: 'C', label: 'Center (C)' },
  { value: 'SL', label: 'Surround L' },
  { value: 'SR', label: 'Surround R' },
  { value: 'M', label: 'Mono (L+R)' },
];

export function roomView(app, params, query, disposer) {
  const store = app.store;
  const canvas = h('canvas.room-canvas', { 'aria-label': 'Room editor. Drag speakers, subwoofers and the listener.' });
  const editor = new RoomEditor(canvas, app);
  disposer.add(() => editor.destroy());
  const inspector = h('div.inspector-body');
  let tab = 'selection';
  const tabs = segmented(
    [
      { value: 'selection', label: 'Selection' },
      { value: 'room', label: 'Room' },
      { value: 'acoustics', label: 'Acoustics' },
    ],
    tab,
    (v) => {
      tab = v;
      renderInspector();
    },
  );
  const heatInfo = h('div.heat-legend', { hidden: true });

  // ------------------------------------------------ toolbar
  const addSpeaker = () => {
    const s = store.state;
    const used = new Set(s.speakers.map((x) => x.channel));
    const channel = ['L', 'R', 'C', 'SL', 'SR'].find((c) => !used.has(c)) || 'M';
    const id = `spk-${Date.now().toString(36)}`;
    const lay = defaultLayout(s.room);
    const pos = channel === 'C' ? { x: s.room.width / 2, y: 1, z: lay.left.z } : channel === 'SL' ? { x: 0.35, y: 1.2, z: clamp(s.listener.z + 0.3, 0.3, s.room.depth - 0.3) } : channel === 'SR' ? { x: s.room.width - 0.35, y: 1.2, z: clamp(s.listener.z + 0.3, 0.3, s.room.depth - 0.3) } : channel === 'L' ? lay.left : channel === 'R' ? lay.right : { x: s.room.width / 2, y: 1, z: 1 };
    const model = s.speakers[0]?.modelId;
    store.set('speakers', [...s.speakers, makeSpeaker(id, channel, pos, model)]);
    editor.select({ type: 'speaker', id });
    toast(`Added ${channel} speaker`);
  };
  const addSub = () => {
    const s = store.state;
    const corners = [
      { x: 0.3, z: 0.3 },
      { x: s.room.width - 0.3, z: 0.3 },
      { x: 0.3, z: s.room.depth - 0.3 },
      { x: s.room.width - 0.3, z: s.room.depth - 0.3 },
    ];
    const free = corners.find((c) => !s.subs.some((sb) => Math.hypot(sb.x - c.x, sb.z - c.z) < 0.5)) || { x: s.room.width / 2, z: 0.35 };
    const id = `sub-${Date.now().toString(36)}`;
    store.set('subs', [...s.subs, makeSub(id, { ...free, y: 0.25 }, s.subs[0]?.modelId)]);
    editor.select({ type: 'sub', id });
    toast('Added subwoofer');
  };
  const triangle = () => {
    const s = store.state;
    const lay = defaultLayout(s.room);
    const L = s.speakers.find((x) => x.channel === 'L');
    const R = s.speakers.find((x) => x.channel === 'R');
    if (L) store.updateItem('speakers', L.id, { x: lay.left.x, z: lay.left.z, aim: true });
    if (R) store.updateItem('speakers', R.id, { x: lay.right.x, z: lay.right.z, aim: true });
    store.patch('listener', { x: lay.listener.x, z: lay.listener.z, yaw: 0 });
    toast('Arranged an equilateral stereo triangle');
  };
  const aimAll = () => {
    for (const sp of store.state.speakers) store.updateItem('speakers', sp.id, { aim: true });
    toast('All speakers toed-in towards the listener');
  };
  const heatToggle = toggle('Bass heatmap', store.get('ui.heatmap'), (v) => store.set('ui.heatmap', v), 'Predicted low-frequency level across the room (modal model)');
  const raysToggle = toggle('Rays', store.get('ui.showRays') !== false, (v) => store.set('ui.showRays', v), 'Direct paths and first reflections');
  const snapToggle = toggle('Snap', store.get('ui.snap'), (v) => store.set('ui.snap', v), 'Snap to 5 cm grid (hold Alt to bypass)');
  const presetSel = select(
    [{ value: 'custom', label: 'Custom room' }, ...Object.entries(ROOM_PRESETS).map(([k, v]) => ({ value: k, label: v.name }))],
    ROOM_PRESETS[store.get('room.preset')] ? store.get('room.preset') : 'custom',
    (v) => applyPreset(v),
    { 'aria-label': 'Room preset' },
  );
  const applyPreset = async (id) => {
    if (id === 'custom') return;
    const r = roomFromPreset(id);
    const cur = store.state.room;
    store.set('room', { ...cur, ...r, reverb: cur.reverb });
    const relayout = await confirmDialog('Re-arrange speakers?', 'Place the speakers, subwoofer and listener in a recommended layout for this room?', { ok: 'Re-arrange' });
    const lay = defaultLayout(r);
    if (relayout) {
      const L = store.state.speakers.find((x) => x.channel === 'L');
      const R = store.state.speakers.find((x) => x.channel === 'R');
      if (L) store.updateItem('speakers', L.id, { x: lay.left.x, y: lay.left.y, z: lay.left.z });
      if (R) store.updateItem('speakers', R.id, { x: lay.right.x, y: lay.right.y, z: lay.right.z });
      if (store.state.subs[0]) store.updateItem('subs', store.state.subs[0].id, { x: lay.sub.x, z: lay.sub.z });
      store.patch('listener', { x: lay.listener.x, y: lay.listener.y, z: lay.listener.z });
    }
    clampAll();
    toast(`Room: ${ROOM_PRESETS[id].name}`);
  };
  const clampAll = () => {
    const r = store.state.room;
    const fix = (o) => ({ x: clamp(o.x, 0.1, r.width - 0.1), z: clamp(o.z, 0.1, r.depth - 0.1), y: clamp(o.y ?? 1, 0.1, r.height - 0.1) });
    for (const s of store.state.speakers) store.updateItem('speakers', s.id, fix(s));
    for (const s of store.state.subs) store.updateItem('subs', s.id, fix(s));
    store.patch('listener', fix(store.state.listener));
  };

  const toolbar = h(
    'div.room-toolbar',
    h('div.split', icon('room', 18), presetSel),
    h('button.btn.small', { onClick: addSpeaker }, icon('speaker', 15), 'Speaker'),
    h('button.btn.small', { onClick: addSub }, icon('sub', 15), 'Subwoofer'),
    h('button.btn.small.ghost', { onClick: triangle, 'data-tip': 'Equilateral stereo triangle' }, icon('target', 15), 'Triangle'),
    h('button.btn.small.ghost', { onClick: aimAll, 'data-tip': 'Toe-in all speakers to the listener' }, icon('crossover', 15), 'Aim'),
    h('div.grow'),
    heatToggle,
    raysToggle,
    snapToggle,
  );

  // ------------------------------------------------ heatmap
  const computeHeat = viewDebounce(disposer, async () => {
    const s = store.state;
    if (!s.ui.heatmap) {
      editor.setHeatmap(null);
      heatInfo.hidden = true;
      return;
    }
    const plan = app.engine.plan;
    if (!plan) return;
    const freqs = [...octaveGrid(25, 120, 6)];
    const sources = [];
    for (const src of plan.sources) {
      if (!src.active) continue;
      const r = new Response(freqs, plan.sampleRate)
        .filter(src.kind === 'sub' ? plan.lfeSpecs : src.hpfSpecs)
        .filter(src.modelSpecs)
        .gain(src.trimGain * src.polarity * src.sensGain)
        .delay(src.alignDelay + src.manualDelay);
      sources.push({ pos: src.pos, freqs, re: Array.from(r.re), im: Array.from(r.im) });
    }
    const cols = 56;
    const rows = Math.max(12, Math.round((cols * s.room.depth) / s.room.width));
    heatInfo.hidden = false;
    heatInfo.textContent = 'Computing bass map…';
    const res = await app.acoustics.run('heatmap', { room: s.room, sources, cols, rows, height: s.listener.y ?? 1.15, freqs }, 'heatmap');
    if (!res) return;
    const ci = clamp(Math.floor((s.listener.x / s.room.width) * cols), 0, cols - 1);
    const ri = clamp(Math.floor((s.listener.z / s.room.depth) * rows), 0, rows - 1);
    const ref = res.data[ri * cols + ci];
    let min = Infinity;
    let max = -Infinity;
    for (const v of res.data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    editor.setHeatmap({ ...res, ref });
    clear(heatInfo);
    heatInfo.append(
      h('div.heat-bar'),
      h('div.split', h('span', '−12 dB'), h('span.grow', { style: { textAlign: 'center' } }, 'relative to your seat (25–120 Hz)'), h('span', '+12 dB')),
      h('div.dim', `Range across room: ${(min - ref).toFixed(1)} … +${(max - ref).toFixed(1)} dB`),
    );
  }, 200);
  disposer.add(store.subscribe(['ui.heatmap', 'room', 'speakers', 'subs', 'listener', 'crossover', 'eq'], computeHeat));
  computeHeat();

  // ------------------------------------------------ inspector
  const renderInspector = () => {
    clear(inspector);
    if (tab === 'room') return inspector.appendChild(roomPanel(app));
    if (tab === 'acoustics') return inspector.appendChild(acousticsPanel(app));
    const sel = editor.selected;
    if (sel.type === 'speaker' || sel.type === 'sub') inspector.appendChild(sourcePanel(app, sel, editor, () => setTimeout(renderInspector, 0)));
    else if (sel.type === 'listener') inspector.appendChild(listenerPanel(app));
    else if (sel.type === 'wall') inspector.appendChild(wallPanel(app, sel.id));
    else inspector.appendChild(h('div.stack', h('p.dim', 'Select a speaker, subwoofer, wall or the listener to edit it. Drag to move; use the teal handle to rotate.'), roomPanel(app)));
  };
  editor.on('select', () => {
    if (tab !== 'selection') {
      tab = 'selection';
      tabs.setValue(tab);
    }
    renderInspector();
  });
  editor.on('pick-model', async (o) => {
    const id = await pickModel(o.type === 'sub' ? 'subwoofer' : 'bookshelf', o.src.modelId);
    if (id) store.updateItem(o.type === 'sub' ? 'subs' : 'speakers', o.id, { modelId: id });
  });
  editor.on('delete', (o) => removeSource(app, o.type, o.id, editor));
  // Re-render inspector values on external changes (canvas drags, other
  // views) — never while the user is interacting with the inspector itself,
  // which would recreate a control mid-drag.
  const rerender = viewDebounce(disposer, () => {
    if (inspector.contains(document.activeElement) || inspector.querySelector('.dragging')) return;
    renderInspector();
  }, 120);
  disposer.add(store.subscribe(['speakers', 'subs', 'listener', 'room'], (changed) => {
    if (editor.drag) return; // live values are updated in-place by panels
    rerender(changed);
  }));
  editor.on('moved', () => renderInspector());
  disposer.add(app.engine.on('room-filters', () => {
    editor.dirty = true;
    if (tab === 'selection') rerender();
  }));
  renderInspector();

  const el = h(
    'div.view-inner.room-view',
    h('div.page-head', h('div', h('h1', 'Room Simulator'), h('div.muted', 'Drag hardware and yourself around the room. Everything you hear updates live — distance, toe-in, boundary loading, room modes, reverb.'))),
    h('div.room-layout',
      h('div.room-stage', toolbar, h('div.room-canvas-wrap', canvas, heatInfo), h('div.room-hint.dim', 'Tips: double-click a speaker to change model · arrows nudge (Shift = 25 cm) · [ ] rotate · Delete removes · click a wall to change its material')),
      h('aside.inspector', h('div.inspector-tabs', tabs), inspector),
    ),
  );
  return { el, title: 'Room Simulator', mounted: () => canvas.focus({ preventScroll: true }) };
}

async function removeSource(app, type, id, editor) {
  const list = type === 'sub' ? 'subs' : 'speakers';
  app.store.set(list, app.store.get(list).filter((x) => x.id !== id));
  editor.select({ type: 'listener', id: 'listener' });
  toast(type === 'sub' ? 'Subwoofer removed' : 'Speaker removed');
}

function posInputs(app, obj, apply) {
  const room = app.store.state.room;
  return h('div.pos-grid',
    h('div.field', h('label', 'X (m)'), numberInput(obj.x, { min: 0.05, max: room.width - 0.05, step: 0.05, onChange: (v) => apply({ x: v }) })),
    h('div.field', h('label', 'Depth (m)'), numberInput(obj.z, { min: 0.05, max: room.depth - 0.05, step: 0.05, onChange: (v) => apply({ z: v }) })),
    h('div.field', h('label', 'Height (m)'), numberInput(obj.y ?? 1, { min: 0.05, max: room.height - 0.05, step: 0.05, onChange: (v) => apply({ y: v }) })),
  );
}

const STRUCTURAL = new Set(['aim', 'modelId', 'channel', 'muted', 'solo', 'polarity']);

function sourcePanel(app, sel, editor, refresh) {
  const store = app.store;
  const isSub = sel.type === 'sub';
  const listKey = isSub ? 'subs' : 'speakers';
  const src = store.get(listKey).find((x) => x.id === sel.id);
  if (!src) return h('div.dim', 'Nothing selected');
  const hw = getHardware(src.modelId);
  const apply = (patch) => {
    store.updateItem(listKey, src.id, patch);
    if (Object.keys(patch).some((k) => STRUCTURAL.has(k))) refresh();
  };
  const plan = app.engine.plan?.sources.find((p) => p.id === src.id);
  const lis = store.state.listener;
  const dist = Math.hypot(src.x - lis.x, (src.y ?? 1) - (lis.y ?? 1.15), src.z - lis.z);
  const bg = boundaryGain(store.state.room, src);
  const roomRes = app.engine.roomInfo?.results?.[src.id];
  const card = h('div.model-card',
    h('div.model-art', { html: hardwareSvg(hw, { width: 70 }) }),
    h('div.grow.ellipsis',
      h('div.hero-kind', isSub ? 'Subwoofer' : `Speaker · ${src.channel}`),
      h('h3.ellipsis', hw.name),
      h('div.dim', { style: { fontSize: '12px' } }, specLine(hw)),
      h('div.split', { style: { marginTop: '8px', gap: '6px' } },
        h('button.btn.small', { onClick: async () => { const id = await pickModel(isSub ? 'subwoofer' : 'bookshelf', src.modelId); if (id) apply({ modelId: id }); } }, icon('refresh', 14), 'Change'),
        h('a.btn.small.ghost', { href: `#/studio/hardware/${hw.id}` }, 'Specs'),
      ),
    ),
  );
  const stats = h('div.mini-stats',
    stat('Distance', `${dist.toFixed(2)} m`),
    stat('Arrival', `${((dist / 343) * 1000).toFixed(1)} ms`),
    isSub ? stat('Loading', `${(roomRes?.boundaryDb ?? bg.gainDb) >= 0 ? '+' : ''}${(roomRes?.boundaryDb ?? bg.gainDb).toFixed(1)} dB`) : stat('Off-axis', `${(plan?.offAxisDeg ?? 0).toFixed(0)}°`),
    stat('Amp', `${Math.round(plan?.ampWatts ?? 0)} W`),
  );
  const body = h('div.stack', card, stats);
  if (!isSub) {
    body.append(
      h('div.field', h('label', 'Channel'), select(CHANNELS, src.channel, (v) => apply({ channel: v }))),
      toggle('Aim at listener (auto toe-in)', src.aim !== false, (v) => apply({ aim: v, yaw: v ? src.yaw : Math.round(aimYaw(src, lis)) })),
    );
    if (src.aim === false) body.append(sliderRow('Rotation', { min: 0, max: 359, step: 1, value: ((src.yaw % 360) + 360) % 360, format: (v) => `${Math.round(v)}°`, onInput: (v) => apply({ yaw: v }) }));
  }
  body.append(posInputs(app, src, apply));
  body.append(sliderRow('Level trim', { min: -12, max: 12, step: 0.5, value: src.trimDb || 0, reset: 0, bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`, onInput: (v) => apply({ trimDb: v }) }));
  body.append(sliderRow('Extra delay', { min: 0, max: 20, step: 0.1, value: src.delayMs || 0, reset: 0, format: (v) => `${v.toFixed(1)} ms`, onInput: (v) => apply({ delayMs: v }) }));
  if (isSub) {
    body.append(
      h('div.split', { style: { justifyContent: 'space-around', padding: '6px 0' } },
        knob({ label: 'Phase', min: 0, max: 180, step: 1, value: src.phaseDeg || 0, reset: 0, size: 60, format: (v) => `${Math.round(v)}°`, onInput: (v) => apply({ phaseDeg: v }) }),
        h('div.field', h('label', 'Polarity'), segmented([{ value: 0, label: '0°' }, { value: 180, label: '180°' }], src.polarity || 0, (v) => apply({ polarity: Number(v) }))),
      ),
    );
    if (roomRes && roomRes.freqs) {
      const cv = h('canvas.mini-plot');
      body.append(h('div.field', h('label', 'Modal room response at your seat'), cv));
      requestAnimationFrame(() => {
        const plot = new ResponsePlot(cv, { fMin: 15, fMax: Math.max(...roomRes.freqs), dbMin: -24, dbMax: 24, dbStep: 12 });
        plot.pad.l = 30;
        const fitted = cascadeMagnitudeDb(roomRes.filters, roomRes.freqs);
        plot.setCurves([
          { freqs: roomRes.freqs, db: roomRes.target, color: 'rgba(255,255,255,0.45)', width: 1.5, label: 'Modal sum' },
          { freqs: roomRes.freqs, db: fitted, color: '#ff6b9a', width: 2, label: 'Applied filter' },
        ]);
      });
    }
  }
  body.append(
    h('div.split',
      toggle('Mute', !!src.muted, (v) => apply({ muted: v })),
      toggle('Solo', !!src.solo, (v) => apply({ solo: v })),
      h('div.grow'),
      h('button.btn.small.danger', { onClick: () => removeSource(app, sel.type, src.id, editor) }, icon('trash', 14), 'Remove'),
    ),
  );
  return body;
}

function stat(label, value) {
  return h('div.stat', h('div.stat-value', { style: { fontSize: '16px' } }, value), h('div.stat-label', label));
}

function listenerPanel(app) {
  const store = app.store;
  const l = store.state.listener;
  const room = store.state.room;
  const apply = (p) => store.patch('listener', p);
  const bg = boundaryGain(room, l);
  return h('div.stack',
    h('div.model-card', h('div.listener-badge', icon('headphones', 26)), h('div', h('div.hero-kind', 'Listener'), h('h3', 'You'), h('div.dim', { style: { fontSize: '12px' } }, `Ear height ${(l.y ?? 1.15).toFixed(2)} m · facing ${Math.round(l.yaw || 0)}°`))),
    posInputs(app, l, apply),
    sliderRow('Facing', { min: -180, max: 180, step: 1, value: l.yaw || 0, reset: 0, bipolar: true, format: (v) => `${Math.round(v)}°`, onInput: (v) => apply({ yaw: v }) }),
    h('div.split.wrap',
      h('button.btn.small', { onClick: () => apply({ x: room.width / 2, z: room.depth * 0.38, yaw: 0 }) }, '38% rule (front)'),
      h('button.btn.small', { onClick: () => apply({ x: room.width / 2, z: room.depth * 0.62, yaw: 0 }) }, '38% rule (back)'),
      h('button.btn.small.ghost', { onClick: () => apply({ x: room.width / 2 }) }, 'Center'),
    ),
    h('div.field', h('label', 'Listening on'), segmented([{ value: 'headphones', label: 'Headphones (binaural HRTF)' }, { value: 'speakers', label: 'Speakers' }], store.get('engine.output'), (v) => store.set('engine.output', v))),
    bg.gainDb > 0.5 ? h('div.banner', icon('info', 16), `Sitting close to a wall adds ≈ +${bg.gainDb.toFixed(1)} dB of bass pressure build-up.`) : null,
  );
}

function wallPanel(app, wall) {
  const store = app.store;
  const room = store.state.room;
  const mat = room.materials[wall];
  const bars = h('div.alpha-bars', BANDS.map((f, i) => h('div.alpha-bar', h('i', { style: { height: `${MATERIALS[mat].alpha[i] * 100}%` } }), h('span', formatHz(f).replace(' Hz', '').replace(' kHz', 'k')))));
  return h('div.stack',
    h('h3', `${wall[0].toUpperCase()}${wall.slice(1)} surface`),
    h('div.field', h('label', 'Material'), select(MATERIAL_IDS.map((id) => ({ value: id, label: MATERIALS[id].name })), mat, (v) => { store.set(`room.materials.${wall}`, v); store.set('room.preset', 'custom'); })),
    h('div.field', h('label', 'Absorption coefficient α per octave'), bars),
    h('p.dim', { style: { fontSize: '12px' } }, 'High α absorbs sound (shorter reverb, less HF). Low α reflects it. Porous materials only work at high frequencies; bass needs thick traps or membranes.'),
    h('div.field', h('label', 'Apply to'), h('div.split.wrap',
      h('button.btn.small', { onClick: () => { for (const w of ['front', 'back', 'left', 'right']) store.set(`room.materials.${w}`, mat); store.set('room.preset', 'custom'); } }, 'All walls'),
      h('button.btn.small', { onClick: () => { store.set('room.materials.ceiling', mat); store.set('room.preset', 'custom'); } }, 'Ceiling'),
      h('button.btn.small', { onClick: () => { store.set('room.materials.floor', mat); store.set('room.preset', 'custom'); } }, 'Floor'),
    )),
  );
}

function roomPanel(app) {
  const store = app.store;
  const room = store.state.room;
  const setDim = (k) => (v) => {
    store.set(`room.${k}`, Math.round(v * 100) / 100);
    store.set('room.preset', 'custom');
    const r = store.state.room;
    for (const s of store.state.speakers) store.updateItem('speakers', s.id, { x: clamp(s.x, 0.1, r.width - 0.1), z: clamp(s.z, 0.1, r.depth - 0.1), y: clamp(s.y ?? 1, 0.1, r.height - 0.1) });
    for (const s of store.state.subs) store.updateItem('subs', s.id, { x: clamp(s.x, 0.1, r.width - 0.1), z: clamp(s.z, 0.1, r.depth - 0.1) });
    const l = store.state.listener;
    store.patch('listener', { x: clamp(l.x, 0.2, r.width - 0.2), z: clamp(l.z, 0.2, r.depth - 0.2), y: clamp(l.y ?? 1.15, 0.2, r.height - 0.1) });
  };
  const matSel = (surface) => h('div.field', h('label', surface), select(MATERIAL_IDS.map((id) => ({ value: id, label: MATERIALS[id].name })), room.materials[surface], (v) => { store.set(`room.materials.${surface}`, v); store.set('room.preset', 'custom'); }));
  return h('div.stack',
    h('h3', 'Dimensions'),
    sliderRow('Width', { min: 2, max: 60, step: 0.1, value: room.width, log: true, format: (v) => `${v.toFixed(1)} m`, onInput: setDim('width') }),
    sliderRow('Depth', { min: 2, max: 80, step: 0.1, value: room.depth, log: true, format: (v) => `${v.toFixed(1)} m`, onInput: setDim('depth') }),
    sliderRow('Height', { min: 2, max: 30, step: 0.1, value: room.height, log: true, format: (v) => `${v.toFixed(1)} m`, onInput: setDim('height') }),
    sliderRow('Temperature', { min: -10, max: 40, step: 1, value: room.temperature ?? 20, reset: 20, format: (v) => `${v} °C`, onInput: (v) => store.set('room.temperature', v) }),
    h('h3', { style: { marginTop: '6px' } }, 'Surfaces'),
    h('div.mat-grid', ['front', 'back', 'left', 'right', 'floor', 'ceiling'].map(matSel)),
  );
}

function acousticsPanel(app) {
  const store = app.store;
  const room = store.state.room;
  const rt = rt60Bands(room);
  const maxRt = Math.max(...rt, 0.5);
  const bars = h('div.rt-bars', BANDS.map((f, i) => h('div.rt-bar', { 'data-tip': `${formatHz(f)}: ${rt[i].toFixed(2)} s` }, h('i', { style: { height: `${(rt[i] / maxRt) * 100}%` } }), h('span', f >= 1000 ? `${f / 1000}k` : String(f)))));
  const alpha = meanAlpha(room);
  const modes = roomModes(room, 200).filter((m) => m.kind !== 'pressure').slice(0, 14);
  return h('div.stack',
    h('div.mini-stats',
      stat('RT60 (mid)', `${((rt[3] + rt[4]) / 2).toFixed(2)} s`),
      stat('Volume', `${Math.round(volume(room))} m³`),
      stat('Schroeder', formatHz(schroederFrequency(room))),
      stat('Crit. distance', `${criticalDistance(room).toFixed(2)} m`),
    ),
    h('div.field', h('label', 'Reverberation time RT60 by octave (Eyring)'), bars),
    h('div.dim', { style: { fontSize: '12px' } }, `Mean absorption ᾱ(1 kHz) = ${alpha[4].toFixed(2)} · modal/diffuse crossover ≈ ${formatHz(modalCrossover(room))}`),
    h('h3', 'Simulation'),
    toggle('Modal bass model (standing waves)', room.modes, (v) => store.set('room.modes', v), 'Full modal-sum model of the room below the Schroeder frequency — includes corner loading and seat-dependent peaks/nulls'),
    toggle('Boundary gain (simple model)', room.boundary, (v) => store.set('room.boundary', v), 'Used when the modal model is off: +3 dB per nearby wall, corner coupling'),
    toggle('Convolution reverb (image-source + diffuse tail)', room.reverb.enabled, (v) => store.set('room.reverb.enabled', v)),
    sliderRow('Reverb level', { min: -24, max: 12, step: 0.5, value: room.reverb.wetDb, reset: 0, bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`, onInput: (v) => store.set('room.reverb.wetDb', v) }),
    sliderRow('Reflection order', { min: 1, max: 5, step: 1, value: room.reverb.erOrder ?? 3, format: (v) => `${v}`, onInput: (v, final) => final && store.set('room.reverb.erOrder', v) }),
    toggle('Propagation delay (speed of sound)', room.propagation, (v) => store.set('room.propagation', v)),
    toggle('Speaker directivity (off-axis HF loss)', room.directivity, (v) => store.set('room.directivity', v)),
    toggle('Air absorption', room.airAbsorption, (v) => store.set('room.airAbsorption', v)),
    h('h3', 'Lowest room modes'),
    h('div.mode-list', modes.map((m) => h('div.mode', h('span.mono', `${m.f.toFixed(1)} Hz`), h('span.badge', { class: m.kind === 'axial' ? 'accent' : m.kind === 'tangential' ? 'teal' : '' }, m.kind), h('span.dim.mono', `(${m.nx},${m.nz},${m.ny})`)))),
  );
}
