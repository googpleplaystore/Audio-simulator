// Bass management: active Linkwitz–Riley crossover, polarity/phase, time
// alignment and a live plot of how mains and subwoofers sum at the seat.

import { h, icon, clear, viewDebounce } from '../dom.js';
import { sliderRow, toggle, segmented, knob } from '../components/controls.js';
import { toast } from '../components/overlays.js';
import { ResponsePlot } from '../../viz/responsePlot.js';
import { buildPlan } from '../../audio/plan.js';
import { predictSystem, bandMeanDb } from '../../audio/predict.js';
import { cascadeMagnitudeDb, linkwitzRiley } from '../../dsp/biquad.js';
import { STANDARD_CROSSOVERS, suggestCrossover } from '../../dsp/curves.js';
import { getHardware } from '../../hardware/index.js';
import { octaveGrid, stddev, clamp } from '../../util/math.js';
import { formatHz } from '../../util/format.js';

const FREQS = octaveGrid(15, 1000, 48);

function integrationScore(state, roomFilters, sampleRate) {
  const plan = buildPlan(state, { sampleRate, roomFilters });
  const r = predictSystem(plan, FREQS, { room: state.room, includeMaster: false });
  const f = state.crossover.frequency;
  const idx = [];
  for (let i = 0; i < FREQS.length; i++) if (FREQS[i] >= f / 2 && FREQS[i] <= f * 2) idx.push(r.db[i]);
  return { std: stddev(idx), mean: idx.reduce((a, b) => a + b, 0) / Math.max(1, idx.length), resp: r };
}

export function crossoverView(app, params, query, disposer) {
  const store = app.store;
  const xo = () => store.state.crossover;
  const canvas = h('canvas.xo-plot');
  const plotBox = h('div.plot-box.tall', canvas);
  let plot;
  const scoreEl = h('div.xo-score');
  let showPhase = false;

  const draw = () => {
    if (!plot) return;
    const state = store.state;
    const plan = buildPlan(state, { sampleRate: app.ctx.sampleRate, roomFilters: app.engine.roomFilters });
    const opts = { room: state.room, includeMaster: false };
    const mains = predictSystem(plan, FREQS, { ...opts, filter: (s) => s.kind === 'speaker' });
    const subs = predictSystem(plan, FREQS, { ...opts, filter: (s) => s.kind === 'sub' });
    const sum = predictSystem(plan, FREQS, opts);
    const ref = bandMeanDb(FREQS, sum.db, 300, 1000);
    const norm = (arr) => Array.from(arr, (v) => v - ref);
    const lp = cascadeMagnitudeDb(plan.lfeSpecs, FREQS);
    const hp = cascadeMagnitudeDb(plan.hpfSpecs, FREQS);
    const curves = [
      { freqs: FREQS, db: Array.from(lp), color: 'rgba(255,107,154,0.45)', width: 1.2, dash: [5, 4] },
      { freqs: FREQS, db: Array.from(hp), color: 'rgba(141,125,255,0.45)', width: 1.2, dash: [5, 4] },
      { freqs: FREQS, db: norm(mains.db), color: '#8d7dff', width: 1.8, label: 'Mains at seat' },
      { freqs: FREQS, db: norm(subs.db), color: '#ff6b9a', width: 1.8, label: 'Subs at seat' },
      { freqs: FREQS, db: norm(sum.db), color: '#ffffff', width: 2.6, glow: true, label: 'Acoustic sum' },
    ];
    if (showPhase) {
      // Relative phase between sub and mains paths, scaled to the dB axis (±180° → ±18 dB).
      const ph = FREQS.map((_, i) => {
        const a = Math.atan2(subs.complex.im[i], subs.complex.re[i]);
        const b = Math.atan2(mains.complex.im[i], mains.complex.re[i]);
        let d = ((a - b) * 180) / Math.PI;
        d = ((((d + 180) % 360) + 360) % 360) - 180;
        return (d / 180) * 18;
      });
      curves.push({ freqs: FREQS, db: ph, color: '#ffb547', width: 1.4, label: 'Sub−main phase (±180°)' });
    }
    plot.markers = xo().enabled ? [{ f: xo().frequency, color: 'rgba(255,255,255,0.5)', label: `${xo().frequency} Hz` }] : [];
    plot.setCurves(curves);
    const sc = integrationScore(state, app.engine.roomFilters, app.ctx.sampleRate);
    clear(scoreEl);
    const grade = sc.std < 2 ? ['Excellent', 'ok'] : sc.std < 3.5 ? ['Good', 'teal'] : sc.std < 5.5 ? ['Fair', 'warn'] : ['Poor', 'danger'];
    scoreEl.append(h('span.badge', { class: grade[1] }, grade[0]), h('span', ` Integration ripple ${sc.std.toFixed(1)} dB (½×–2× crossover)`));
  };
  const redraw = viewDebounce(disposer, draw, 60);
  disposer.add(store.subscribe(['crossover', 'speakers', 'subs', 'room', 'listener'], redraw));
  disposer.add(app.engine.on('room-filters', redraw));

  const freqRow = sliderRow('Frequency', { min: 40, max: 250, step: 1, log: true, value: xo().frequency, reset: 80, format: (v) => `${Math.round(v)} Hz`, onInput: (v, final) => store.set('crossover.frequency', final ? snapFreq(v) : Math.round(v)) });
  const slope = segmented([{ value: 0, label: 'Off' }, { value: 12, label: 'LR 12 dB' }, { value: 24, label: 'LR 24 dB' }, { value: 48, label: 'LR 48 dB' }], xo().enabled ? xo().slope : 0, (v) => {
    const n = Number(v);
    if (n === 0) store.set('crossover.enabled', false);
    else store.patch('crossover', { enabled: true, slope: n });
  });
  const mode = segmented([{ value: 'small', label: 'Small (high-pass mains)' }, { value: 'large', label: 'Large (full-range + LFE)' }], xo().speakerMode, (v) => store.set('crossover.speakerMode', v));
  const pol = segmented([{ value: 0, label: '0°' }, { value: 180, label: '180°' }], xo().subPolarity || 0, (v) => store.set('crossover.subPolarity', Number(v)));

  const optimize = () => {
    const base = JSON.parse(JSON.stringify(store.state));
    let best = null;
    for (const polarity of [0, 180]) {
      for (let phase = 0; phase <= 180; phase += 15) {
        const s = JSON.parse(JSON.stringify(base));
        s.crossover.subPolarity = polarity;
        for (const sb of s.subs) sb.phaseDeg = phase;
        const sc = integrationScore(s, app.engine.roomFilters, app.ctx.sampleRate);
        // Penalise both ripple and a sagging sum.
        const cost = sc.std - Math.min(0, sc.mean) * 0.1;
        if (!best || cost < best.cost) best = { cost, polarity, phase, std: sc.std };
      }
    }
    store.set('crossover.subPolarity', best.polarity);
    for (const sb of store.state.subs) store.updateItem('subs', sb.id, { phaseDeg: best.phase });
    pol.setValue(best.polarity);
    renderSubs();
    toast(`Best integration: polarity ${best.polarity}°, phase ${best.phase}° (ripple ${best.std.toFixed(1)} dB)`, { type: 'success' });
  };

  const subsBox = h('div.stack');
  const renderSubs = () => {
    clear(subsBox);
    for (const sb of store.state.subs) {
      const hw = getHardware(sb.modelId);
      subsBox.appendChild(
        h('div.sub-row',
          h('div.grow', h('div', { style: { fontWeight: 700 } }, hw?.name), h('div.dim', { style: { fontSize: '12px' } }, `${hw?.driver.size}″ ${hw?.enclosure} · f3 ${hw?.f3} Hz`)),
          knob({ label: 'Phase', min: 0, max: 180, step: 1, value: sb.phaseDeg || 0, reset: 0, size: 56, format: (v) => `${Math.round(v)}°`, onInput: (v) => store.updateItem('subs', sb.id, { phaseDeg: v }) }),
          knob({ label: 'Delay', min: 0, max: 20, step: 0.1, value: sb.delayMs || 0, reset: 0, size: 56, format: (v) => `${v.toFixed(1)} ms`, onInput: (v) => store.updateItem('subs', sb.id, { delayMs: v }) }),
          knob({ label: 'Level', min: -12, max: 12, step: 0.5, value: sb.trimDb || 0, reset: 0, bipolar: true, size: 56, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, onInput: (v) => store.updateItem('subs', sb.id, { trimDb: v }) }),
          h('div.field', h('label', 'Polarity'), segmented([{ value: 0, label: '0°' }, { value: 180, label: '180°' }], sb.polarity || 0, (v) => store.updateItem('subs', sb.id, { polarity: Number(v) }))),
        ),
      );
    }
    if (!store.state.subs.length) subsBox.appendChild(h('p.dim', 'No subwoofer in the room. Add one in the Room Simulator.'));
  };
  renderSubs();

  const mains = store.state.speakers.map((s) => getHardware(s.modelId)).filter(Boolean);
  const f3 = mains.length ? Math.max(...mains.map((m) => m.f3)) : 60;
  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Crossover & Bass Management'), h('div.muted', 'Active Linkwitz–Riley filters split the signal between your speakers and subwoofers. The plot shows what actually arrives at your seat.'))),
    h('div.studio-grid',
      h('div.card.span-2',
        h('div.card-title', h('h3', icon('crossover', 18), 'Summation at the listening position'), h('div.split', scoreEl, toggle('Phase', false, (v) => { showPhase = v; draw(); }))),
        plotBox,
        h('p.dim', { style: { fontSize: '12px', marginTop: '6px' } }, 'Dashed: electrical filters. Solid: acoustic output including driver roll-off, distance, time alignment, polarity and the room’s modal response. A smooth white curve through the crossover region means good integration.'),
      ),
      h('div.card',
        h('div.card-title', h('h3', 'Filters')),
        h('div.stack',
          freqRow,
          h('div.split.wrap', { style: { gap: '6px' } }, STANDARD_CROSSOVERS.filter((f) => f <= 150).map((f) => h('button.chip', { class: xo().frequency === f ? 'active' : '', onClick: () => { store.set('crossover.frequency', f); freqRow.setValue(f); } }, `${f}`))),
          h('div.field', h('label', 'Slope (Linkwitz–Riley)'), slope),
          h('div.field', h('label', 'Speaker size'), mode),
          h('p.dim', { style: { fontSize: '12px' } }, `Your main speakers roll off at ≈${Math.round(f3)} Hz → suggested crossover ${suggestCrossover(f3)} Hz. LR 12 sums flat only with the sub inverted (180°); LR 24/48 sum in phase.`),
        ),
      ),
      h('div.card',
        h('div.card-title', h('h3', 'Subwoofer integration'), h('button.btn.small.primary', { onClick: optimize, 'data-tip': 'Search polarity and phase for the smoothest summation at your seat' }, icon('sparkle', 14), 'Optimize')),
        h('div.stack',
          h('div.field', h('label', 'Global sub polarity'), pol),
          toggle('Automatic time alignment (AVR distances)', xo().autoAlign, (v) => store.set('crossover.autoAlign', v)),
          subsBox,
        ),
      ),
    ),
  );
  return {
    el,
    title: 'Crossover',
    mounted() {
      plot = new ResponsePlot(canvas, { fMin: 15, fMax: 1000, dbMin: -30, dbMax: 15, dbStep: 5 });
      disposer.add(() => plot.destroy());
      draw();
    },
  };
}

function snapFreq(v) {
  const near = STANDARD_CROSSOVERS.find((f) => Math.abs(Math.log(f / v)) < 0.03);
  return near || Math.round(clamp(v, 40, 250));
}

export { linkwitzRiley, formatHz };
