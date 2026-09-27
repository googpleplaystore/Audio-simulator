// Equalization: 31-band graphic EQ, 12-band parametric EQ with draggable
// handles, and automatic room correction against a target curve.

import { h, icon, clear, viewDebounce } from '../dom.js';
import { slider, sliderRow, toggle, select, numberInput } from '../components/controls.js';
import { toast } from '../components/overlays.js';
import { ResponsePlot } from '../../viz/responsePlot.js';
import { GEQ_FREQS, GEQ_PRESETS, GEQ_Q, TARGET_CURVES } from '../../dsp/curves.js';
import { cascadeMagnitudeDb } from '../../dsp/biquad.js';
import { bandToSpec } from '../../audio/plan.js';
import { computeRoomCorrection, measure } from '../../audio/calibration.js';
import { logspace, clamp } from '../../util/math.js';
import { formatHzShort, formatDb } from '../../util/format.js';
import { uid } from '../../util/hash.js';

const PLOT_F = logspace(20, 20000, 300);
const BAND_TYPES = [
  { value: 'peaking', label: 'Peak' },
  { value: 'lowshelf', label: 'Low shelf' },
  { value: 'highshelf', label: 'High shelf' },
  { value: 'lowpass', label: 'Low-pass' },
  { value: 'highpass', label: 'High-pass' },
  { value: 'notch', label: 'Notch' },
];
const BAND_COLORS = ['#8d7dff', '#36e2cf', '#ffb547', '#ff6b9a', '#5fa8ff', '#3ee69b', '#c77dff', '#ff8f5a', '#7ee7ff', '#f5e663', '#ff5470', '#a3f07a'];

export function eqView(app, params, query, disposer) {
  const store = app.store;
  const eq = () => store.state.eq;

  // ------------------------------------------------ overview plot
  const totalCanvas = h('canvas');
  let totalPlot;
  const drawTotal = () => {
    if (!totalPlot) return;
    const plan = app.engine.plan;
    const geqSpecs = eq().graphic.enabled ? GEQ_FREQS.map((f, i) => ({ type: 'peaking', frequency: f, Q: GEQ_Q, gain: eq().graphic.gains[i] })) : [];
    const peqSpecs = eq().parametric.enabled ? eq().parametric.bands.filter((b) => b.enabled).map(bandToSpec) : [];
    const rcSpecs = plan ? plan.rcSpecs : [];
    const total = cascadeMagnitudeDb([...(plan?.toneSpecs || []), ...geqSpecs, ...peqSpecs, ...rcSpecs], PLOT_F);
    totalPlot.setCurves([
      { freqs: PLOT_F, db: cascadeMagnitudeDb(geqSpecs, PLOT_F), color: 'rgba(54,226,207,0.6)', width: 1.4, label: 'Graphic' },
      { freqs: PLOT_F, db: cascadeMagnitudeDb(peqSpecs, PLOT_F), color: 'rgba(141,125,255,0.7)', width: 1.4, label: 'Parametric' },
      rcSpecs.length ? { freqs: PLOT_F, db: cascadeMagnitudeDb(rcSpecs, PLOT_F), color: 'rgba(255,181,71,0.7)', width: 1.4, label: 'Room correction' } : null,
      { freqs: PLOT_F, db: total, color: '#fff', width: 2.6, glow: true, fill: 'rgba(255,255,255,0.06)', label: 'Total' },
    ]);
    headroom.textContent = plan ? `Max boost ${plan.eqMaxBoost.toFixed(1)} dB → preamp ${formatDb(20 * Math.log10(plan.eqPreampGain))}` : '';
  };
  const headroom = h('span.dim.mono', { style: { fontSize: '12px' } });
  const redrawTotal = viewDebounce(disposer, drawTotal, 30);
  disposer.add(store.subscribe(['eq', 'roomCorrection', 'receiver'], () => setTimeout(redrawTotal, 5)));

  // ------------------------------------------------ graphic EQ
  const faders = h('div.geq-faders');
  const faderEls = [];
  GEQ_FREQS.forEach((f, i) => {
    const val = h('span.geq-val.mono');
    const upd = (v) => (val.textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)}`);
    const s = slider({
      min: -12,
      max: 12,
      step: 0.5,
      vertical: true,
      bipolar: true,
      value: eq().graphic.gains[i],
      reset: 0,
      label: `${formatHzShort(f)} Hz`,
      className: 'always-thumb',
      format: (v) => `${v.toFixed(1)} dB`,
      onInput: (v) => {
        const gains = [...eq().graphic.gains];
        gains[i] = v;
        store.patch('eq.graphic', { gains, preset: 'custom' });
        presetSel.value = 'custom';
        upd(v);
      },
    });
    upd(eq().graphic.gains[i]);
    faderEls.push({ s, upd });
    faders.appendChild(h('div.geq-band', val, s, h('span.geq-f', formatHzShort(f))));
  });
  const syncFaders = () => eq().graphic.gains.forEach((g, i) => {
    faderEls[i].s.setValue(g);
    faderEls[i].upd(g);
  });
  const presetSel = select([{ value: 'custom', label: 'Custom' }, ...GEQ_PRESETS.map((p) => ({ value: p.id, label: p.name }))], eq().graphic.preset || 'flat', (v) => {
    const p = GEQ_PRESETS.find((x) => x.id === v);
    if (!p) return;
    store.patch('eq.graphic', { gains: [...p.gains], preset: v, enabled: true });
    syncFaders();
    if (p.description) toast(p.description);
  });
  const geqCard = h('div.card.span-2',
    h('div.card-title', h('h3', icon('eq', 18), '31-band graphic EQ ', h('span.dim', { style: { fontWeight: 500, fontSize: '12px' } }, 'ISO ⅓-octave, constant-Q')),
      h('div.split', toggle('On', eq().graphic.enabled, (v) => store.set('eq.graphic.enabled', v)), presetSel, h('button.btn.small.ghost', { onClick: () => { store.patch('eq.graphic', { gains: GEQ_FREQS.map(() => 0), preset: 'flat' }); presetSel.value = 'flat'; syncFaders(); } }, 'Flat'))),
    h('div.geq-scale', h('span', '+12'), h('span', '+6'), h('span', '0'), h('span', '−6'), h('span', '−12')),
    faders,
  );

  // ------------------------------------------------ parametric EQ
  const peqCanvas = h('canvas');
  let peqPlot;
  let selected = 0;
  const bandTable = h('div.peq-table');
  const bands = () => eq().parametric.bands;
  const setBands = (b) => store.set('eq.parametric.bands', b);
  const drawPeq = () => {
    if (!peqPlot) return;
    const list = bands();
    const curves = list.map((b, i) => (b.enabled ? { freqs: PLOT_F, db: cascadeMagnitudeDb([bandToSpec(b)], PLOT_F), color: `${BAND_COLORS[i % BAND_COLORS.length]}88`, width: 1 } : null));
    curves.push({ freqs: PLOT_F, db: cascadeMagnitudeDb(list.filter((b) => b.enabled).map(bandToSpec), PLOT_F), color: '#fff', width: 2.4, glow: true, fill: 'rgba(141,125,255,0.1)' });
    peqPlot.curves = curves;
    peqPlot.setHandles(list.map((b, i) => ({ frequency: b.frequency, gain: ['lowpass', 'highpass', 'notch'].includes(b.type) ? 0 : b.gain, Q: b.Q, color: BAND_COLORS[i % BAND_COLORS.length], enabled: b.enabled, fixedGain: ['lowpass', 'highpass', 'notch'].includes(b.type) })), selected);
  };
  const renderTable = () => {
    clear(bandTable);
    bandTable.appendChild(h('div.peq-row.head', h('span', '#'), h('span', 'On'), h('span', 'Type'), h('span', 'Freq (Hz)'), h('span', 'Gain (dB)'), h('span', 'Q'), h('span')));
    bands().forEach((b, i) => {
      const upd = (patch) => {
        const list = bands().map((x, k) => (k === i ? { ...x, ...patch } : x));
        setBands(list);
      };
      const row = h('div.peq-row', { class: i === selected ? 'selected' : '' },
        h('span.peq-dot', { style: { background: BAND_COLORS[i % BAND_COLORS.length] } }, String(i + 1)),
        (() => { const c = h('input', { type: 'checkbox', checked: b.enabled }); c.addEventListener('change', () => upd({ enabled: c.checked })); return c; })(),
        select(BAND_TYPES, b.type, (v) => { upd({ type: v, Q: v === 'lowpass' || v === 'highpass' ? 0.71 : b.Q }); renderTable(); }),
        numberInput(b.frequency, { min: 20, max: 20000, step: 1, digits: 0, onChange: (v) => upd({ frequency: v }) }),
        numberInput(b.gain, { min: -24, max: 24, step: 0.1, digits: 1, onChange: (v) => upd({ gain: v }) }),
        numberInput(b.Q, { min: 0.1, max: 30, step: 0.05, digits: 2, onChange: (v) => upd({ Q: v }) }),
        h('button.icon-btn.small', { 'aria-label': 'Delete band', onClick: () => { setBands(bands().filter((_, k) => k !== i)); selected = Math.max(0, selected - 1); renderTable(); } }, icon('trash', 14)),
      );
      row.addEventListener('pointerdown', () => {
        if (selected !== i) {
          selected = i;
          bandTable.querySelectorAll('.peq-row').forEach((r, k) => r.classList.toggle('selected', k - 1 === i));
          drawPeq();
        }
      });
      bandTable.appendChild(row);
    });
  };
  const addBand = () => {
    if (bands().length >= 12) {
      toast('Maximum of 12 parametric bands');
      return;
    }
    setBands([...bands(), { id: uid('p'), enabled: true, type: 'peaking', frequency: 1000, Q: 1, gain: 0 }]);
    selected = bands().length - 1;
    renderTable();
  };
  disposer.add(store.subscribe(['eq.parametric'], () => {
    drawPeq();
    if (!bandTable.contains(document.activeElement)) renderTable();
  }));
  const peqCard = h('div.card.span-2',
    h('div.card-title', h('h3', icon('sliders', 18), 'Parametric EQ ', h('span.dim', { style: { fontWeight: 500, fontSize: '12px' } }, 'drag handles · mouse-wheel on a handle changes Q')),
      h('div.split', toggle('On', eq().parametric.enabled, (v) => store.set('eq.parametric.enabled', v)), h('button.btn.small', { onClick: addBand }, icon('plus', 14), 'Band'), h('button.btn.small.ghost', { onClick: () => { setBands(bands().map((b) => ({ ...b, gain: 0 }))); renderTable(); } }, 'Reset gains'))),
    h('div.plot-box.tall', peqCanvas),
    bandTable,
  );

  // ------------------------------------------------ room correction
  const rcCanvas = h('canvas');
  let rcPlot;
  const rcInfo = h('div.dim', { style: { fontSize: '12px' } });
  const rc = () => store.state.roomCorrection;
  const showMeasurement = (res) => {
    if (!rcPlot) return;
    rcPlot.bands = [{ f1: rc().fMin, f2: rc().fMax, color: 'rgba(255,181,71,0.06)' }];
    rcPlot.setCurves([
      { freqs: res.freqs, db: Array.from(res.target), color: 'rgba(255,181,71,0.9)', width: 1.6, dash: [6, 4], label: 'Target' },
      { freqs: res.freqs, db: Array.from(res.before), color: 'rgba(255,255,255,0.55)', width: 1.6, label: 'Measured (virtual mic)' },
      res.after ? { freqs: res.freqs, db: Array.from(res.after), color: '#36e2cf', width: 2.4, glow: true, label: 'Corrected' } : null,
    ]);
  };
  const runCorrection = () => {
    const res = computeRoomCorrection(JSON.parse(JSON.stringify(store.state)), { roomFilters: app.engine.roomFilters, sampleRate: app.ctx.sampleRate });
    store.patch('roomCorrection', { filters: res.filters, enabled: true, measuredAt: Date.now() });
    showMeasurement(res);
    rcInfo.textContent = `${res.filters.length} filters · deviation from target ${res.errorBefore.toFixed(1)} → ${res.errorAfter.toFixed(1)} dB RMS within ${rc().fMin}–${rc().fMax} Hz`;
    renderRcFilters();
    toast('Room correction applied', { type: 'success' });
  };
  const previewMeasurement = () => {
    const m = measure(JSON.parse(JSON.stringify(store.state)), { roomFilters: app.engine.roomFilters, sampleRate: app.ctx.sampleRate });
    const t = TARGET_CURVES.find((x) => x.id === rc().target) || TARGET_CURVES[0];
    const tgt = m.freqs.map((f) => t.fn(f));
    let tref = 0;
    let n = 0;
    m.freqs.forEach((f, i) => {
      if (f >= 300 && f <= 3000) {
        tref += tgt[i];
        n++;
      }
    });
    tref /= n || 1;
    let after = null;
    if (rc().enabled && rc().filters.length) {
      const corr = cascadeMagnitudeDb(rc().filters.map((f) => ({ ...f, gain: f.gain * (rc().strength ?? 1) })), m.freqs);
      after = m.smoothed.map((v, i) => v + corr[i]);
    }
    showMeasurement({ freqs: m.freqs, target: tgt.map((v) => v - tref), before: m.smoothed, after });
  };
  const rcFilters = h('div.rc-filters');
  const renderRcFilters = () => {
    clear(rcFilters);
    for (const f of rc().filters) rcFilters.appendChild(h('span.badge', { class: f.gain < 0 ? 'teal' : 'warn' }, `${formatHzShort(f.frequency)} Hz ${f.gain > 0 ? '+' : ''}${f.gain.toFixed(1)} dB Q${f.Q.toFixed(1)}`));
    if (!rc().filters.length) rcFilters.appendChild(h('span.dim', 'No correction computed yet.'));
  };
  renderRcFilters();
  const rcCard = h('div.card.span-2',
    h('div.card-title', h('h3', icon('mic', 18), 'Room correction (auto-EQ)'), h('div.split', toggle('On', rc().enabled, (v) => { store.set('roomCorrection.enabled', v); setTimeout(previewMeasurement, 30); }), h('button.btn.small.primary', { onClick: runCorrection }, icon('target', 14), 'Measure & correct'))),
    h('div.rc-layout',
      h('div.plot-box.tall', rcCanvas),
      h('div.stack',
        h('div.field', h('label', 'Target curve'), select(TARGET_CURVES.map((t) => ({ value: t.id, label: t.name })), rc().target, (v) => { store.set('roomCorrection.target', v); previewMeasurement(); })),
        sliderRow('Low limit', { min: 15, max: 200, step: 1, log: true, value: rc().fMin, format: (v) => `${Math.round(v)} Hz`, onInput: (v) => store.set('roomCorrection.fMin', Math.round(v)) }),
        sliderRow('High limit', { min: 150, max: 20000, step: 10, log: true, value: rc().fMax, format: (v) => `${formatHzShort(v)} Hz`, onInput: (v) => store.set('roomCorrection.fMax', Math.round(v)) }),
        sliderRow('Max boost', { min: 0, max: 12, step: 0.5, value: rc().maxBoost, format: (v) => `${v.toFixed(1)} dB`, onInput: (v) => store.set('roomCorrection.maxBoost', v) }),
        sliderRow('Max cut', { min: 0, max: 24, step: 0.5, value: rc().maxCut, format: (v) => `${v.toFixed(1)} dB`, onInput: (v) => store.set('roomCorrection.maxCut', v) }),
        sliderRow('Strength', { min: 0, max: 1, step: 0.05, value: rc().strength ?? 1, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => store.set('roomCorrection.strength', v) }),
        rcInfo,
        rcFilters,
        h('p.dim', { style: { fontSize: '12px' } }, 'The virtual microphone measures the complete simulated chain (speakers, crossover, boundary/modal room response and reverberant field) at your seat, then fits up to 12 parametric filters. Boosts are limited: deep modal nulls cannot be filled with EQ — move the sub or seat instead.'),
      ),
    ),
  );

  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Equalizer'), h('div.muted', 'Shape the sound before it reaches the amplifiers. Boosts eat headroom — watch the preamp.')), headroom),
    h('div.studio-grid',
      h('div.card.span-2', h('div.card-title', h('h3', 'Combined EQ response')), h('div.plot-box', totalCanvas)),
      geqCard,
      peqCard,
      rcCard,
    ),
  );
  return {
    el,
    title: 'Equalizer',
    mounted() {
      totalPlot = new ResponsePlot(totalCanvas, { dbMin: -15, dbMax: 15, dbStep: 5 });
      peqPlot = new ResponsePlot(peqCanvas, { dbMin: -18, dbMax: 18, dbStep: 6 });
      rcPlot = new ResponsePlot(rcCanvas, { dbMin: -24, dbMax: 18, dbStep: 6 });
      peqPlot.onHandleSelect = (i) => {
        selected = i;
        renderTable();
      };
      peqPlot.onHandle = (i, patch) => {
        const list = bands().map((b, k) => (k === i ? { ...b, ...patch, frequency: clamp(patch.frequency ?? b.frequency, 20, 20000) } : b));
        setBands(list);
      };
      disposer.add(() => {
        totalPlot.destroy();
        peqPlot.destroy();
        rcPlot.destroy();
      });
      drawTotal();
      drawPeq();
      renderTable();
      previewMeasurement();
    },
  };
}

