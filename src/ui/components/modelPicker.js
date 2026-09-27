// Searchable hardware picker modal (bookshelf speakers or subwoofers).

import { h, icon, clear } from '../dom.js';
import { modal } from './overlays.js';
import { getBookshelfSpeakers, getSubwoofers, soundTags } from '../../hardware/index.js';
import { hardwareSvg } from '../hardwareArt.js';
import { formatPrice } from '../../util/format.js';

export function specLine(hw) {
  if (hw.category === 'subwoofer') {
    return `${hw.driver.count > 1 ? `${hw.driver.count}× ` : ''}${hw.driver.size}″ ${hw.enclosure} · ${hw.freqLow}–${hw.freqHigh} Hz · ${hw.rmsWatts} W RMS`;
  }
  return `${hw.woofer.size}″ ${hw.ways}-way ${hw.enclosure === 'pr' ? 'passive-radiator' : hw.enclosure} · ${hw.freqLow} Hz–${hw.freqHigh / 1000} kHz · ${hw.active ? `${hw.ampWatts} W/ch powered` : `${hw.sensitivity} dB`}`;
}

/** @returns {Promise<string|null>} selected hardware id */
export function pickModel(category, currentId = null) {
  const all = category === 'subwoofer' ? getSubwoofers() : getBookshelfSpeakers();
  return modal(
    (close) => {
      const input = h('input.input', { placeholder: `Search ${all.length} ${category === 'subwoofer' ? 'subwoofers' : 'bookshelf speakers'}…`, style: { flex: 1 } });
      const list = h('div.picker-list');
      const render = () => {
        clear(list);
        const q = input.value.trim().toLowerCase();
        const items = all.filter((hw) => !q || `${hw.name} ${hw.signature} ${hw.enclosure}`.toLowerCase().includes(q));
        for (const hw of items) {
          const row = h(
            'button.picker-item',
            { class: hw.id === currentId ? 'current' : '', onClick: () => close(hw.id) },
            h('div.picker-art', { html: hardwareSvg(hw, { width: 44 }) }),
            h('div.grow.ellipsis',
              h('div.split', h('span.badge', hw.rank == null ? 'Custom' : `#${hw.rank}`), h('strong.ellipsis', hw.name), hw.id === currentId ? h('span.badge.teal', 'current') : null),
              h('div.dim.ellipsis', { style: { fontSize: '12px', marginTop: '3px' } }, specLine(hw)),
              h('div.split', { style: { marginTop: '4px', gap: '4px' } }, soundTags(hw).slice(0, 4).map((t) => h('span.badge', t))),
            ),
            h('div.picker-price', h('div', formatPrice(hw.price)), h('div.dim', hw.priceBracket)),
          );
          list.appendChild(row);
        }
        if (!items.length) list.appendChild(h('div.empty', 'No matches'));
      };
      input.addEventListener('input', render);
      input.addEventListener('keydown', (e) => e.stopPropagation());
      render();
      return h('div', h('div.split', { style: { marginBottom: '12px' } }, h('h2', { style: { margin: 0 } }, category === 'subwoofer' ? 'Choose a subwoofer' : 'Choose a speaker'), h('div.grow'), h('button.icon-btn', { 'aria-label': 'Close', onClick: () => close(null) }, icon('close', 18))), h('div.split', icon('search', 18), input), list);
    },
    { wide: true, label: 'Choose hardware' },
  );
}
