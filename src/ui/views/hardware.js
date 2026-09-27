// Hardware catalogue: browse, filter, compare and assign the Top-100
// bookshelf speakers and subwoofers.

import { h, icon, clear, debounce } from '../dom.js';
import { segmented, select } from '../components/controls.js';
import { toast, modal } from '../components/overlays.js';
import { ResponsePlot } from '../../viz/responsePlot.js';
import { hardwareSvg } from '../hardwareArt.js';
import { specLine } from '../components/modelPicker.js';
import { getBookshelfSpeakers, getSubwoofers, getHardware, responseCurve, soundTags, exportDatabase } from '../../hardware/index.js';
import { formatPrice, formatHz } from '../../util/format.js';
import { logspace } from '../../util/math.js';
import { notFound } from './library.js';

const COMPARE_COLORS = ['#8d7dff', '#36e2cf', '#ffb547', '#ff6b9a'];
const compareSet = new Set();

function assignActions(app, hw, compact = false) {
  const store = app.store;
  if (hw.category === 'subwoofer') {
    return h('div.split.wrap', { style: { gap: '6px' } },
      h('button.btn.small.primary', { onClick: (e) => { e.preventDefault(); useSub(app, hw); } }, icon('sub', 14), compact ? 'Use' : 'Use as subwoofer'),
    );
  }
  const set = (channels) => {
    let n = 0;
    for (const sp of store.state.speakers) {
      if (channels.includes(sp.channel)) {
        store.updateItem('speakers', sp.id, { modelId: hw.id });
        n++;
      }
    }
    toast(n ? `${hw.name} → ${channels.join('/')}` : `No ${channels.join('/')} speaker in the room`);
  };
  return h('div.split.wrap', { style: { gap: '6px' } },
    h('button.btn.small.primary', { onClick: (e) => { e.preventDefault(); set(['L', 'R']); } }, icon('speaker', 14), compact ? 'Use L+R' : 'Use as L + R'),
    compact ? null : h('button.btn.small', { onClick: (e) => { e.preventDefault(); set(['L', 'R', 'C', 'SL', 'SR', 'M']); } }, 'All speakers'),
  );
}

function useSub(app, hw) {
  const subs = app.store.state.subs;
  if (!subs.length) {
    toast('No subwoofer in the room — add one in the Room Simulator');
    return;
  }
  for (const s of subs) app.store.updateItem('subs', s.id, { modelId: hw.id });
  toast(`${hw.name} is now your subwoofer`);
}

function card(app, hw, onCompare) {
  const tags = soundTags(hw).slice(0, 3);
  const cmp = h('input', { type: 'checkbox', checked: compareSet.has(hw.id), 'aria-label': 'Compare' });
  cmp.addEventListener('click', (e) => e.stopPropagation());
  cmp.addEventListener('change', () => {
    if (cmp.checked) {
      if (compareSet.size >= 4) {
        cmp.checked = false;
        toast('Compare up to 4 models');
        return;
      }
      compareSet.add(hw.id);
    } else compareSet.delete(hw.id);
    onCompare();
  });
  return h(
    'a.hw-card',
    { href: `#/studio/hardware/${hw.id}` },
    h('div.hw-rank', `#${hw.rank}`),
    h('label.hw-compare', { 'data-tip': 'Add to comparison', onClick: (e) => e.stopPropagation() }, cmp, h('span', 'Compare')),
    h('div.hw-art', { html: hardwareSvg(hw, { width: hw.category === 'subwoofer' ? 118 : 96 }) }),
    h('div.hw-body',
      h('div.hw-brand', hw.brand),
      h('div.hw-model.ellipsis', hw.model),
      h('div.hw-spec', specLine(hw)),
      h('div.split.wrap', { style: { gap: '4px', marginTop: '8px' } },
        h('span.badge', hw.priceBracket),
        h('span.badge', { class: hw.specSource === 'published' ? 'ok' : 'warn', 'data-tip': hw.specSource === 'published' ? 'Manufacturer-published specifications' : 'Specs extrapolated by the physics model' }, hw.specSource === 'published' ? 'Published' : 'Extrapolated'),
        tags.map((t) => h('span.badge.accent', t)),
      ),
      h('div.hw-foot', h('span.hw-price', formatPrice(hw.price)), assignActions(app, hw, true)),
    ),
  );
}

export function hardwareView(app, params, query, disposer) {
  let cat = query.cat === 'subwoofer' ? 'subwoofer' : 'bookshelf';
  const filters = { q: '', brand: '', price: '', enclosure: '', power: '', sort: 'rank' };
  const grid = h('div.hw-grid');
  const count = h('span.muted');
  const compareBar = h('div.compare-bar', { hidden: true });
  const brandSel = h('select.select');
  const renderBrands = () => {
    const list = cat === 'subwoofer' ? getSubwoofers() : getBookshelfSpeakers();
    const brands = [...new Set(list.map((x) => x.brand))].sort();
    clear(brandSel);
    brandSel.appendChild(h('option', { value: '' }, 'All brands'));
    for (const b of brands) brandSel.appendChild(h('option', { value: b }, b));
    brandSel.value = filters.brand;
  };
  brandSel.addEventListener('change', () => {
    filters.brand = brandSel.value;
    render();
  });
  const renderCompare = () => {
    clear(compareBar);
    compareBar.hidden = !compareSet.size;
    if (!compareSet.size) return;
    compareBar.append(
      h('span', icon('compare', 16), ` ${compareSet.size} selected`),
      [...compareSet].map((id) => h('span.badge.accent', getHardware(id)?.name)),
      h('div.grow'),
      h('button.btn.small.ghost', { onClick: () => { compareSet.clear(); renderCompare(); render(); } }, 'Clear'),
      h('button.btn.small.primary', { disabled: compareSet.size < 2, onClick: () => openCompare() }, 'Compare'),
    );
  };
  const render = () => {
    const list = (cat === 'subwoofer' ? getSubwoofers() : getBookshelfSpeakers()).filter((hw) => {
      if (filters.q && !`${hw.name} ${hw.signature}`.toLowerCase().includes(filters.q)) return false;
      if (filters.brand && hw.brand !== filters.brand) return false;
      if (filters.price && hw.priceBracket !== filters.price) return false;
      if (filters.enclosure && hw.enclosure !== filters.enclosure) return false;
      if (filters.power === 'active' && !hw.active) return false;
      if (filters.power === 'passive' && hw.active) return false;
      return true;
    });
    const sorters = {
      rank: (a, b) => a.rank - b.rank,
      'price-asc': (a, b) => a.price - b.price,
      'price-desc': (a, b) => b.price - a.price,
      bass: (a, b) => a.f3 - b.f3,
      power: (a, b) => b.rmsWatts - a.rmsWatts,
      spl: (a, b) => b.maxSpl - a.maxSpl,
      sensitivity: (a, b) => (b.sensitivity || 0) - (a.sensitivity || 0),
    };
    list.sort(sorters[filters.sort] || sorters.rank);
    clear(grid);
    for (const hw of list) grid.appendChild(card(app, hw, () => renderCompare()));
    count.textContent = `${list.length} of 100 ${cat === 'subwoofer' ? 'subwoofers' : 'bookshelf speakers'}`;
  };
  const search = h('input.input', { type: 'search', placeholder: 'Filter models…', style: { width: '220px' } });
  search.addEventListener('input', debounce(() => {
    filters.q = search.value.trim().toLowerCase();
    render();
  }, 100));
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const powerSeg = segmented([{ value: '', label: 'All' }, { value: 'active', label: 'Powered' }, { value: 'passive', label: 'Passive' }], '', (v) => { filters.power = v; render(); });
  const tabs = segmented([{ value: 'bookshelf', label: 'Bookshelf Speakers' }, { value: 'subwoofer', label: 'Subwoofers' }], cat, (v) => {
    cat = v;
    filters.brand = '';
    powerSeg.style.display = cat === 'subwoofer' ? 'none' : '';
    renderBrands();
    render();
  });
  const openCompare = () => {
    const models = [...compareSet].map(getHardware).filter(Boolean);
    modal((close) => {
      const cv = h('canvas.compare-plot');
      const rows = [
        ['Price', (m) => formatPrice(m.price)],
        ['Driver', (m) => (m.category === 'subwoofer' ? `${m.driver.count > 1 ? `${m.driver.count}× ` : ''}${m.driver.size}″` : `${m.woofer.size}″ + ${m.tweeter.type}`)],
        ['Enclosure', (m) => m.enclosure],
        ['Range', (m) => `${m.freqLow} Hz – ${formatHz(m.freqHigh)}`],
        ['f3 (−3 dB)', (m) => `${m.f3} Hz`],
        ['Power', (m) => `${m.rmsWatts} W${m.active ? ' (amp)' : ''}`],
        ['Sensitivity', (m) => (m.sensitivity ? `${m.sensitivity} dB` : '—')],
        ['Max SPL', (m) => `${m.maxSpl} dB`],
        ['Voicing', (m) => m.signature],
      ];
      const table = h('table.spec-table', h('thead', h('tr', h('th'), models.map((m, i) => h('th', { style: { color: COMPARE_COLORS[i] } }, m.name)))), h('tbody', rows.map(([k, fn]) => h('tr', h('td.dim', k), models.map((m) => h('td', fn(m)))))));
      requestAnimationFrame(() => {
        if (!cv.isConnected) return;
        const plot = new ResponsePlot(cv, { fMin: 10, fMax: 24000, dbMin: -30, dbMax: 12 });
        plot.setCurves(models.map((m, i) => {
          const r = responseCurve(m);
          return { freqs: r.freqs, db: r.db, color: COMPARE_COLORS[i], width: 2, label: m.model };
        }));
      });
      return h('div', h('div.split', h('h2', 'Compare models'), h('div.grow'), h('button.icon-btn', { onClick: () => close() }, icon('close', 18))), h('div.plot-box', cv), table);
    }, { wide: true });
  };
  renderBrands();
  render();
  renderCompare();
  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Hardware Catalog'), h('div.muted', 'The Top 100 best-selling bookshelf speakers and subwoofers, each with a physically-modelled response.')),
      h('button.btn.small.ghost', { onClick: () => downloadJson(exportDatabase(), 'audiospace-hardware-db.json') }, icon('download', 14), 'Database JSON')),
    h('div.hw-toolbar', tabs, h('div.split', icon('search', 16), search), brandSel,
      select([{ value: '', label: 'Any price' }, { value: '$', label: '$ Budget' }, { value: '$$', label: '$$ Mid' }, { value: '$$$', label: '$$$ Upper' }, { value: '$$$$', label: '$$$$ Premium' }], '', (v) => { filters.price = v; render(); }),
      select([{ value: '', label: 'Any enclosure' }, { value: 'ported', label: 'Ported' }, { value: 'sealed', label: 'Sealed' }, { value: 'pr', label: 'Passive radiator' }], '', (v) => { filters.enclosure = v; render(); }),
      powerSeg,
      select([{ value: 'rank', label: 'Sort: Best-seller rank' }, { value: 'price-asc', label: 'Price ↑' }, { value: 'price-desc', label: 'Price ↓' }, { value: 'bass', label: 'Deepest bass' }, { value: 'power', label: 'Most power' }, { value: 'spl', label: 'Loudest (max SPL)' }, { value: 'sensitivity', label: 'Most sensitive' }], 'rank', (v) => { filters.sort = v; render(); }),
      count,
    ),
    compareBar,
    grid,
    h('p.dim', { style: { fontSize: '12px', marginTop: '24px' } }, 'Rankings are illustrative (Amazon best-seller ranks change hourly). “Published” entries follow manufacturer specifications; “Extrapolated” entries derive their full spec sheets from driver size, enclosure, amplifier power and price tier using loudspeaker physics.'),
  );
  return { el, title: 'Hardware Catalog' };
}

export function hardwareDetailView(app, params, query, disposer) {
  const hw = getHardware(params.id);
  if (!hw) return notFound('Model not found');
  const cv = h('canvas.detail-plot');
  const isSub = hw.category === 'subwoofer';
  const specs = isSub
    ? [
      ['Driver', `${hw.driver.count > 1 ? `${hw.driver.count}× ` : ''}${hw.driver.size}″ ${hw.driver.material}`],
      ['Enclosure', `${hw.enclosure}${hw.port ? ` (${hw.port} port)` : ''}`],
      ['Frequency range', `${hw.freqLow} – ${hw.freqHigh} Hz`],
      ['−3 dB point', `${hw.f3} Hz`],
      ['Amplifier', `${hw.rmsWatts} W RMS / ${hw.peakWatts} W peak`],
      ['Max SPL (1 m, est.)', `${hw.maxSpl} dB`],
      ['Low-pass range', `${hw.lpfRange[0]}–${hw.lpfRange[1]} Hz`],
      ['Phase control', hw.phase],
      ['Dimensions (est.)', `${hw.dims.w} × ${hw.dims.h} × ${hw.dims.d} cm`],
      ['Price', `${formatPrice(hw.price)} (${hw.priceBracket})`],
    ]
    : [
      ['Woofer', `${hw.woofer.size}″ ${hw.woofer.material}`],
      ['Tweeter', `${hw.tweeter.size ? `${hw.tweeter.size}″ ` : ''}${hw.tweeter.material}`],
      ['Design', `${hw.ways}-way, ${hw.enclosure === 'pr' ? 'passive radiator' : hw.enclosure}${hw.port ? ` (${hw.port} port)` : ''}`],
      ['Frequency range', `${hw.freqLow} Hz – ${formatHz(hw.freqHigh)}`],
      ['−3 dB point', `${hw.f3} Hz`],
      [hw.active ? 'Built-in amplifier' : 'Power handling', hw.active ? `${hw.ampWatts} W per channel` : `${hw.rmsWatts} W RMS / ${hw.peakWatts} W peak`],
      ['Sensitivity', `${hw.sensitivity} dB (2.83 V / 1 m)${hw.active ? ' (equiv.)' : ''}`],
      ['Impedance', `${hw.impedance} Ω`],
      ['Crossover', hw.crossoverHz ? formatHz(hw.crossoverHz) : '—'],
      ['Recommended amp', hw.recommendedAmp ? `${hw.recommendedAmp[0]}–${hw.recommendedAmp[1]} W` : '—'],
      ['Max SPL (1 m, est.)', `${hw.maxSpl} dB`],
      ['Dimensions (est.)', `${hw.dims.w} × ${hw.dims.h} × ${hw.dims.d} cm`],
      ['Price (pair)', `${formatPrice(hw.price)} (${hw.priceBracket})`],
    ];
  requestAnimationFrame(() => {
    if (disposer.disposed) return;
    const plot = new ResponsePlot(cv, { fMin: isSub ? 10 : 20, fMax: isSub ? 500 : 24000, dbMin: -30, dbMax: 12 });
    disposer.add(() => plot.destroy());
    const r = responseCurve(hw, logspace(isSub ? 8 : 15, isSub ? 600 : 24000, 300));
    plot.markers = [{ f: hw.f3, color: 'rgba(255,181,71,0.8)', label: `f3 ${hw.f3} Hz` }];
    if (hw.crossoverHz) plot.markers.push({ f: hw.crossoverHz, color: 'rgba(54,226,207,0.7)', label: 'Internal crossover' });
    plot.setCurves([{ freqs: r.freqs, db: r.db, color: '#8d7dff', width: 2.5, glow: true, fill: 'rgba(141,125,255,0.12)', fillTo: -30, label: 'Modelled anechoic on-axis response' }]);
  });
  const similar = (isSub ? getSubwoofers() : getBookshelfSpeakers()).filter((x) => x.id !== hw.id && Math.abs(Math.log(x.price / hw.price)) < 0.4).slice(0, 6);
  const el = h(
    'div.view-inner',
    h('a.btn.small.ghost', { href: `#/studio/hardware${isSub ? '?cat=subwoofer' : ''}` }, icon('back', 14), 'Catalog'),
    h('div.detail-head',
      h('div.detail-art', { html: hardwareSvg(hw, { width: isSub ? 220 : 170 }) }),
      h('div.grow',
        h('div.hero-kind', `#${hw.rank} best-selling ${isSub ? 'subwoofer' : 'bookshelf speaker'}`),
        h('h1', hw.name),
        h('div.muted', { style: { marginTop: '6px' } }, hw.signature),
        h('div.split.wrap', { style: { marginTop: '12px', gap: '6px' } },
          soundTags(hw).map((t) => h('span.badge.accent', t)),
          h('span.badge', { class: hw.specSource === 'published' ? 'ok' : 'warn' }, hw.specSource === 'published' ? 'Published specs' : 'Extrapolated specs'),
          hw.features.map((f) => h('span.badge', f)),
        ),
        h('div', { style: { marginTop: '16px' } }, assignActions(app, hw)),
      ),
    ),
    h('div.detail-grid',
      h('div.card', h('div.card-title', h('h3', 'Specifications')), h('table.spec-table', h('tbody', specs.map(([k, v]) => h('tr', h('td.dim', k), h('td', v)))))),
      h('div.card', h('div.card-title', h('h3', 'Modelled frequency response')), h('div.plot-box', cv),
        h('p.dim', { style: { fontSize: '12px', marginTop: '8px' } }, `Enclosure roll-off (${hw.enclosure === 'sealed' ? '12 dB/oct, Qtc ' + hw.qtc : '24 dB/oct vented alignment'}), ${hw.portBumpDb ? `+${hw.portBumpDb} dB port/tuning lift, ` : ''}${hw.voicing.length} voicing filters. In-room the Room Simulator adds boundary gain, room modes and reverb.`),
        hw.estimated.length && hw.specSource === 'published' ? h('p.dim', { style: { fontSize: '12px' } }, `Estimated fields: ${hw.estimated.join(', ')}.`) : null,
      ),
    ),
    similar.length ? h('section.shelf', h('div.shelf-head', h('h2', 'Similar price')), h('div.hw-grid', similar.map((x) => card(app, x, () => {})))) : null,
  );
  return { el, title: hw.name };
}

export function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}
