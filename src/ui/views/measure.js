// Measurements: virtual log-sweep measurements at the listening position
// (SPL/phase, group delay, impulse/step/ETC, RT60, waterfall, distortion),
// overlays, REW-compatible export and one-click sweep-based auto-EQ.

import { h, icon, clear } from '../dom.js';
import { sliderRow, segmented, select } from '../components/controls.js';
import { toast, promptDialog, openMenu, confirmDialog } from '../components/overlays.js';
import { ResponsePlot } from '../../viz/responsePlot.js';
import { XYPlot, WaterfallPlot, BarsPlot } from '../../viz/plots.js';
import { runSweepMeasurement, frequencyResponse, stepResponse, energyTimeCurve, decayAnalysis, waterfall, distortion, summarize } from '../../audio/measure.js';
import { computeRoomCorrection, measurementState } from '../../audio/calibration.js';
import { encodeWav } from '../../audio/wav.js';
import { getHardware } from '../../hardware/index.js';
import { ROOM_PRESETS } from '../../acoustics/room.js';
import { BANDS } from '../../acoustics/materials.js';
import { Emitter } from '../../util/emitter.js';
import { uid } from '../../util/hash.js';
import { formatHz } from '../../util/format.js';

const COLORS = ['#8d7dff', '#36e2cf', '#ff6b9a', '#ffb547', '#7cd66b', '#5aa9ff', '#ff8a5c', '#d98cff'];
const KV_KEY = 'measurements';
const MAX_ITEMS = 12;

/** Session + IndexedDB persisted list of measurements, with an analysis cache. */
export class MeasurementStore extends Emitter {
  constructor(db) {
    super();
    this.db = db;
    this.items = [];
    this.selected = null;
    this.cache = new WeakMap();
    this.saveTimer = null;
    this.ready = this._load();
  }

  async _load() {
    try {
      const rec = await this.db.get('kv', KV_KEY);
      if (rec && Array.isArray(rec.value)) this.items = rec.value.filter((m) => m && m.ir && m.sampleRate);
    } catch (err) {
      console.warn('[measure] could not load measurements', err);
    }
    this.selected = this.items[0]?.id ?? null;
    this.emit('change');
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.db.put('kv', { key: KV_KEY, value: this.items }).catch((err) => console.warn('[measure] save failed', err));
    }, 200);
  }

  _changed() {
    this._save();
    this.emit('change');
  }

  get(id) {
    return this.items.find((m) => m.id === id) || null;
  }

  get current() {
    return this.get(this.selected) || this.items[0] || null;
  }

  nextColor() {
    const used = new Set(this.items.map((m) => m.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[this.items.length % COLORS.length];
  }

  nextNumber() {
    return this.items.reduce((n, m) => Math.max(n, m.number || 0), 0) + 1;
  }

  add(m) {
    this.items.unshift(m);
    while (this.items.length > MAX_ITEMS) this.items.pop();
    this.selected = m.id;
    this._changed();
  }

  update(id, patch) {
    const m = this.get(id);
    if (!m) return;
    Object.assign(m, patch);
    this._changed();
  }

  remove(id) {
    this.items = this.items.filter((m) => m.id !== id);
    if (this.selected === id) this.selected = this.items[0]?.id ?? null;
    this._changed();
  }

  clear() {
    this.items = [];
    this.selected = null;
    this._changed();
  }

  select(id) {
    this.selected = id;
    this.emit('change');
  }

  /** Memoised analysis of a measurement. */
  analysis(m, key, fn) {
    let c = this.cache.get(m);
    if (!c) this.cache.set(m, (c = new Map()));
    if (!c.has(key)) c.set(key, fn());
    return c.get(key);
  }
}

function channelLabel(ch) {
  return ch === 'L' ? 'Left' : ch === 'R' ? 'Right' : 'L+R';
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_');
}

export function measureView(app, params, query, disposer) {
  const store = app.store;
  if (!app.measurements) app.measurements = new MeasurementStore(app.db);
  const ms = app.measurements;
  const opts = { channel: 'both', levelDb: -12, seconds: 2.7, tab: query.tab || 'spl', smoothing: '6', windowMs: 500, span: 50, wfMode: 'bass' };
  let busy = false;

  // ------------------------------------------------------------ analysis helpers
  const fr = (m) => ms.analysis(m, `fr:${opts.smoothing}:${opts.windowMs}`, () => frequencyResponse(m, { smoothing: opts.smoothing === 'var' ? 'var' : Number(opts.smoothing), windowMs: opts.windowMs, levelRms: m.levelRms }));
  const decay = (m) => ms.analysis(m, 'decay', () => decayAnalysis(m));
  const summary = (m) => ms.analysis(m, 'summary', () => summarize(m, m.levelRms));
  const dist = (m) => ms.analysis(m, 'dist', () => distortion(m, { levelRms: m.levelRms }));
  const wf = (m) =>
    ms.analysis(m, `wf:${opts.wfMode}`, () => {
      if (opts.wfMode !== 'bass') return waterfall(m, { fMin: 150, fMax: 20000, slices: 30, stepMs: 0.4, windowMs: 6, riseMs: 0.2 });
      // Span ≈ 0.7 × the bass decay time so ringing modes stand out as ridges.
      const b = decay(m).bands;
      const t = Math.max(...[b[0]?.t20, b[1]?.t20].filter(Number.isFinite), 0.2);
      const span = Math.min(600, Math.max(90, t * 700));
      return waterfall(m, { fMin: 15, fMax: 500, slices: 32, stepMs: Math.round((span / 31) * 10) / 10, windowMs: 250 });
    });
  const visible = () => ms.items.filter((m) => m.visible !== false);

  // ------------------------------------------------------------ measuring
  const progressBar = h('i');
  const status = h('div.dim', 'Ready. The sweep is played through your complete virtual system and captured by an omni microphone at the listening position.');
  const measureBtn = h('button.btn.primary.large', icon('mic', 18), 'Measure');
  const autoEqBtn = h('button.btn', icon('sparkle', 16), 'Auto-EQ from sweep');

  const context = (state) => {
    const spk = state.speakers.find((s) => !s.muted);
    const sub = state.subs.find((s) => !s.muted);
    return {
      room: ROOM_PRESETS[state.room.preset]?.name || 'Custom room',
      speaker: spk ? getHardware(spk.modelId)?.name : null,
      sub: sub ? getHardware(sub.modelId)?.name : null,
      masterDb: state.receiver.masterDb,
      eq: state.eq.graphic.enabled || state.eq.parametric.enabled,
      rc: state.roomCorrection.enabled,
    };
  };

  const sweep = async (state, name) => {
    const res = await runSweepMeasurement({
      state,
      channel: opts.channel,
      levelDb: opts.levelDb,
      seconds: opts.seconds,
      sampleRate: 48000,
      onProgress: (p, msg) => {
        progressBar.style.width = `${Math.round(p * 100)}%`;
        status.textContent = `${msg} ${Math.round(p * 100)}%`;
      },
    });
    const number = ms.nextNumber();
    const m = {
      ...res,
      id: uid('meas'),
      number,
      name: name || `M${number} · ${channelLabel(opts.channel)} · ${context(state).room}`,
      color: ms.nextColor(),
      createdAt: Date.now(),
      visible: true,
      context: context(state),
    };
    ms.add(m);
    return m;
  };

  const withBusy = async (fn) => {
    if (busy) return;
    busy = true;
    measureBtn.disabled = true;
    autoEqBtn.disabled = true;
    try {
      await fn();
    } catch (err) {
      console.error(err);
      status.textContent = `Measurement failed: ${err.message || err}`;
      toast(`Measurement failed: ${err.message || err}`, { type: 'error' });
    } finally {
      busy = false;
      measureBtn.disabled = false;
      autoEqBtn.disabled = false;
    }
  };

  measureBtn.addEventListener('click', () =>
    withBusy(async () => {
      const m = await sweep(JSON.parse(JSON.stringify(store.state)));
      const s = summary(m);
      status.textContent = `Done — ${m.name}: ${s.spl1k.toFixed(1)} dB SPL at 1 kHz, peak ${m.peakSpl.toFixed(1)} dB SPL.`;
    }),
  );

  autoEqBtn.addEventListener('click', () =>
    withBusy(async () => {
      // 1. Measure the system with user EQ and room correction bypassed.
      const base = measurementState(JSON.parse(JSON.stringify(store.state)));
      const before = await sweep(base, `Before auto-EQ · ${channelLabel(opts.channel)}`);
      const r = frequencyResponse(before, { smoothing: 0, windowMs: 500, levelRms: before.levelRms });
      // 2. Fit correction filters to the swept response.
      const res = computeRoomCorrection(JSON.parse(JSON.stringify(store.state)), { measured: { freqs: r.freqs, db: r.spl }, sampleRate: app.ctx.sampleRate });
      store.patch('roomCorrection', { filters: res.filters, enabled: true, measuredAt: Date.now() });
      // 3. Verify with a second sweep through the corrected system.
      const verify = measurementState(JSON.parse(JSON.stringify(store.state)));
      verify.roomCorrection = JSON.parse(JSON.stringify(store.state.roomCorrection));
      await sweep(verify, `After auto-EQ · ${channelLabel(opts.channel)}`);
      status.textContent = `Auto-EQ applied: ${res.filters.length} filters, deviation from the ${store.state.roomCorrection.target} target ${res.errorBefore.toFixed(1)} → ${res.errorAfter.toFixed(1)} dB RMS (${store.state.roomCorrection.fMin}–${store.state.roomCorrection.fMax} Hz).`;
      toast('Room correction computed from the sweep and applied', { type: 'success' });
    }),
  );

  // ------------------------------------------------------------ list
  const list = h('div.stack.tight.meas-list');
  const renderList = () => {
    clear(list);
    if (!ms.items.length) {
      list.appendChild(h('p.dim', 'No measurements yet. Press Measure to sweep your virtual system.'));
      return;
    }
    for (const m of ms.items) {
      const s = summary(m);
      const vis = h('input', { type: 'checkbox', checked: m.visible !== false, 'aria-label': `Show ${m.name}` });
      vis.addEventListener('change', () => ms.update(m.id, { visible: vis.checked }));
      const row = h(
        'div.meas-item',
        { class: m.id === ms.current?.id ? 'selected' : '', tabindex: 0, 'data-id': m.id },
        h('label.meas-swatch', { style: { '--c': m.color }, onClick: (e) => e.stopPropagation() }, vis, h('span')),
        h('div.grow.ellipsis',
          h('div.ellipsis.meas-name', m.name),
          h('div.dim.ellipsis', `${s.spl1k.toFixed(1)} dB @1k · −6 dB @ ${Number.isFinite(s.f6) ? formatHz(s.f6) : '<10 Hz'} · bass ±${s.bassDev.toFixed(1)} dB · ${m.levelDb} dBFS`),
        ),
        h('button.icon-btn', { 'aria-label': 'Measurement actions', onClick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); itemMenu(m, r.left, r.bottom); } }, icon('more', 18)),
      );
      const pick = () => ms.select(m.id);
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
      list.appendChild(row);
    }
  };

  const itemMenu = (m, x, y) =>
    openMenu(x, y, [
      { label: 'Rename…', icon: 'edit', onClick: async () => { const n = await promptDialog('Rename measurement', { value: m.name }); if (n) ms.update(m.id, { name: n }); } },
      { label: 'Export REW text (freq, SPL, phase)', icon: 'download', onClick: () => exportText(m) },
      { label: 'Export impulse response (WAV)', icon: 'download', onClick: () => download(encodeWav({ channels: [m.ir], sampleRate: m.sampleRate }, { bitDepth: 32, meta: { title: m.name, software: 'AudioSpace Simulator' } }), `${safeName(m.name)} IR.wav`) },
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => ms.remove(m.id) },
    ]);

  const exportText = (m) => {
    const r = frequencyResponse(m, { smoothing: 0, windowMs: 500, levelRms: m.levelRms });
    const lines = [
      `* Measurement data exported by AudioSpace Simulator`,
      `* ${m.name}`,
      `* Simulated exponential sweep ${m.sweep.f1}–${Math.round(m.sweep.f2)} Hz, ${m.levelDb} dBFS, ${channelLabel(m.channel)}; ${m.context?.room || ''}`,
      `* Freq(Hz) SPL(dB) Phase(degrees)`,
    ];
    for (let i = 0; i < r.freqs.length; i++) lines.push(`${r.freqs[i].toFixed(3)} ${r.spl[i].toFixed(3)} ${r.phase[i].toFixed(2)}`);
    download(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }), `${safeName(m.name)}.txt`);
  };

  // ------------------------------------------------------------ plots
  const plotBox = h('div.plot-box.tall.meas-plot');
  const extra = h('div.meas-extra');
  let plot = null;
  let plotKind = '';
  const ensurePlot = (kind, make) => {
    if (plot && plotKind === kind) return plot;
    plot?.destroy();
    clear(plotBox);
    const cv = h('canvas');
    plotBox.appendChild(cv);
    plot = make(cv);
    plotKind = kind;
    return plot;
  };
  disposer.add(() => plot?.destroy());

  const splRange = (curves) => {
    let max = -Infinity;
    for (const c of curves) for (let i = 0; i < c.freqs.length; i++) if (c.freqs[i] >= 20 && c.freqs[i] <= 20000 && Number.isFinite(c.db[i])) max = Math.max(max, c.db[i]);
    if (!Number.isFinite(max)) max = 100;
    const top = Math.ceil((max + 4) / 5) * 5;
    return [top - 50, top];
  };

  const controls = h('div.split.wrap.meas-controls');
  const draw = () => {
    clear(extra);
    const vis = visible();
    const cur = ms.current;
    const tab = opts.tab;
    if (!ms.items.length) {
      plot?.destroy();
      plot = null;
      plotKind = '';
      clear(plotBox);
      plotBox.appendChild(h('div.empty-plot', icon('mic', 28), h('div', 'Measure your system to see its response here.')));
      return;
    }
    if (tab === 'spl' || tab === 'phase' || tab === 'gd') {
      const p = ensurePlot('freq', (cv) => new ResponsePlot(cv, { fMin: 10, fMax: 20000 }));
      p.markers = [];
      p.bands = [];
      const curves = vis.map((m) => {
        const r = fr(m);
        let db = r.spl;
        if (tab === 'phase') {
          db = Float64Array.from(r.phase);
          for (let i = 1; i < db.length; i++) if (Math.abs(r.phase[i] - r.phase[i - 1]) > 180) db[i] = NaN;
        } else if (tab === 'gd') db = r.groupDelayMs;
        return { freqs: r.freqs, db: Array.from(db), color: m.color, width: m.id === cur?.id ? 2.4 : 1.5, label: m.name.length > 28 ? `${m.name.slice(0, 27)}…` : m.name };
      });
      if (tab === 'spl') {
        const [lo, hi] = splRange(curves);
        p.setRange(lo, hi, 5);
      } else if (tab === 'phase') p.setRange(-180, 180, 45);
      else {
        let max = 5;
        for (const c of curves) for (let i = 0; i < c.freqs.length; i++) if (c.freqs[i] >= 20 && c.freqs[i] <= 20000) max = Math.max(max, c.db[i]);
        p.setRange(-5, Math.min(200, Math.ceil(max / 5) * 5 + 5), Math.max(5, Math.ceil(max / 40) * 5));
      }
      p.setCurves(curves);
      extra.append(h('div.dim', tab === 'spl' ? `dB SPL at the seat for the sweep level · ${opts.windowMs} ms window` : tab === 'phase' ? 'Phase in degrees, bulk delay (time of flight) removed' : 'Group delay in milliseconds, relative to the direct sound'));
    } else if (tab === 'ir' || tab === 'step' || tab === 'etc') {
      const p = ensurePlot('time', (cv) => new XYPlot(cv));
      const span = opts.span;
      const curves = vis.map((m) => {
        const fs = m.sampleRate;
        const x0 = (-m.peakIndex / fs) * 1000;
        const dx = 1000 / fs;
        if (tab === 'ir') {
          let pk = 1e-12;
          for (let i = 0; i < m.ir.length; i++) pk = Math.max(pk, Math.abs(m.ir[i]));
          return { x0, dx, y: m.ir.map((v) => v / pk), color: m.color, width: 1.3, label: m.name };
        }
        if (tab === 'step') return { x0, dx, y: ms.analysis(m, 'step', () => stepResponse(m, 400)), color: m.color, width: 1.6, label: m.name };
        return { x0, dx, y: ms.analysis(m, 'etc', () => energyTimeCurve(m, 1000)), color: m.color, width: 1.2, label: m.name };
      });
      if (tab === 'etc') p.set({ curves, xMin: -2, xMax: span, yMin: -80, yMax: 0, yUnit: '', xUnit: 'ms' });
      else if (tab === 'step') p.set({ curves, xMin: -1, xMax: Math.min(span, 100), yMin: -0.6, yMax: 1.1, yUnit: '', xUnit: 'ms' });
      else p.set({ curves, xMin: -2, xMax: span, yMin: -1.05, yMax: 1.05, yUnit: '', xUnit: 'ms' });
      extra.append(h('div.dim', tab === 'ir' ? 'Impulse response normalised to its peak (t = 0 at the direct sound)' : tab === 'step' ? 'Step response (running integral of the impulse), normalised' : 'Energy-time curve: envelope of the impulse response in dB — early reflections show up as spikes'));
    } else if (tab === 'decay') {
      const p = ensurePlot('bars', (cv) => new BarsPlot(cv, { unit: ' s' }));
      p.setData(vis.map((m) => ({ label: m.name, color: m.color, values: decay(m).bands.map((b) => b.t20) })), BANDS.map((f) => (f >= 1000 ? `${f / 1000}k` : `${f}`)));
      if (cur) {
        const d = decay(cur);
        const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
        extra.append(
          h('table.spec-table.meas-table',
            h('thead', h('tr', h('th', cur.name), BANDS.map((f) => h('th', f >= 1000 ? `${f / 1000}k` : `${f}`)))),
            h('tbody',
              [['EDT (s)', 'edt'], ['T20 (s)', 't20'], ['T30 (s)', 't30'], ['C50 (dB)', 'c50', 1], ['C80 (dB)', 'c80', 1]].map(([label, key, dg]) => h('tr', h('td.dim', label), d.bands.map((b) => h('td', fmt(b[key], dg ?? 2))))),
            ),
          ),
        );
      }
    } else if (tab === 'wf') {
      const p = ensurePlot('wf', (cv) => new WaterfallPlot(cv, { range: opts.wfMode === 'bass' ? 45 : 35 }));
      p.range = opts.wfMode === 'bass' ? 45 : 35;
      p.setData(cur ? wf(cur) : null);
      extra.append(h('div.dim', cur ? `${cur.name} — cumulative spectral decay. ${opts.wfMode === 'bass' ? 'Long ridges are room modes ringing after the sound stops.' : 'Full-range decay over the first milliseconds.'}` : ''));
    } else if (tab === 'dist') {
      const p = ensurePlot('freq-dist', (cv) => new ResponsePlot(cv, { fMin: 20, fMax: 10000 }));
      if (!cur) return;
      const d = dist(cur);
      const colors = ['#ff6b9a', '#ffb547', '#7cd66b', '#5aa9ff'];
      const thdLevel = Array.from(d.fundamental, (v, i) => v + d.thdDb[i]);
      const curves = [
        { freqs: d.freqs, db: Array.from(d.fundamental), color: '#ffffff', width: 2.2, label: 'Fundamental' },
        { freqs: d.freqs, db: thdLevel, color: '#36e2cf', width: 1.8, dash: [6, 3], label: 'THD' },
        ...d.harmonics.map((hm, i) => ({ freqs: d.freqs, db: Array.from(hm.spl), color: colors[i], width: 1.3, label: `H${hm.k}` })),
      ];
      const [, hi] = splRange(curves.slice(0, 1));
      p.setRange(hi - 100, hi, 10);
      p.setCurves(curves);
      const at = (f) => {
        let b = 0;
        for (let i = 0; i < d.freqs.length; i++) if (Math.abs(Math.log(d.freqs[i] / f)) < Math.abs(Math.log(d.freqs[b] / f))) b = i;
        return d.thdPct[b];
      };
      extra.append(h('div.split.wrap', h('span.dim', `${cur.name} at ${cur.levelDb} dBFS —`), ...[30, 50, 100, 1000, 5000].map((f) => h('span.badge', { class: at(f) > 10 ? 'danger' : at(f) > 1 ? 'warn' : 'ok' }, `THD ${formatHz(f)}: ${at(f) < 0.01 ? '<0.01' : at(f).toFixed(at(f) < 1 ? 2 : 1)} %`))));
    }
  };

  // ------------------------------------------------------------ stats
  const statsEl = h('div.mini-stats');
  const renderStats = () => {
    clear(statsEl);
    const m = ms.current;
    if (!m) return;
    const s = summary(m);
    const d = decay(m);
    const stat = (label, value) => h('div.stat', h('div.stat-value', { style: { fontSize: '16px' } }, value), h('div.stat-label', label));
    statsEl.append(
      stat('Level @ 1 kHz', `${s.spl1k.toFixed(1)} dB`),
      stat('Peak SPL', `${m.peakSpl.toFixed(1)} dB`),
      stat('Bass −6 dB', Number.isFinite(s.f6) ? formatHz(s.f6) : '< 10 Hz'),
      stat('Bass flatness', `±${s.bassDev.toFixed(1)} dB`),
      stat('Arrival', `${s.arrivalMs.toFixed(2)} ms`),
      stat('T20 / EDT (mid)', `${Number.isFinite(d.t20) ? d.t20.toFixed(2) : '—'} / ${Number.isFinite(d.edt) ? d.edt.toFixed(2) : '—'} s`),
      stat('C50 / C80', `${d.c50.toFixed(1)} / ${d.c80.toFixed(1)} dB`),
      stat('System', [m.context?.speaker, m.context?.sub].filter(Boolean).join(' + ') || '—'),
    );
  };

  const renderControls = () => {
    clear(controls);
    controls.append(
      segmented(
        [
          { value: 'spl', label: 'SPL' },
          { value: 'phase', label: 'Phase' },
          { value: 'gd', label: 'Group delay' },
          { value: 'ir', label: 'Impulse' },
          { value: 'step', label: 'Step' },
          { value: 'etc', label: 'ETC' },
          { value: 'decay', label: 'RT60' },
          { value: 'wf', label: 'Waterfall' },
          { value: 'dist', label: 'Distortion' },
        ],
        opts.tab,
        (v) => {
          opts.tab = v;
          renderControls();
          draw();
        },
        { label: 'Measurement graph' },
      ),
      h('div.grow'),
    );
    if (['spl', 'phase', 'gd'].includes(opts.tab)) {
      if (opts.tab === 'spl') {
        controls.append(select([
          { value: '0', label: 'No smoothing' }, { value: '48', label: '1/48 octave' }, { value: '24', label: '1/24 octave' }, { value: '12', label: '1/12 octave' }, { value: '6', label: '1/6 octave' }, { value: '3', label: '1/3 octave' }, { value: 'var', label: 'Variable (psychoacoustic)' },
        ], opts.smoothing, (v) => { opts.smoothing = v; draw(); }, { 'aria-label': 'Smoothing' }));
      }
      controls.append(select([
        { value: 500, label: 'In-room (500 ms window)' }, { value: 100, label: '100 ms window' }, { value: 20, label: '20 ms window' }, { value: 5, label: 'Quasi-anechoic (5 ms gate)' },
      ], opts.windowMs, (v) => { opts.windowMs = Number(v); draw(); }, { 'aria-label': 'Window' }));
    } else if (['ir', 'step', 'etc'].includes(opts.tab)) {
      controls.append(segmented([{ value: 10, label: '10 ms' }, { value: 50, label: '50 ms' }, { value: 200, label: '200 ms' }, { value: 1000, label: '1 s' }], opts.span, (v) => { opts.span = Number(v); draw(); }, { label: 'Time span' }));
    } else if (opts.tab === 'wf') {
      controls.append(segmented([{ value: 'bass', label: 'Bass (room modes)' }, { value: 'full', label: 'Full range' }], opts.wfMode, (v) => { opts.wfMode = v; draw(); }, { label: 'Waterfall range' }));
    }
  };

  const refresh = () => {
    renderList();
    renderStats();
    draw();
  };
  disposer.add(ms.on('change', refresh));
  ms.ready.then(() => {
    if (!disposer.disposed) refresh();
  });

  renderControls();
  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Measurements'), h('div.muted', 'Log-sweep measurements of your virtual system at the listening position — frequency response, phase, impulse, decay, waterfall and distortion, like REW.'))),
    h('div.studio-grid',
      h('div.card',
        h('div.card-title', h('h3', icon('mic', 18), 'Sweep')),
        h('div.stack',
          h('div.field', h('label', 'Channel'), segmented([{ value: 'L', label: 'Left' }, { value: 'R', label: 'Right' }, { value: 'both', label: 'Both' }], opts.channel, (v) => (opts.channel = v))),
          sliderRow('Sweep level', { min: -40, max: 0, step: 1, value: opts.levelDb, reset: -12, format: (v) => `${v} dBFS`, onInput: (v) => (opts.levelDb = v) }),
          h('div.field', h('label', 'Sweep length'), segmented([{ value: 1.4, label: 'Fast 1.4 s' }, { value: 2.7, label: 'Standard 2.7 s' }, { value: 5.5, label: 'Long 5.5 s' }], opts.seconds, (v) => (opts.seconds = Number(v)))),
          h('div.split.wrap', measureBtn, autoEqBtn),
          h('div.progress', progressBar),
          status,
        ),
      ),
      h('div.card',
        h('div.card-title', h('h3', icon('layers', 18), 'Measurements'), h('div.grow'), h('button.btn.small.ghost', { onClick: async () => { if (ms.items.length && (await confirmDialog('Delete all measurements?', 'This removes every stored measurement.', { ok: 'Delete all', danger: true }))) ms.clear(); } }, 'Clear')),
        list,
      ),
      h('div.card.span-2',
        controls,
        plotBox,
        extra,
      ),
      h('div.card.span-2',
        h('div.card-title', h('h3', icon('gauge', 18), 'Selected measurement')),
        statsEl,
      ),
    ),
  );
  refresh();
  return { el, title: 'Measurements' };
}
