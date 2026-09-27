// Hash router: "#/album/<key>" → { name: 'album', params: { key } }.

import { Emitter } from '../util/emitter.js';

export class Router extends Emitter {
  constructor(routes) {
    super();
    this.routes = routes; // [{pattern: 'album/:key', name}]
    this.current = null;
    window.addEventListener('hashchange', () => this._resolve());
  }

  parse(hash) {
    const raw = (hash || '').replace(/^#\/?/, '');
    const [pathPart, queryPart = ''] = raw.split('?');
    const segs = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    const query = Object.fromEntries(new URLSearchParams(queryPart));
    for (const r of this.routes) {
      const ps = r.pattern.split('/').filter(Boolean);
      if (ps.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].startsWith(':')) params[ps[i].slice(1)] = segs[i];
        else if (ps[i] !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { name: r.name, params, query, path: pathPart };
    }
    return { name: 'home', params: {}, query, path: '' };
  }

  _resolve() {
    const route = this.parse(location.hash);
    const prev = this.current;
    this.current = route;
    this.emit('change', route, prev);
  }

  start() {
    this._resolve();
  }

  go(path, { replace = false } = {}) {
    const hash = `#/${path}`;
    if (location.hash === hash) {
      this._resolve();
      return;
    }
    if (replace) {
      history.replaceState(null, '', hash);
      this._resolve();
    } else location.hash = hash;
  }
}

export const enc = encodeURIComponent;
