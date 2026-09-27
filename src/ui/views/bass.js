// Bass optimiser: multi-subwoofer placement, delay, polarity and level search
// that minimises seat-to-seat bass variation (runs in its own worker).

import { h, icon, clear } from '../dom.js';
import { segmented, toggle } from '../components/controls.js';
import { toast } from '../components/overlays.js';
import { ResponsePlot } from '../../viz/responsePlot.js';
import { fitCanvas, FONT, LABEL } from '../../viz/canvas.js';
import { AcousticsClient } from '../../acoustics/client.js';
import { SEAT_LAYOUTS, seatPositions, candidatePositions } from '../../acoustics/subopt.js';
import { makeSub } from '../../core/settings.js';
import { getHardware } from '../../hardware/index.js';

const SEAT_COLORS = ['#8d7dff', '#36e2cf', '#ff6b9a', '#ffb547', '#7cd66b', '#5aa9ff'];
const SUB_COLORS = ['#ff6b9a', '#ffb547', '#36e2cf', '#7cd66b'];

function drawPlan(canvas, state, { seats, candidates, current, proposal }) {
  if (!canvas.isConnected) return;
  const { ctx, w, h: hh } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, hh);
  const room = state.room;
  const pad = 26;
  const s = Math.min((w - 2 * pad) / room.width, (hh - 2 * pad) / room.depth);
  const ox = (w - room.width * s) / 2;
  const oy = (hh - room.depth * s) / 2;
  const X = (x) => ox + x * s;
  const Y = (z) => oy + z * s;
  // Room
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.fillRect(X(0), Y(0), room.width * s, room.depth * s);
  ctx.strokeRect(X(0), Y(0), room.width * s, room.depth * s);
  ctx.font = FONT;
  ctx.fillStyle = LABEL;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FRONT', X(room.width / 2), Y(0) - 12);
  ctx.fillText(`${room.width.toFixed(1)} × ${room.depth.toFixed(1)} m`, X(room.width / 2), Y(room.depth) + 13);
  // Main speakers
  for (const sp of state.speakers) {
    ctx.fillStyle = 'rgba(141,125,255,0.35)';
    ctx.fillRect(X(sp.x) - 5, Y(sp.z) - 5, 10, 10);
  }
  // Candidates
  for (const c of candidates) {
    ctx.beginPath();
    ctx.arc(X(c.x), Y(c.z), 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fill();
  }
  // Current subs (outlined)
  for (const sb of current) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(X(sb.x) - 9, Y(sb.z) - 9, 18, 18);
    ctx.setLineDash([]);
  }
  // Proposed subs
  (proposal || []).forEach((sb, i) => {
    const col = SUB_COLORS[i % SUB_COLORS.length];
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 10;
    ctx.fillRect(X(sb.x) - 8, Y(sb.z) - 8, 16, 16);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0a0a10';
    ctx.font = '800 10px Inter, system-ui, sans-serif';
    ctx.fillText(String(i + 1), X(sb.x), Y(sb.z) + 0.5);
    ctx.font = FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const tag = `${sb.delayMs ? `${sb.delayMs} ms ` : ''}${sb.polarity ? '180° ' : ''}${sb.trimDb ? `${sb.trimDb} dB` : ''}`.trim();
    if (tag) {
      const below = sb.z < room.depth / 2;
      ctx.fillText(tag, X(sb.x), Y(sb.z) + (below ? 20 : -20));
    }
  });
  // Seats
  seats.forEach((st, i) => {
    ctx.beginPath();
    ctx.arc(X(st.x), Y(st.z), st.main ? 8 : 6.5, 0, Math.PI * 2);
    ctx.fillStyle = SEAT_COLORS[i % SEAT_COLORS.length];
    ctx.fill();
    ctx.strokeStyle = st.main ? '#fff' : 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

export function bassView(app, params, query, disposer) {
  const store = app.store;
  const opts = { layout: 'couch', count: Math.max(1, Math.min(4, store.state.subs.length || 1)), move: true, fMax: 120, show: 'after' };
  let result = null;
  let proposal = null; // chosen result entry (best or an alternative)
  let running = false;
  const client = new AcousticsClient();
  disposer.add(() => client.dispose());

  const planCanvas = h('canvas.bass-plan');
  const plotCanvas = h('canvas');
  let plot = null;
  const status = h('div.dim', 'Pick your seating and the number of subwoofers, then optimise. The search uses the modal room model at every seat.');
  const statsEl = h('div.mini-stats');
  const altList = h('div.stack.tight');
  const runBtn = h('button.btn.primary.large', icon('sparkle', 18), 'Optimise');
  const applyBtn = h('button.btn', { disabled: true }, icon('check', 16), 'Apply to room');

  const seats = () => seatPositions(store.state.room, store.state.listener, opts.layout);
  const redrawPlan = () => drawPlan(planCanvas, store.state, { seats: seats(), candidates: opts.move ? candidatePositions(store.state.room) : [], current: store.state.subs, proposal: proposal?.subs });
  const ro = new ResizeObserver(() => {
    redrawPlan();
  });
  ro.observe(planCanvas);
  disposer.add(() => ro.disconnect());

  const stat = (label, value) => h('div.stat', h('div.stat-value', { style: { fontSize: '16px' } }, value), h('div.stat-label', label));
  const renderStats = () => {
    clear(statsEl);
    if (!result || !proposal) return;
    const b = result.before?.score;
    const a = proposal.score;
    const arrow = (x, y, d = 1) => (b ? `${x.toFixed(d)} → ${y.toFixed(d)}` : y.toFixed(d));
    statsEl.append(
      stat('Seat-to-seat variation', `${arrow(b?.seatStd ?? 0, a.seatStd)} dB`),
      stat('Response unevenness', `${arrow(b?.flatness ?? 0, a.flatness)} dB`),
      stat('Mean bass level', `${b ? `${(a.level - b.level >= 0 ? '+' : '')}${(a.level - b.level).toFixed(1)} dB` : `${a.level.toFixed(1)} dB`}`),
      stat('Layouts evaluated', String(result.evaluated)),
    );
  };

  const renderPlot = () => {
    if (!plot || !result || !proposal) return;
    const resp = opts.show === 'before' && result.before ? result.before.responses : proposal.responses;
    const nS = resp.length;
    const mean = new Float64Array(result.freqs.length);
    for (let f = 0; f < mean.length; f++) {
      let m = 0;
      for (let s = 0; s < nS; s++) m += resp[s][f];
      mean[f] = m / nS;
    }
    // Normalise to the mean level of the "after" configuration so both views share an axis.
    let ref = 0;
    const refResp = proposal.responses;
    for (let s = 0; s < refResp.length; s++) for (let f = 0; f < refResp[s].length; f++) ref += refResp[s][f];
    ref /= refResp.length * refResp[0].length;
    const st = seats();
    plot.setCurves([
      ...resp.map((r, i) => ({ freqs: result.freqs, db: Array.from(r, (v) => v - ref), color: SEAT_COLORS[i % SEAT_COLORS.length], width: st[i]?.main ? 2.2 : 1.4, label: st[i]?.main ? 'Main seat' : `Seat ${i + 1}` })),
      nS > 1 ? { freqs: result.freqs, db: Array.from(mean, (v) => v - ref), color: '#ffffff', width: 2.6, dash: [6, 4], label: 'Average' } : null,
    ]);
  };

  const renderAlternatives = () => {
    clear(altList);
    if (!result) return;
    const all = [result.best, ...result.alternatives];
    all.forEach((r, i) => {
      const row = h(
        'button.alt-item',
        { class: r === proposal ? 'selected' : '', type: 'button' },
        h('span.badge', { class: i === 0 ? 'ok' : '' }, i === 0 ? 'Best' : `#${i + 1}`),
        h('span.grow.ellipsis', r.subs.map((s) => s.label.replace(' corner', '').replace(' (current)', '')).join(' + ')),
        h('span.dim', `seats σ ${r.score.seatStd.toFixed(2)} dB · uneven ${r.score.flatness.toFixed(1)} dB`),
      );
      row.addEventListener('click', () => {
        proposal = r;
        refresh();
      });
      altList.appendChild(row);
    });
  };

  const refresh = () => {
    redrawPlan();
    renderStats();
    renderPlot();
    renderAlternatives();
    applyBtn.disabled = !proposal;
  };

  runBtn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    status.textContent = opts.count >= 3 && opts.move ? 'Searching… (several hundred layouts, a few seconds)' : 'Searching…';
    const st = store.state;
    try {
      const t0 = performance.now();
      const res = await client.run(
        'subOptimize',
        {
          room: st.room,
          listener: { x: st.listener.x, y: st.listener.y, z: st.listener.z },
          current: st.subs.filter((s) => !s.muted).map((s) => ({ x: s.x, y: s.y, z: s.z, delayMs: s.delayMs || 0, polarity: s.polarity || 0, trimDb: s.trimDb || 0 })),
          layout: opts.layout,
          count: opts.count,
          movePositions: opts.move,
          autoAlign: !!st.crossover.autoAlign && st.room.propagation !== false,
          fMax: opts.fMax,
        },
        'subOptimize',
      );
      if (!res || disposer.disposed) return;
      result = res;
      proposal = res.best;
      opts.show = 'after';
      showSeg.setValue('after');
      const b = res.before?.score;
      status.textContent = b
        ? `Seat-to-seat variation ${b.seatStd.toFixed(2)} → ${res.best.score.seatStd.toFixed(2)} dB in ${((performance.now() - t0) / 1000).toFixed(1)} s. Review the layout, then apply it.`
        : `Best layout found in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
      refresh();
    } catch (err) {
      console.error(err);
      status.textContent = `Optimisation failed: ${err.message || err}`;
    } finally {
      running = false;
      runBtn.disabled = false;
    }
  });

  applyBtn.addEventListener('click', () => {
    if (!proposal) return;
    const s = store.state;
    const model = s.subs[0]?.modelId;
    const existing = s.subs.filter((x) => !x.muted);
    const subs = proposal.subs.map((p, i) => {
      const base = existing[i] || makeSub(`sub-${Date.now().toString(36)}${i}`, { x: p.x, y: p.y, z: p.z }, model);
      return { ...base, x: Math.round(p.x * 100) / 100, y: base.y ?? p.y, z: Math.round(p.z * 100) / 100, delayMs: p.delayMs, polarity: p.polarity, trimDb: Math.round((result.refTrim + p.trimDb) * 10) / 10, phaseDeg: 0 };
    });
    store.set('subs', [...subs, ...s.subs.filter((x) => x.muted)]);
    toast(`Applied ${subs.length} subwoofer${subs.length > 1 ? 's' : ''} — the room model is updating`, { type: 'success' });
    // Positions changed: the proposal is now the current configuration.
    result = null;
    proposal = null;
    status.textContent = 'Applied. Run the optimiser again to compare against the new layout, or measure it on the Measurements page.';
    refresh();
  });

  const showSeg = segmented([{ value: 'before', label: 'Current' }, { value: 'after', label: 'Optimised' }], opts.show, (v) => {
    opts.show = v;
    renderPlot();
  });

  disposer.add(store.subscribe(['room', 'listener', 'subs', 'speakers'], () => redrawPlan()));

  const subModel = getHardware(store.state.subs[0]?.modelId)?.name || 'subwoofer';
  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Bass Optimizer'), h('div.muted', `Find subwoofer positions, delays, polarity and levels that give every seat the same bass — then EQ the average. Using ${subModel}.`))),
    h('div.studio-grid',
      h('div.card',
        h('div.card-title', h('h3', icon('sub', 18), 'Setup')),
        h('div.stack',
          h('div.field', h('label', 'Seats to optimise'), segmented(Object.entries(SEAT_LAYOUTS).map(([value, l]) => ({ value, label: l.label })), opts.layout, (v) => { opts.layout = v; result = null; proposal = null; refresh(); })),
          h('div.field', h('label', 'Subwoofers'), segmented([1, 2, 3, 4].map((n) => ({ value: n, label: String(n) })), opts.count, (v) => (opts.count = Number(v)))),
          h('div.field', h('label', 'Optimise up to'), segmented([{ value: 80, label: '80 Hz' }, { value: 120, label: '120 Hz' }, { value: 160, label: '160 Hz' }], opts.fMax, (v) => (opts.fMax = Number(v)))),
          toggle('Search positions (off: keep current positions, tune delay/polarity/level only)', opts.move, (v) => { opts.move = v; redrawPlan(); }),
          h('div.split.wrap', runBtn, applyBtn),
          status,
        ),
      ),
      h('div.card',
        h('div.card-title', h('h3', icon('room', 18), 'Room plan'), h('div.grow'), h('span.dim', 'dots: candidate spots · dashed: current subs')),
        planCanvas,
      ),
      h('div.card.span-2',
        h('div.card-title', h('h3', icon('crossover', 18), 'Bass at each seat'), h('div.grow'), showSeg),
        h('div.plot-box.tall', plotCanvas),
        h('div', { style: { marginTop: '12px' } }, statsEl),
      ),
      h('div.card.span-2',
        h('div.card-title', h('h3', icon('layers', 18), 'Best layouts')),
        altList,
        h('p.dim', { style: { fontSize: '12px', marginTop: '10px' } }, 'The objective minimises the spread between seats first (what EQ cannot fix), then the unevenness of the average, and penalises layouts that cancel much of the output. Delays include the automatic time alignment the receiver applies.'),
      ),
    ),
  );
  requestAnimationFrame(() => {
    if (disposer.disposed) return;
    plot = new ResponsePlot(plotCanvas, { fMin: 20, fMax: opts.fMax >= 160 ? 200 : 160, dbMin: -24, dbMax: 12, dbStep: 6 });
    disposer.add(() => plot.destroy());
    refresh();
  });
  return { el, title: 'Bass Optimizer' };
}
