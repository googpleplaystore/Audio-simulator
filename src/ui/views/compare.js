// Scenes & blind testing: save/recall complete system snapshots and compare
// two of them with a level-matched ABX test.

import { h, icon, clear } from '../dom.js';
import { segmented, select, toggle } from '../components/controls.js';
import { toast, promptDialog, openMenu, confirmDialog } from '../components/overlays.js';
import { captureScene, applyScene, stateWithScene, predictedLoudness, exampleScenes, binomialPValue, abxSequence, SCENE_KEYS } from '../../core/scenes.js';

function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function compareView(app, params, query, disposer) {
  const store = app.store;
  const scenes = () => store.state.scenes || [];
  const setScenes = (list) => store.set('scenes', list);

  // ------------------------------------------------------------ scenes
  const list = h('div.stack.tight');
  const saveCurrent = async () => {
    const name = await promptDialog('Save scene', { value: `Scene ${scenes().length + 1}`, label: 'Name', ok: 'Save' });
    if (!name) return;
    setScenes([captureScene(store.state, name), ...scenes()].slice(0, 30));
    toast(`Saved “${name}”`, { type: 'success' });
  };
  const load = (sc) => {
    applyScene(store, sc);
    toast(`Loaded “${sc.name}”`, { type: 'success' });
  };
  const sceneMenu = (sc, x, y) =>
    openMenu(x, y, [
      { label: 'Load', icon: 'play', onClick: () => load(sc) },
      { label: 'Update with current settings', icon: 'save', onClick: () => setScenes(scenes().map((s) => (s.id === sc.id ? { ...captureScene(store.state, sc.name), id: sc.id } : s))) },
      { label: 'Rename…', icon: 'edit', onClick: async () => { const n = await promptDialog('Rename scene', { value: sc.name }); if (n) setScenes(scenes().map((s) => (s.id === sc.id ? { ...s, name: n } : s))); } },
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => setScenes(scenes().filter((s) => s.id !== sc.id)) },
    ]);
  const renderList = () => {
    clear(list);
    if (!scenes().length) {
      list.append(
        h('p.dim', 'No scenes yet. Save your current system, or start from a few examples.'),
        h('button.btn.small', { onClick: () => setScenes([...exampleScenes(), ...scenes()]) }, icon('sparkle', 14), 'Add example scenes'),
      );
      return;
    }
    for (const sc of scenes()) {
      list.appendChild(
        h('div.scene-item',
          h('div.grow.ellipsis', h('div.ellipsis.meas-name', sc.name), h('div.dim.ellipsis', `${sc.summary} · ${formatDate(sc.createdAt)}`)),
          h('button.btn.small', { onClick: () => load(sc) }, 'Load'),
          h('button.icon-btn', { 'aria-label': `Actions for ${sc.name}`, onClick: (e) => { const r = e.currentTarget.getBoundingClientRect(); sceneMenu(sc, r.left, r.bottom); } }, icon('more', 18)),
        ),
      );
    }
  };

  // ------------------------------------------------------------ ABX
  const abx = { a: null, b: null, trials: 16, levelMatch: true, running: null };
  const abxBox = h('div.abx');
  const sceneOptions = () => [{ value: '', label: 'Choose a scene…' }, ...scenes().map((s) => ({ value: s.id, label: s.name }))];

  const finish = (showResult) => {
    const t = abx.running;
    if (!t) return;
    // Restore exactly what the user had before the test.
    for (const k of SCENE_KEYS) store.set(k, t.original[k]);
    store.set('engine.trimDb', 0);
    abx.running = null;
    if (showResult) renderResult(t);
    else renderSetup();
  };
  disposer.add(() => finish(false));

  const activate = (which) => {
    const t = abx.running;
    const v = which === 'X' ? t.seq[t.i] : which;
    const sc = v === 'A' ? t.A : t.B;
    applyScene(store, sc);
    store.set('engine.trimDb', v === 'A' ? t.trimA : t.trimB);
    t.active = which;
    renderTrial();
  };

  const start = () => {
    const A = scenes().find((s) => s.id === abx.a);
    const B = scenes().find((s) => s.id === abx.b);
    if (!A || !B || A.id === B.id) {
      toast('Choose two different scenes for A and B', { type: 'error' });
      return;
    }
    const original = Object.fromEntries(SCENE_KEYS.map((k) => [k, JSON.parse(JSON.stringify(store.state[k]))]));
    let trimA = 0;
    let trimB = 0;
    if (abx.levelMatch) {
      const la = predictedLoudness(stateWithScene(store.state, A), app.ctx.sampleRate);
      const lb = predictedLoudness(stateWithScene(store.state, B), app.ctx.sampleRate);
      // Turn the louder one down (never boost).
      trimA = Math.min(0, lb - la);
      trimB = Math.min(0, la - lb);
    }
    abx.running = { A, B, seq: abxSequence(abx.trials), i: 0, answers: [], original, trimA, trimB, active: null };
    activate('A');
  };

  const answer = (guess) => {
    const t = abx.running;
    t.answers.push(guess);
    t.i++;
    if (t.i >= t.seq.length) finish(true);
    else activate('X');
  };

  const renderSetup = () => {
    clear(abxBox);
    const selA = select(sceneOptions(), abx.a || '', (v) => (abx.a = v || null), { 'aria-label': 'Scene A' });
    const selB = select(sceneOptions(), abx.b || '', (v) => (abx.b = v || null), { 'aria-label': 'Scene B' });
    abxBox.append(
      h('p.muted', 'Blind-compare two scenes. Listen to A and B, then decide whether X is A or B. X is randomised every trial; the score is only revealed at the end.'),
      h('div.abx-pick', h('div.field', h('label', 'A'), selA), h('div.field', h('label', 'B'), selB)),
      h('div.field', h('label', 'Trials'), segmented([{ value: 10, label: '10' }, { value: 16, label: '16' }, { value: 20, label: '20' }], abx.trials, (v) => (abx.trials = Number(v)))),
      toggle('Level-match A and B (predicted loudness at the seat)', abx.levelMatch, (v) => (abx.levelMatch = v)),
      h('div.split.wrap',
        h('button.btn.primary', { onClick: start, disabled: scenes().length < 2 }, icon('play', 16), 'Start blind test'),
        app.player.track ? null : h('span.dim', 'Tip: start playing a song first — switching happens live.'),
      ),
    );
  };

  const renderTrial = () => {
    const t = abx.running;
    clear(abxBox);
    const btn = (which) => h('button.abx-btn', { class: t.active === which ? 'active' : '', onClick: () => activate(which), 'aria-pressed': t.active === which ? 'true' : 'false' }, which);
    abxBox.append(
      h('div.split', h('span.badge.accent', `Trial ${t.i + 1} / ${t.seq.length}`), h('div.grow'), h('button.btn.small.ghost', { onClick: async () => { if (await confirmDialog('Abort the test?', 'Your settings will be restored.', { ok: 'Abort' })) finish(false); } }, 'Abort')),
      h('div.abx-row', btn('A'), btn('X'), btn('B')),
      h('div.abx-answer', h('span.dim', 'X is…'), h('button.btn', { onClick: () => answer('A') }, 'A'), h('button.btn', { onClick: () => answer('B') }, 'B')),
      h('p.dim', { style: { fontSize: '12px' } }, `A: ${t.A.name} · B: ${t.B.name}${abx.levelMatch ? ` · level-matched (${Math.abs(t.trimA - t.trimB).toFixed(1)} dB)` : ''}`),
    );
  };

  const renderResult = (t) => {
    clear(abxBox);
    const n = t.seq.length;
    const k = t.answers.filter((a, i) => a === t.seq[i]).length;
    const p = binomialPValue(k, n);
    const heard = p < 0.05;
    abxBox.append(
      h('div.abx-result',
        h('div.abx-score', `${k} / ${n}`),
        h('div', h('div', { style: { fontWeight: 700, fontSize: '16px' } }, heard ? 'You can reliably hear a difference.' : 'No reliable difference detected.'), h('div.dim', `p = ${p < 0.001 ? '< 0.001' : p.toFixed(3)} (chance of scoring this well by guessing)`)),
      ),
      h('div.abx-trials', t.seq.map((x, i) => h('span.badge', { class: t.answers[i] === x ? 'ok' : 'danger', 'data-tip': `Trial ${i + 1}: X was ${x}, you said ${t.answers[i]}` }, x))),
      h('p.dim', { style: { fontSize: '12px' } }, `A: ${t.A.name} · B: ${t.B.name}. Your original settings have been restored.`),
      h('button.btn', { onClick: renderSetup }, icon('refresh', 16), 'New test'),
    );
  };

  disposer.add(store.subscribe(['scenes'], () => {
    renderList();
    if (!abx.running && !abxBox.querySelector('.abx-result')) renderSetup();
  }));

  // Keyboard: A / B / X to switch, 1 / 2 to answer.
  const onKey = (e) => {
    if (!abx.running || e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'b' || k === 'x') {
      e.preventDefault();
      e.stopPropagation();
      activate(k.toUpperCase());
    } else if (k === '1' || k === '2') {
      e.preventDefault();
      e.stopPropagation();
      answer(k === '1' ? 'A' : 'B');
    }
  };
  window.addEventListener('keydown', onKey, true);
  disposer.add(() => window.removeEventListener('keydown', onKey, true));

  renderList();
  renderSetup();
  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Scenes & Blind Test'), h('div.muted', 'Save complete systems — speakers, room, amp, crossover and EQ — recall them instantly, and find out whether you can really hear the difference.'))),
    h('div.studio-grid',
      h('div.card',
        h('div.card-title', h('h3', icon('layers', 18), 'Scenes'), h('div.grow'), h('button.btn.small.primary', { onClick: saveCurrent }, icon('save', 14), 'Save current')),
        list,
      ),
      h('div.card',
        h('div.card-title', h('h3', icon('headphones', 18), 'ABX blind test')),
        abxBox,
        h('p.dim', { style: { fontSize: '12px', marginTop: '12px' } }, 'Keys during a test: A / B / X switch, 1 answers “A”, 2 answers “B”.'),
      ),
    ),
  );
  return { el, title: 'Scenes & Blind Test' };
}
