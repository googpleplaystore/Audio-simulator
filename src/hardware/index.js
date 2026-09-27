// Hardware catalogue access: the 100 + 100 built-in models plus any custom
// models installed from hardware add-ons (see addons.js).

import { buildBookshelfCatalog, buildSubCatalog } from './generator.js';

export { speakerResponseSpecs, subResponseSpecs, responseSpecs, responseCurve, soundTags } from './response.js';

let bookshelf = null;
let subs = null;
let byId = null;
let custom = { bookshelf: [], subwoofer: [], byId: new Map() };

function ensure() {
  if (!bookshelf) {
    bookshelf = buildBookshelfCatalog();
    subs = buildSubCatalog();
    byId = new Map();
    for (const e of bookshelf) byId.set(e.id, e);
    for (const e of subs) byId.set(e.id, e);
  }
}

/** Built-in and custom bookshelf speakers (custom ones last). */
export function getBookshelfSpeakers() {
  ensure();
  return custom.bookshelf.length ? [...bookshelf, ...custom.bookshelf] : bookshelf;
}

/** Built-in and custom subwoofers (custom ones last). */
export function getSubwoofers() {
  ensure();
  return custom.subwoofer.length ? [...subs, ...custom.subwoofer] : subs;
}

export function getHardware(id) {
  ensure();
  return byId.get(id) || custom.byId.get(id) || null;
}

export const DEFAULT_SPEAKER_ID = 'kef-ls50-meta';
export const DEFAULT_SUB_ID = 'svs-sb-1000-pro';

/** Like getHardware, but falls back to the default model of the category. */
export function resolveHardware(id, category = 'bookshelf') {
  return getHardware(id) || getHardware(category === 'subwoofer' ? DEFAULT_SUB_ID : DEFAULT_SPEAKER_ID);
}

export function isBuiltinHardware(id) {
  ensure();
  return byId.has(id);
}

/**
 * Replace the set of custom (add-on) models. Built-in ids always win; a
 * custom model can never shadow one.
 */
export function setCustomHardware(models) {
  ensure();
  const next = { bookshelf: [], subwoofer: [], byId: new Map() };
  for (const m of models) {
    if (byId.has(m.id)) continue;
    next.byId.set(m.id, m);
  }
  for (const m of next.byId.values()) (m.category === 'subwoofer' ? next.subwoofer : next.bookshelf).push(m);
  custom = next;
}

export function getCustomHardware() {
  return [...custom.byId.values()];
}

/** The built-in database as a plain JSON-serialisable object. */
export function exportDatabase() {
  ensure();
  return {
    generated: new Date().toISOString(),
    note: 'Seed entries follow manufacturer-published specifications; roster entries are physics-based extrapolations (specSource: "extrapolated"). Rankings are illustrative.',
    bookshelf,
    subwoofers: subs,
  };
}
