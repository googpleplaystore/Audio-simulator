// Human-readable formatting helpers.

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const rs = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rs}` : `${m}:${rs}`;
}

export function formatLongDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0 min';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  if (m > 0) return `${m} min`;
  return `${Math.round(sec)} sec`;
}

export function formatHz(f, digits = 1) {
  if (!Number.isFinite(f)) return '—';
  if (f >= 1000) {
    const k = f / 1000;
    return `${k >= 10 ? k.toFixed(k % 1 === 0 ? 0 : 1) : k.toFixed(digits).replace(/\.0$/, '')} kHz`;
  }
  return `${f >= 100 ? Math.round(f) : f.toFixed(f % 1 === 0 ? 0 : 1)} Hz`;
}

export function formatHzShort(f) {
  if (f >= 1000) {
    const k = f / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${Math.round(f)}`;
}

export function formatDb(db, digits = 1, withSign = true) {
  if (!Number.isFinite(db)) return '-∞ dB';
  const v = db.toFixed(digits);
  const sign = withSign && db > 0 ? '+' : '';
  return `${sign}${v === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : v} dB`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatPrice(usd) {
  if (!Number.isFinite(usd)) return '—';
  return `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function plural(n, word, pluralWord = `${word}s`) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`;
}

export function formatMeters(m) {
  return `${m.toFixed(2)} m`;
}

export function formatRelativeDate(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const day = 86400000;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < day) return `${Math.floor(diff / 3600000)} hr ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** "01 - Artist - Title.mp3" -> { track, artist, title } best-effort filename parsing. */
export function parseFilename(name) {
  let base = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ').trim();
  let track = null;
  const tm = base.match(/^(\d{1,3})(?:[\s.\-)]+)(.*)$/);
  if (tm && tm[2]) {
    track = Number(tm[1]);
    base = tm[2].trim();
  }
  let artist = null;
  let title = base;
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }
  return { track, artist, title: title || name };
}
