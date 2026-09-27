// Installed hardware add-ons: persisted in localStorage (synchronously
// available at start-up, before saved settings that may reference custom
// models are restored) and registered with the hardware catalogue.

import { validateAddon, VALIDATOR_REVISION } from './addons.js';
import { setCustomHardware } from './index.js';
import { Emitter } from '../util/emitter.js';

const KEY = 'audiospace:addons';
const MAX_CHARS = 2_000_000; // keep well inside the ~5 MB localStorage quota

export const addonEvents = new Emitter();

/** @type {{addon: object, models: object[], installedAt: number, revision: number}[]} */
let installed = [];

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function register() {
  setCustomHardware(installed.flatMap((e) => e.models));
}

function persist(list) {
  const ls = storage();
  if (!ls) return;
  const json = JSON.stringify(list);
  if (json.length > MAX_CHARS) throw new Error(`add-ons would use ${(json.length / 1e6).toFixed(1)} MB of browser storage (limit ${MAX_CHARS / 1e6} MB) — remove some, or shorten measured responses`);
  ls.setItem(KEY, json);
}

/**
 * Load and register the installed add-ons. Entries produced by an older
 * validator revision are re-validated. Returns problems for broken entries.
 */
export function loadInstalledAddons() {
  const problems = [];
  let raw = null;
  try {
    raw = storage()?.getItem(KEY);
  } catch {
    raw = null;
  }
  let list = [];
  if (raw) {
    try {
      list = JSON.parse(raw);
    } catch {
      problems.push('Stored add-ons were unreadable and have been ignored.');
    }
  }
  let changed = false;
  installed = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || !e.addon) continue;
    if (e.revision === VALIDATOR_REVISION && Array.isArray(e.models)) {
      installed.push(e);
      continue;
    }
    const res = validateAddon(e.addon);
    changed = true;
    if (res.ok) installed.push({ addon: res.addon, models: res.models, installedAt: e.installedAt || Date.now(), revision: VALIDATOR_REVISION });
    else problems.push(`“${e.addon.name || 'Add-on'}” could not be loaded: ${res.errors[0].path} ${res.errors[0].message}`);
  }
  if (changed) {
    try {
      persist(installed);
    } catch {
      /* keep the in-memory list */
    }
  }
  register();
  return { count: installed.length, problems };
}

export function installedAddons() {
  return installed.map((e) => ({
    id: e.addon.id,
    name: e.addon.name,
    author: e.addon.author || null,
    description: e.addon.description || null,
    installedAt: e.installedAt,
    models: e.models.map((m) => ({ id: m.id, name: m.name, category: m.category })),
    addon: e.addon,
  }));
}

/**
 * Validate and install an add-on (JSON string or object). An add-on with
 * the same id replaces the installed one.
 */
export function installAddon(input) {
  const res = validateAddon(input);
  if (!res.ok) return { ...res, replaced: false };
  // Model ids must be unique across add-ons (the same add-on may redefine its own).
  const clash = [];
  for (const e of installed) {
    if (e.addon.id === res.addon.id) continue;
    for (const m of e.models) if (res.models.some((n) => n.id === m.id)) clash.push({ path: '$', message: `model "${m.name}" (${m.id}) is already installed by the add-on “${e.addon.name}”` });
  }
  if (clash.length) return { ...res, ok: false, errors: clash, replaced: false };
  const replaced = installed.some((e) => e.addon.id === res.addon.id);
  const next = [...installed.filter((e) => e.addon.id !== res.addon.id), { addon: res.addon, models: res.models, installedAt: Date.now(), revision: VALIDATOR_REVISION }];
  try {
    persist(next);
  } catch (err) {
    return { ...res, ok: false, errors: [{ path: '(storage)', message: err.message }], replaced: false };
  }
  installed = next;
  register();
  addonEvents.emit('change');
  return { ...res, replaced };
}

export function removeAddon(id) {
  const entry = installed.find((e) => e.addon.id === id);
  if (!entry) return [];
  const next = installed.filter((e) => e.addon.id !== id);
  persist(next);
  installed = next;
  register();
  addonEvents.emit('change');
  return entry.models.map((m) => m.id);
}
