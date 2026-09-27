// Top bar: history navigation, live search, audio engine status, A/B
// simulation bypass, SPL readout, live recording and help.

import { h, icon, debounce } from '../dom.js';
import { toast } from '../components/overlays.js';
import { LiveRecorder } from '../../audio/bake.js';
import { formatTime } from '../../util/format.js';

export function createTopbar(app) {
  const input = h('input', { type: 'search', placeholder: 'What do you want to hear?', 'aria-label': 'Search library', autocomplete: 'off', spellcheck: 'false' });
  const clearBtn = h('button.icon-btn.small', { 'aria-label': 'Clear search', hidden: true }, icon('close', 14));
  const search = h('label.search-box', icon('search', 18), input, clearBtn);
  const go = debounce((q) => {
    // Only navigate while the user is still searching (the box has focus or
    // the search page is showing) — never yank them away from another view.
    if (document.activeElement !== input && app.router.current?.name !== 'search') return;
    app.router.go(q ? `search?q=${encodeURIComponent(q)}` : 'search', { replace: app.router.current?.name === 'search' });
  }, 120);
  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    go(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      clearBtn.hidden = true;
      go('');
    }
  });
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = '';
    clearBtn.hidden = true;
    go('');
    input.focus();
  });

  const engineChip = h('button.chip.engine-chip', { 'data-tip': 'Audio engine status' });
  const simBtn = h('button.chip.sim-chip', { 'data-tip': 'A/B compare: toggle the room/hardware simulation (B)', onClick: () => app.toggleSimulation() });
  const splChip = h('div.chip.spl-chip', { 'data-tip': 'Estimated SPL at the listening position' }, icon('gauge', 14), h('span.mono', '— dB'));
  const recBtn = h('button.icon-btn', { 'aria-label': 'Record output', 'data-tip': 'Record the simulated output to WAV' }, icon('record', 18));
  const recTime = h('span.mono.rec-time', { hidden: true });
  const help = h('button.icon-btn', { 'aria-label': 'Keyboard shortcuts', 'data-tip': 'Keyboard shortcuts (?)', onClick: () => app.showShortcuts() }, icon('keyboard', 18));

  const el = h(
    'header.topbar',
    h('button.icon-btn.nav-hist', { 'aria-label': 'Back', onClick: () => history.back() }, icon('back', 18)),
    h('button.icon-btn.nav-hist', { 'aria-label': 'Forward', onClick: () => history.forward() }, icon('forward', 18)),
    search,
    h('div.spacer'),
    splChip,
    simBtn,
    engineChip,
    recTime,
    recBtn,
    help,
  );

  const renderEngine = () => {
    const st = app.ctx.state;
    engineChip.innerHTML = '';
    const on = st === 'running';
    engineChip.append(h('span.led', { class: on ? 'on green' : 'on amber' }), h('span', on ? `${Math.round(app.ctx.sampleRate / 100) / 10} kHz · ${app.store.get('engine.output') === 'speakers' ? 'Speakers' : 'HRTF'}` : 'Audio paused — click to start'));
    engineChip.classList.toggle('attention', !on);
  };
  engineChip.addEventListener('click', async () => {
    const ok = await app.audio.unlock();
    if (ok) app.go('settings');
  });
  app.audio.on('state', renderEngine);
  app.store.subscribe(['engine.output'], renderEngine);

  const renderSim = () => {
    const on = app.store.get('engine.simulation');
    simBtn.innerHTML = '';
    simBtn.append(icon(on ? 'room' : 'headphones', 14), h('span', on ? 'SIM' : 'BYPASS'));
    simBtn.classList.toggle('active', !!on);
  };
  app.store.subscribe(['engine.simulation'], renderSim);

  const splText = splChip.querySelector('span.mono');
  app.engine.on('meters', (m) => {
    const playing = app.player.playing && app.store.get('engine.simulation');
    splText.textContent = playing && m.spl > 20 ? `${Math.round(m.spl)} dB` : '— dB';
    splChip.classList.toggle('loud', playing && m.spl > 100);
  });

  // Live recording
  let recorder = null;
  let recTimer = null;
  recBtn.addEventListener('click', async () => {
    if (!recorder || !recorder.recording) {
      try {
        await app.audio.unlock();
        recorder = new LiveRecorder(app.engine);
        await recorder.start();
        recBtn.classList.add('recording');
        recTime.hidden = false;
        recTimer = setInterval(() => (recTime.textContent = formatTime(recorder.seconds)), 250);
        toast('Recording the simulated output… click again to stop');
      } catch (err) {
        toast(`Recording failed: ${err.message || err}`, { type: 'error' });
      }
    } else {
      clearInterval(recTimer);
      recBtn.classList.remove('recording');
      recTime.hidden = true;
      const blob = await recorder.stop();
      if (blob && blob.size > 100) {
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: `audiospace-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${blob.type.includes('wav') ? 'wav' : 'webm'}` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        toast('Recording saved', { type: 'success' });
      }
    }
  });

  renderEngine();
  renderSim();

  return {
    el,
    setSolid: (on) => el.classList.toggle('solid', on),
    focusSearch: () => {
      input.focus();
      input.select();
    },
    onRoute: (route) => {
      if (route.name !== 'search' && document.activeElement !== input) go.cancel();
      if (route.name === 'search') {
        const q = route.query.q || '';
        if (document.activeElement !== input) input.value = q;
        clearBtn.hidden = !input.value;
      }
    },
  };
}
