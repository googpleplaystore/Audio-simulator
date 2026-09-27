// Play queue with Spotify-like semantics: a play *context* (album, playlist…)
// in linear or shuffled order, plus a user "Next in queue" list that takes
// priority. Supports repeat off/all/one, history for "previous", reordering
// and serialisation for session restore.

import { Emitter } from '../util/emitter.js';
import { mulberry32 } from '../util/math.js';

let uidCounter = 0;
const nextUid = () => `q${++uidCounter}`;

export function shuffleArray(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Queue extends Emitter {
  constructor() {
    super();
    this.context = null; // {type, id, name}
    this.source = []; // original context order (track ids)
    this.order = []; // play order
    this.index = -1; // position in order of the context track currently (or last) playing
    this.manual = []; // [{uid, id}]
    this.current = null; // {id, manual:boolean}
    this.history = []; // previously played ids (for prev when coming from manual)
    this.shuffle = false;
    this.repeat = 'off'; // 'off' | 'all' | 'one'
    this.rand = Math.random;
  }

  seed(n) {
    this.rand = mulberry32(n);
  }

  _changed() {
    this.emit('change');
  }

  get currentId() {
    return this.current ? this.current.id : null;
  }

  /** Replace the context and start at `startIndex` (index into trackIds). */
  setContext(trackIds, startIndex = 0, context = null) {
    this.context = context;
    this.source = trackIds.slice();
    const start = Math.max(0, Math.min(startIndex, trackIds.length - 1));
    const first = trackIds[start];
    if (this.shuffle) {
      const rest = trackIds.filter((_, i) => i !== start);
      this.order = [first, ...shuffleArray(rest, this.rand)];
      this.index = 0;
    } else {
      this.order = trackIds.slice();
      this.index = start;
    }
    this.current = first != null ? { id: first, manual: false } : null;
    this.history = [];
    this._changed();
    return this.currentId;
  }

  /** Advance. `auto` = true when triggered by the end of a track. */
  next(auto = false) {
    if (auto && this.repeat === 'one' && this.current) return this.currentId;
    if (this.current) this.history.push(this.current.id);
    if (this.history.length > 200) this.history.shift();
    if (this.manual.length) {
      const item = this.manual.shift();
      this.current = { id: item.id, manual: true };
      this._changed();
      return item.id;
    }
    if (this.index + 1 < this.order.length) {
      this.index++;
    } else if (this.repeat !== 'off' && this.order.length) {
      if (this.shuffle) this.order = shuffleArray(this.order, this.rand);
      this.index = 0;
    } else {
      this._changed();
      return null;
    }
    this.current = { id: this.order[this.index], manual: false };
    this._changed();
    return this.currentId;
  }

  /** Peek at what next() would return without mutating. */
  peekNext() {
    if (this.repeat === 'one' && this.current) return this.currentId;
    if (this.manual.length) return this.manual[0].id;
    if (this.index + 1 < this.order.length) return this.order[this.index + 1];
    if (this.repeat === 'all' && this.order.length && !this.shuffle) return this.order[0];
    return null;
  }

  prev() {
    if (this.current && this.current.manual && this.history.length) {
      const id = this.history.pop();
      this.current = { id, manual: false };
      const idx = this.order.indexOf(id);
      if (idx >= 0) this.index = idx;
      this._changed();
      return id;
    }
    if (this.index > 0) this.index--;
    else if (this.repeat === 'all' && this.order.length) this.index = this.order.length - 1;
    else if (this.index < 0) return null;
    this.current = { id: this.order[this.index], manual: false };
    this._changed();
    return this.currentId;
  }

  /** Jump to an upcoming item as displayed by upNext(). */
  jumpTo(section, i) {
    if (this.current) this.history.push(this.current.id);
    if (section === 'manual') {
      const [item] = this.manual.splice(i, 1);
      if (!item) return null;
      this.current = { id: item.id, manual: true };
    } else {
      // Items before the target in the manual queue are kept.
      this.index = this.index + 1 + i;
      this.current = { id: this.order[this.index], manual: false };
    }
    this._changed();
    return this.currentId;
  }

  upcoming() {
    return this.order.slice(this.index + 1);
  }

  addNext(ids) {
    this.manual.unshift(...ids.map((id) => ({ uid: nextUid(), id })));
    this._changed();
  }

  addToQueue(ids) {
    this.manual.push(...ids.map((id) => ({ uid: nextUid(), id })));
    this._changed();
  }

  move(section, from, to) {
    if (from === to) return;
    if (section === 'manual') {
      const [it] = this.manual.splice(from, 1);
      if (!it) return;
      this.manual.splice(Math.max(0, Math.min(to, this.manual.length)), 0, it);
    } else {
      const base = this.index + 1;
      const [it] = this.order.splice(base + from, 1);
      if (it == null) return;
      this.order.splice(base + Math.max(0, Math.min(to, this.order.length - base)), 0, it);
    }
    this._changed();
  }

  /** Move an item between sections (drag from context into manual or vice versa). */
  transfer(fromSection, fromIndex, toSection, toIndex) {
    if (fromSection === toSection) return this.move(fromSection, fromIndex, toIndex);
    let id;
    if (fromSection === 'manual') {
      const [it] = this.manual.splice(fromIndex, 1);
      if (!it) return;
      id = it.id;
      this.order.splice(this.index + 1 + Math.max(0, toIndex), 0, id);
    } else {
      const [it] = this.order.splice(this.index + 1 + fromIndex, 1);
      if (it == null) return;
      id = it;
      this.manual.splice(Math.max(0, Math.min(toIndex, this.manual.length)), 0, { uid: nextUid(), id });
    }
    this._changed();
  }

  remove(section, i) {
    if (section === 'manual') this.manual.splice(i, 1);
    else this.order.splice(this.index + 1 + i, 1);
    this._changed();
  }

  clearUpcoming() {
    this.manual = [];
    this.order = this.order.slice(0, this.index + 1);
    this._changed();
  }

  setShuffle(on) {
    this.shuffle = !!on;
    const cur = this.order[this.index];
    if (this.shuffle) {
      const played = this.order.slice(0, this.index + 1);
      this.order = [...played, ...shuffleArray(this.order.slice(this.index + 1), this.rand)];
    } else if (this.source.length) {
      this.order = this.source.slice();
      const idx = cur != null ? this.order.indexOf(cur) : -1;
      this.index = idx >= 0 ? idx : Math.min(this.index, this.order.length - 1);
    }
    this._changed();
  }

  setRepeat(mode) {
    this.repeat = mode;
    this._changed();
  }

  cycleRepeat() {
    this.setRepeat(this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off');
    return this.repeat;
  }

  /** Drop ids that no longer exist in the library. */
  prune(exists) {
    const cur = this.order[this.index];
    this.source = this.source.filter(exists);
    this.order = this.order.filter(exists);
    this.manual = this.manual.filter((m) => exists(m.id));
    this.index = cur != null ? this.order.indexOf(cur) : -1;
    if (this.current && !exists(this.current.id)) this.current = null;
    this._changed();
  }

  serialize() {
    return {
      context: this.context,
      source: this.source,
      order: this.order,
      index: this.index,
      manual: this.manual.map((m) => m.id),
      current: this.current,
      shuffle: this.shuffle,
      repeat: this.repeat,
    };
  }

  restore(s) {
    if (!s) return;
    this.context = s.context || null;
    this.source = s.source || [];
    this.order = s.order || [];
    this.index = Number.isInteger(s.index) ? s.index : -1;
    this.manual = (s.manual || []).map((id) => ({ uid: nextUid(), id }));
    this.current = s.current || null;
    this.shuffle = !!s.shuffle;
    this.repeat = ['off', 'all', 'one'].includes(s.repeat) ? s.repeat : 'off';
    this._changed();
  }
}
