// AV receiver & amplifier: master volume, amp model, gain staging, channel
// levels/distances, tone + dynamic loudness, auto setup, live power meters.

import { h, icon, clear } from '../dom.js';
import { knob, sliderRow, toggle, select, segmented } from '../components/controls.js';
import { modal } from '../components/overlays.js';
import { RECEIVERS, getReceiver, AMP_CLASSES } from '../../hardware/receivers.js';
import { getHardware } from '../../hardware/index.js';
import { autoSetup, computeRoomCorrection } from '../../audio/calibration.js';
import { formatDb } from '../../util/format.js';
import { clamp } from '../../util/math.js';

export function receiverView(app, params, query, disposer) {
  const store = app.store;
  const r = () => store.state.receiver;
  const display = h('div.avr-display');
  const volKnob = knob({
    label: 'Master volume',
    min: -80,
    max: 18,
    step: 0.5,
    value: r().masterDb,
    size: 150,
    reset: -15,
    format: (v) => (v <= -80 ? 'MUTE' : `${v.toFixed(1)} dB`),
    onInput: (v) => store.set('receiver.masterDb', v),
  });
  volKnob.classList.add('big-knob');
  const renderDisplay = () => {
    const rc = r();
    const pre = getReceiver(rc.preset);
    clear(display);
    display.append(
      h('div.avr-line.big', rc.masterDb <= -80 ? 'MUTE' : `${rc.masterDb > 0 ? '+' : ''}${rc.masterDb.toFixed(1)} dB`),
      h('div.avr-line', `${pre ? pre.name : 'Custom amplifier'} · ${rc.wattsPerChannel} W/ch · ${AMP_CLASSES[rc.ampClass]?.name || rc.ampClass}`),
      h('div.avr-line.small', [rc.pureDirect ? 'PURE DIRECT' : 'TONE', rc.loudness ? 'DYN LOUDNESS' : null, store.state.crossover.enabled ? `XO ${store.state.crossover.frequency}Hz` : 'FULL RANGE', store.state.roomCorrection.enabled ? 'ROOM EQ' : null, store.state.engine.simulation ? 'SIM' : 'BYPASS'].filter(Boolean).join('  ·  ')),
    );
    volKnob.setValue(rc.masterDb);
  };
  disposer.add(store.subscribe(['receiver', 'crossover', 'roomCorrection', 'engine'], renderDisplay));
  renderDisplay();

  // ------------------------------------------------ amplifier
  const ampCard = h('div.card',
    h('div.card-title', h('h3', icon('receiver', 18), 'Amplifier')),
    h('div.stack',
      h('div.field', h('label', 'Receiver / amp model'), select([...RECEIVERS.map((x) => ({ value: x.id, label: `${x.name} — ${x.watts} W/ch` })), { value: 'custom', label: 'Custom…' }], r().preset || 'custom', (v) => {
        const pre = getReceiver(v);
        if (pre) store.patch('receiver', { preset: v, wattsPerChannel: pre.watts, ampClass: pre.ampClass });
        else store.set('receiver.preset', 'custom');
      })),
      sliderRow('Power / channel', { min: 1, max: 1000, step: 1, log: true, value: r().wattsPerChannel, format: (v) => `${Math.round(v)} W`, onInput: (v) => store.patch('receiver', { wattsPerChannel: Math.round(v), preset: 'custom' }) }),
      h('div.field', h('label', 'Output stage'), segmented(Object.entries(AMP_CLASSES).map(([k, v]) => ({ value: k, label: v.name.split(' (')[0] })), r().ampClass, (v) => store.patch('receiver', { ampClass: v, preset: 'custom' }))),
      h('p.dim', { style: { fontSize: '12px' } }, 'Passive speakers use this amplifier; powered speakers and subwoofers use their own built-in amps. Push the volume past the amp’s headroom to hear clipping — tubes saturate gently, Class-D clips hard.'),
      toggle('Voice-coil thermal protection', r().thermal !== false, (v) => store.set('receiver.thermal', v), 'Simulates power compression as voice coils heat up'),
    ),
  );

  // ------------------------------------------------ gain staging
  const stageRows = h('div.stage-rows');
  const stageCard = h('div.card',
    h('div.card-title', h('h3', icon('gauge', 18), 'Gain staging'), h('span.dim', { style: { fontSize: '12px' } }, 'live peak level vs. each stage’s limit')),
    stageRows,
    h('div.hr'),
    sliderRow('Input gain', { min: -24, max: 12, step: 0.5, value: r().inputGainDb || 0, reset: 0, bipolar: true, format: (v) => formatDb(v), onInput: (v) => store.set('receiver.inputGainDb', v) }),
    sliderRow('EQ preamp', { min: -24, max: 12, step: 0.5, value: store.state.eq.preampDb || 0, reset: 0, bipolar: true, format: (v) => formatDb(v), onInput: (v) => store.set('eq.preampDb', v) }),
    toggle('Automatic EQ headroom', store.state.eq.autoHeadroom, (v) => store.set('eq.autoHeadroom', v), 'Lowers the digital level by the largest EQ boost so the DSP never clips'),
    sliderRow('Monitor reference', { min: 70, max: 110, step: 1, value: r().monitorRefSpl ?? 85, reset: 85, format: (v) => `${v} dB SPL = 0 dBFS`, onInput: (v) => store.set('receiver.monitorRefSpl', v) }),
  );
  const stages = [
    { id: 'dsp', label: 'DSP (post-EQ)', hint: '0 dBFS digital ceiling' },
    { id: 'amp', label: 'Amplifier drive', hint: 'rail voltage' },
    { id: 'drv', label: 'Driver excursion', hint: 'mechanical limit' },
    { id: 'out', label: 'Output limiter', hint: 'protects your ears/DAC' },
  ];
  const stageEls = {};
  for (const s of stages) {
    const bar = h('i');
    const val = h('span.mono', '—');
    const led = h('span.led');
    stageRows.appendChild(h('div.stage-row', h('div', h('div', s.label), h('div.dim', { style: { fontSize: '11px' } }, s.hint)), h('div.meter-bar', bar), val, led));
    stageEls[s.id] = { bar, val, led };
  }

  // ------------------------------------------------ tone
  const toneCard = h('div.card',
    h('div.card-title', h('h3', icon('sliders', 18), 'Tone & loudness')),
    toggle('Pure Direct (bypass tone controls)', r().pureDirect, (v) => store.set('receiver.pureDirect', v)),
    sliderRow('Bass', { min: -10, max: 10, step: 0.5, value: r().bass || 0, reset: 0, bipolar: true, format: (v) => formatDb(v), onInput: (v) => { store.set('receiver.bass', v); if (r().pureDirect) store.set('receiver.pureDirect', false); } }),
    sliderRow('Treble', { min: -10, max: 10, step: 0.5, value: r().treble || 0, reset: 0, bipolar: true, format: (v) => formatDb(v), onInput: (v) => { store.set('receiver.treble', v); if (r().pureDirect) store.set('receiver.pureDirect', false); } }),
    toggle('Dynamic loudness (ISO 226 compensation)', r().loudness, (v) => store.set('receiver.loudness', v), 'Adds bass and treble as you turn the volume down, like Audyssey Dynamic EQ'),
    sliderRow('Loudness reference', { min: -30, max: 10, step: 1, value: r().loudnessRefDb ?? 0, reset: 0, format: (v) => `${v} dB`, onInput: (v) => store.set('receiver.loudnessRefDb', v) }),
  );

  // ------------------------------------------------ channels
  const chanBody = h('div.chan-table');
  const renderChannels = () => {
    clear(chanBody);
    const plan = app.engine.plan;
    const s = store.state;
    const rows = [...s.speakers.map((x) => ({ ...x, list: 'speakers' })), ...s.subs.map((x) => ({ ...x, list: 'subs' }))];
    for (const row of rows) {
      const p = plan?.sources.find((x) => x.id === row.id);
      const hw = getHardware(row.modelId);
      const bar = h('i');
      const watts = h('span.mono', '0 W');
      const clip = h('span.led', { 'data-tip': 'Amplifier clipping' });
      const drv = h('span.led', { 'data-tip': 'Driver distortion' });
      const temp = h('span.mono.dim', '');
      chanBody.appendChild(
        h('div.chan-line',
          h('div.chan-name', h('span.badge', { class: row.kind === 'sub' ? 'teal' : 'accent' }, row.kind === 'sub' ? 'SUB' : row.channel), h('div.ellipsis', h('div.ellipsis', { style: { fontWeight: 600 } }, hw?.name), h('div.dim', { style: { fontSize: '11.5px' } }, p ? `${p.distance.toFixed(2)} m · delay ${((p.alignDelay + p.manualDelay) * 1000).toFixed(2)} ms · ${Math.round(p.ampWatts)} W ${row.kind === 'sub' || hw?.active ? 'built-in' : 'AVR'}` : ''))),
          sliderRow('Level', { min: -12, max: 12, step: 0.5, value: row.trimDb || 0, reset: 0, bipolar: true, format: (v) => formatDb(v), onInput: (v) => store.updateItem(row.list, row.id, { trimDb: v }) }),
          h('div.chan-meter', h('div.meter-bar', bar), watts, clip, drv, temp),
          h('div.split', toggle('Mute', !!row.muted, (v) => store.updateItem(row.list, row.id, { muted: v })), toggle('Solo', !!row.solo, (v) => store.updateItem(row.list, row.id, { solo: v }))),
        ),
      );
      meterEls[row.id] = { bar, watts, clip, drv, temp, max: p?.ampWatts || 100 };
    }
  };
  let meterEls = {};
  const reChan = () => {
    meterEls = {};
    renderChannels();
  };
  disposer.add(store.subscribe(['speakers', 'subs', 'receiver.wattsPerChannel', 'room', 'listener'], () => {
    if (!chanBody.querySelector('.dragging') && !chanBody.contains(document.activeElement)) setTimeout(reChan, 0);
  }));
  reChan();

  const runAuto = async () => {
    const res = autoSetup(store.state, { roomFilters: app.engine.roomFilters, sampleRate: app.ctx.sampleRate });
    for (const [id, t] of Object.entries(res.trims)) {
      if (store.state.speakers.some((x) => x.id === id)) store.updateItem('speakers', id, { trimDb: t });
      else store.updateItem('subs', id, { trimDb: t });
    }
    if (res.crossover) store.patch('crossover', res.crossover);
    const rc = computeRoomCorrection({ ...JSON.parse(JSON.stringify(store.state)) }, { roomFilters: app.engine.roomFilters, sampleRate: app.ctx.sampleRate });
    store.patch('roomCorrection', { filters: rc.filters, enabled: true, measuredAt: Date.now() });
    reChan();
    modal((close) => h('div',
      h('h2', 'Auto setup complete'),
      h('ul.report', res.report.map((t) => h('li', t)), h('li', `Room correction: ${rc.filters.length} filters, error ${rc.errorBefore.toFixed(1)} → ${rc.errorAfter.toFixed(1)} dB RMS (${store.state.roomCorrection.fMin}–${store.state.roomCorrection.fMax} Hz)`), h('li', 'Distances compensated automatically (time alignment ON).')),
      h('div.modal-actions', h('a.btn.ghost', { href: '#/studio/eq', onClick: () => close() }, 'View correction'), h('button.btn.primary', { onClick: () => close() }, 'Done')),
    ));
  };

  const chanCard = h('div.card.span-2',
    h('div.card-title', h('h3', icon('speaker', 18), 'Channel levels & distances'),
      h('div.split', toggle('Auto distance (time-align)', store.state.crossover.autoAlign, (v) => store.set('crossover.autoAlign', v)), h('button.btn.small.primary', { onClick: runAuto, 'data-tip': 'Measure with the virtual microphone: set levels, crossover, distances and room EQ' }, icon('mic', 14), 'Auto setup'))),
    chanBody,
  );

  // ------------------------------------------------ meters loop
  const onMeters = (m) => {
    const now = performance.now();
    for (const [id, e] of Object.entries(meterEls)) {
      const s = m.sources[id];
      if (!s) continue;
      e.watts.textContent = `${s.watts < 10 ? s.watts.toFixed(1) : Math.round(s.watts)} W`;
      e.bar.style.width = `${Math.min(100, (s.peakWatts / Math.max(1, e.max)) * 100)}%`;
      e.bar.style.setProperty('--full', `${e.bar.parentElement.clientWidth}px`);
      e.clip.className = `led ${now - s.clipAt < 300 ? 'on red' : ''}`;
      e.drv.className = `led ${now - s.stressAt < 300 ? 'on amber' : ''}`;
      e.temp.textContent = s.temp > 0.05 ? `${Math.round(s.temp * 100)}%` : '';
    }
    // Gain staging: DSP peak (dBFS), amp/driver load relative to limits.
    const srcs = Object.values(m.sources);
    const ampLoad = srcs.reduce((a, s) => Math.max(a, s.ampLoad || 0), 0);
    const drvStress = srcs.some((s) => now - s.stressAt < 300);
    const dsp = app.engine.taps;
    const buf = stageBuf;
    let pk = 0;
    for (const a of [dsp.dspL, dsp.dspR]) {
      a.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
    }
    const setStage = (id, frac, text, state) => {
      const e = stageEls[id];
      e.bar.style.width = `${clamp(frac, 0, 1) * 100}%`;
      e.bar.style.setProperty('--full', `${e.bar.parentElement.clientWidth}px`);
      e.val.textContent = text;
      e.led.className = `led on ${state}`;
    };
    const pkDb = pk > 1e-6 ? 20 * Math.log10(pk) : -90;
    setStage('dsp', (pkDb + 40) / 40, `${pkDb.toFixed(1)} dBFS`, now - m.dspOverAt < 400 ? 'red' : pkDb > -3 ? 'amber' : 'green');
    setStage('amp', ampLoad, `${Math.round(ampLoad * 100)}%`, ampLoad >= 0.94 ? 'red' : ampLoad > 0.8 ? 'amber' : 'green');
    setStage('drv', drvStress ? 1 : ampLoad * 0.7, drvStress ? 'LIMIT' : 'OK', drvStress ? 'amber' : 'green');
    setStage('out', clamp(-m.limiterDb / 12, 0, 1), `${m.limiterDb.toFixed(1)} dB`, m.limiterDb < -3 ? 'red' : m.limiterDb < -0.5 ? 'amber' : 'green');
    splEl.textContent = app.player.playing && m.spl > 20 ? `${m.spl.toFixed(1)}` : '—';
  };
  const stageBuf = new Float32Array(256);
  const splEl = h('span');
  disposer.add(app.engine.on('meters', onMeters));

  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Receiver & Amplifier'), h('div.muted', 'Gain staging from the DSP to the drivers. Watch the amplifier and drivers work in real time.'))),
    h('div.avr-panel',
      h('div.avr-left', display, h('div.avr-buttons',
        h('button.avr-btn', { class: r().pureDirect ? 'on' : '', onClick: () => store.set('receiver.pureDirect', !r().pureDirect) }, 'PURE DIRECT'),
        h('button.avr-btn', { class: r().loudness ? 'on' : '', onClick: () => store.set('receiver.loudness', !r().loudness) }, 'LOUDNESS'),
        h('button.avr-btn', { class: store.state.engine.simulation ? 'on' : '', onClick: () => app.toggleSimulation() }, 'SIMULATION'),
        h('button.avr-btn', { onClick: runAuto }, 'AUTO SETUP'),
      )),
      h('div.avr-spl', h('div.stat-label', 'SPL at seat'), h('div.avr-spl-val', splEl, h('small', ' dB'))),
      volKnob,
    ),
    h('div.studio-grid', ampCard, stageCard, toneCard, chanCard),
  );
  // Keep the front-panel buttons in sync.
  disposer.add(store.subscribe(['receiver', 'engine'], () => {
    const btns = el.querySelectorAll('.avr-btn');
    btns[0].classList.toggle('on', !!r().pureDirect);
    btns[1].classList.toggle('on', !!r().loudness);
    btns[2].classList.toggle('on', !!store.state.engine.simulation);
  }));
  return { el, title: 'Receiver & Amp' };
}
