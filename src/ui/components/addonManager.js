// Hardware add-on manager: import custom speakers/subwoofers from JSON
// (file picker, paste, drag & drop), list and remove installed add-ons, and
// a field reference generated from the validator's own tables.

import { h, icon, clear } from '../dom.js';
import { toast, modal, confirmDialog } from './overlays.js';
import { installAddon, installedAddons, removeAddon, addonEvents } from '../../hardware/addonStore.js';
import { addonTemplate, SPEAKER_FIELDS, SUB_FIELDS, ADDON_FIELDS } from '../../hardware/addons.js';
import { fixModelIds } from '../../core/settings.js';
import { plural } from '../../util/format.js';

const CLAUDE_PROMPT = 'Create an AudioSpace hardware add-on for the <brand model> speakers (and <sub>), validate it and save it as addons/<name>.audiospace.json';

function download(obj, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

function copy(text) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', { type: 'error' }));
}

function reportText(label, res) {
  const lines = [`AudioSpace add-on check for ${label}:`];
  for (const e of res.errors) lines.push(`ERROR   ${e.path} ${e.message}`);
  for (const w of res.warnings) lines.push(`warning ${w.path} ${w.message}`);
  return lines.join('\n');
}

function problemList(items, cls) {
  return h('ul.addon-problems', items.slice(0, 60).map((p) => h('li', { class: cls }, h('code', p.path), ' ', p.message)), items.length > 60 ? h('li.dim', `… and ${items.length - 60} more`) : null);
}

/** Validate + install one add-on; shows the outcome. Returns the result. */
export async function importAddonText(app, text, label = 'add-on') {
  const res = installAddon(text);
  if (!res.ok) {
    await modal((close) => h('div',
      h('h2', 'This add-on can’t be imported'),
      h('p.muted', `${label}: ${plural(res.errors.length, 'problem')} to fix. If Claude Code made the file, paste this report back to it.`),
      problemList(res.errors, 'error'),
      res.warnings.length ? h('details', h('summary', plural(res.warnings.length, 'warning')), problemList(res.warnings, 'warn')) : null,
      h('div.modal-actions', h('button.btn.ghost', { onClick: () => copy(reportText(label, res)) }, icon('file', 14), 'Copy report'), h('button.btn.primary', { onClick: () => close() }, 'OK')),
    ), { wide: true, label: 'Add-on problems' });
    return res;
  }
  const speakers = res.models.filter((m) => m.category === 'bookshelf').length;
  const subs = res.models.length - speakers;
  const what = [speakers ? plural(speakers, 'speaker') : null, subs ? plural(subs, 'subwoofer') : null].filter(Boolean).join(' and ');
  if (!res.warnings.length) {
    toast(`${res.replaced ? 'Updated' : 'Installed'} “${res.addon.name}”: ${what}`, { type: 'success', action: { label: 'View', fn: () => app.go(`studio/hardware/${res.models[0].id}`) } });
    return res;
  }
  await modal((close) => h('div',
    h('h2', `${res.replaced ? 'Updated' : 'Installed'} “${res.addon.name}”`),
    h('p.muted', `${what} added to the Hardware Catalog, with ${plural(res.warnings.length, 'note')}:`),
    problemList(res.warnings, 'warn'),
    h('div.modal-actions', h('button.btn.ghost', { onClick: () => copy(reportText(label, res)) }, 'Copy notes'), h('button.btn.primary', { onClick: () => { close(); app.go(`studio/hardware/${res.models[0].id}`); } }, 'View models')),
  ), { wide: true, label: 'Add-on installed' });
  return res;
}

export async function importAddonFiles(app, files) {
  for (const f of files) {
    if (f.size > 8_000_000) {
      toast(`${f.name} is too large for an add-on`, { type: 'error' });
      continue;
    }
    try {
      await importAddonText(app, await f.text(), f.name);
    } catch (err) {
      toast(`Could not read ${f.name}: ${err.message || err}`, { type: 'error' });
    }
  }
}

function pickFiles(app) {
  const input = h('input', { type: 'file', accept: '.json,application/json', multiple: true, style: { display: 'none' } });
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.remove();
    importAddonFiles(app, files);
  });
  document.body.appendChild(input);
  input.click();
}

function pasteDialog(app) {
  return modal((close) => {
    const ta = h('textarea.input.addon-paste', { placeholder: '{ "format": "audiospace-hardware", "version": 1, "name": "…", "speakers": [ … ] }', spellcheck: 'false', 'aria-label': 'Add-on JSON' });
    const go = async () => {
      const text = ta.value.trim();
      if (!text) return;
      close();
      await importAddonText(app, text, 'pasted add-on');
    };
    return h('div',
      h('h2', 'Paste an add-on'),
      h('p.muted', 'Paste the JSON of an AudioSpace hardware add-on — for example what Claude Code generated.'),
      ta,
      h('div.modal-actions', h('button.btn.ghost', { onClick: () => close() }, 'Cancel'), h('button.btn.primary', { onClick: go }, 'Import')),
    );
  }, { wide: true, label: 'Paste add-on' });
}

function fieldTable(title, fields) {
  return h('div',
    h('h3', { style: { margin: '14px 0 6px' } }, title),
    h('table.spec-table.addon-fields',
      h('tbody', Object.entries(fields).map(([k, d]) => h('tr',
        h('td', h('code', k), d.required ? h('span.badge.accent', { style: { marginLeft: '6px' } }, 'required') : null),
        h('td.dim', [d.doc, d.unit ? `Unit: ${d.unit}.` : null, d.min != null && d.max != null && d.type !== 'range' ? `${d.min}–${d.max}.` : null, d.values ? `One of: ${d.values.join(', ')}.` : null].filter(Boolean).join(' ')),
      ))),
    ),
  );
}

async function removeWithCheck(app, entry) {
  const ids = new Set(entry.models.map((m) => m.id));
  const s = app.store.state;
  const inUse = [...s.speakers, ...s.subs].filter((x) => ids.has(x.modelId)).length;
  const ok = await confirmDialog(`Remove “${entry.name}”?`, `${plural(entry.models.length, 'model')} will disappear from the catalog.${inUse ? ` ${plural(inUse, 'speaker')} in your room use them and will switch to the default models.` : ''}`, { ok: 'Remove', danger: true });
  if (!ok) return;
  removeAddon(entry.id);
  if (inUse) {
    const speakers = JSON.parse(JSON.stringify(s.speakers));
    const subs = JSON.parse(JSON.stringify(s.subs));
    fixModelIds({ speakers, subs });
    app.store.set('speakers', speakers);
    app.store.set('subs', subs);
  }
  toast(`Removed “${entry.name}”`);
}

export function openAddonManager(app) {
  return modal((close) => {
    const list = h('div.stack.tight');
    const render = () => {
      clear(list);
      const items = installedAddons();
      if (!items.length) {
        list.appendChild(h('p.dim', 'No add-ons installed yet.'));
        return;
      }
      for (const a of items) {
        list.appendChild(h('div.addon-item',
          h('div.grow',
            h('div', h('strong', a.name), a.author ? h('span.dim', ` · by ${a.author}`) : null),
            a.description ? h('div.dim', { style: { fontSize: '12px' } }, a.description) : null,
            h('div.split.wrap', { style: { gap: '4px', marginTop: '6px' } }, a.models.map((m) => h('a.badge', { href: `#/studio/hardware/${m.id}`, onClick: () => close() }, icon(m.category === 'subwoofer' ? 'sub' : 'speaker', 12), ` ${m.name}`))),
          ),
          h('button.btn.small.ghost', { 'data-tip': 'Download this add-on', 'aria-label': `Download ${a.name}`, onClick: () => download(a.addon, `${a.id}.audiospace.json`) }, icon('download', 14)),
          h('button.btn.small.danger', { onClick: () => removeWithCheck(app, a) }, icon('trash', 14), 'Remove'),
        ));
      }
    };
    const off = addonEvents.on('change', render);
    const obs = new MutationObserver(() => {
      if (!list.isConnected) {
        off();
        obs.disconnect();
      }
    });
    requestAnimationFrame(() => obs.observe(document.body, { childList: true }));
    render();
    return h('div.addon-manager',
      h('div.split', h('h2', 'Hardware add-ons'), h('div.grow'), h('button.icon-btn', { 'aria-label': 'Close', onClick: () => close() }, icon('close', 18))),
      h('p.muted', 'Add your own bookshelf speakers and subwoofers from a small JSON file — they behave exactly like the built-in models everywhere in AudioSpace. You can also drop add-on files anywhere on the app.'),
      h('div.split.wrap', { style: { gap: '8px', margin: '12px 0' } },
        h('button.btn.primary', { onClick: () => pickFiles(app) }, icon('upload', 16), 'Import file…'),
        h('button.btn', { onClick: () => pasteDialog(app) }, icon('file', 16), 'Paste JSON…'),
        h('button.btn.ghost', { onClick: () => download(addonTemplate(), 'my-speakers.audiospace.json') }, icon('download', 16), 'Download template'),
      ),
      h('div.addon-tip',
        icon('sparkle', 16),
        h('div',
          h('strong', 'Make one with Claude Code. '),
          'Open this project in Claude Code and ask, for example: ',
          h('code', CLAUDE_PROMPT),
          '. It looks up the specs, writes the file and checks it with ',
          h('code', 'node scripts/validate-addon.mjs'),
          '. Then import the file here.',
        ),
      ),
      h('h3', { style: { margin: '16px 0 8px' } }, 'Installed'),
      list,
      h('details', { style: { marginTop: '16px' } },
        h('summary', 'Field reference'),
        h('p.dim', { style: { fontSize: '12px' } }, 'Numbers must be JSON numbers. Unknown fields are ignored with a warning. A measured on-axis response ("response": [[Hz, dB], …]) makes the simulated speaker match the measurement.'),
        fieldTable('Add-on', ADDON_FIELDS),
        fieldTable('speakers[]', SPEAKER_FIELDS),
        fieldTable('subwoofers[]', SUB_FIELDS),
      ),
    );
  }, { wide: true, label: 'Hardware add-ons' });
}
