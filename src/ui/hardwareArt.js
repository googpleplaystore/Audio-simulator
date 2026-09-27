// Procedural front-view SVG illustrations of speakers and subwoofers derived
// from their physical specs (driver sizes, tweeter type, port, finish).

function driver(cx, cy, r, color, ring = '#0b0b0e', dust = null) {
  const id = `g${Math.round(cx * 7 + cy * 13 + r * 17)}`;
  return `
  <defs><radialGradient id="${id}" cx="0.42" cy="0.38" r="0.75"><stop offset="0" stop-color="${lighten(color, 0.35)}"/><stop offset="0.65" stop-color="${color}"/><stop offset="1" stop-color="${darken(color, 0.45)}"/></radialGradient></defs>
  <circle cx="${cx}" cy="${cy}" r="${r + 3}" fill="${ring}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="#101014"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.9}" fill="url(#${id})"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.9}" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="${Math.max(1, r * 0.06)}"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.32}" fill="${dust || darken(color, 0.25)}" stroke="rgba(255,255,255,0.12)"/>`;
}

function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) return [40, 40, 44];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgb([r, g, b]) {
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function lighten(c, t) {
  const v = hex(c);
  return rgb(v.map((x) => x + (255 - x) * t));
}

function darken(c, t) {
  const v = hex(c);
  return rgb(v.map((x) => x * (1 - t)));
}

export function speakerSvg(hw, { width = 160 } = {}) {
  const st = hw.style;
  const W = 100;
  const H = 158 + (hw.ways === 3 ? 10 : 0);
  const wr = Math.min(40, 18 + hw.woofer.size * 3.2);
  const cabinetGrad = `<defs><linearGradient id="cab-${hw.id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${lighten(st.cabinet, 0.12)}"/><stop offset="1" stop-color="${darken(st.cabinet, 0.25)}"/></linearGradient></defs>`;
  let parts = `${cabinetGrad}<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="7" fill="url(#cab-${hw.id})"/>`;
  parts += `<rect x="7" y="7" width="${W - 14}" height="${H - 14}" rx="5" fill="${st.baffle}"/>`;
  const wy = H - 18 - wr - (hw.port === 'front' ? 18 : 0);
  if (hw.tweeter.type === 'coax') {
    parts += driver(W / 2, wy - 10, wr + 6, st.woofer);
    parts += `<circle cx="${W / 2}" cy="${wy - 10}" r="${wr * 0.45}" fill="${darken(st.woofer, 0.3)}"/>`;
    parts += driver(W / 2, wy - 10, wr * 0.28, st.tweeter, '#222', lighten(st.tweeter, 0.2));
  } else {
    parts += driver(W / 2, wy, wr, st.woofer);
    const ty = 24 + (hw.ways === 3 ? 6 : 0);
    if (hw.tweeter.type === 'horn') {
      parts += `<path d="M ${W / 2 - 24} ${ty - 16} Q ${W / 2} ${ty - 6} ${W / 2 + 24} ${ty - 16} L ${W / 2 + 18} ${ty + 16} Q ${W / 2} ${ty + 8} ${W / 2 - 18} ${ty + 16} Z" fill="${darken(st.baffle, 0.4)}" stroke="rgba(255,255,255,0.1)"/>`;
      parts += driver(W / 2, ty, 6, st.tweeter, '#111');
    } else if (hw.tweeter.type === 'amt' || hw.tweeter.type === 'ribbon') {
      parts += `<rect x="${W / 2 - 13}" y="${ty - 14}" width="26" height="28" rx="3" fill="#0e0e12" stroke="rgba(255,255,255,0.14)"/>`;
      for (let i = 0; i < 6; i++) parts += `<line x1="${W / 2 - 9 + i * 3.6}" y1="${ty - 10}" x2="${W / 2 - 9 + i * 3.6}" y2="${ty + 10}" stroke="${lighten(st.tweeter, 0.3)}" stroke-width="1.4"/>`;
    } else if (hw.tweeter.type !== 'none') {
      parts += driver(W / 2, ty, 9, st.tweeter, '#111', lighten(st.tweeter, 0.25));
    } else {
      parts += driver(W / 2, 30, wr * 0.8, st.woofer);
    }
    if (hw.ways === 3 && hw.tweeter.type !== 'none') parts += driver(W / 2 + 28, 20, 4, '#bbb', '#111');
  }
  if (hw.port === 'front') parts += `<ellipse cx="${W / 2}" cy="${H - 22}" rx="${hw.woofer.size > 5 ? 22 : 16}" ry="5" fill="#050507" stroke="rgba(255,255,255,0.12)"/>`;
  if (hw.enclosure === 'pr' && hw.port === 'front') parts += driver(W / 2, H - 26, 10, '#444');
  parts += `<text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-size="6.5" font-family="Inter, sans-serif" font-weight="700" fill="${st.accent}" letter-spacing="1.5">${escapeXml(hw.brand.toUpperCase())}</text>`;
  if (hw.active) parts += `<circle cx="${W - 14}" cy="${H - 12}" r="2" fill="#3ee69b"/>`;
  return `<svg class="hw-svg" viewBox="0 0 ${W} ${H}" width="${width}" height="${(width * H) / W}" role="img" aria-label="${escapeXml(hw.name)}">${parts}</svg>`;
}

export function subSvg(hw, { width = 160 } = {}) {
  const st = hw.style;
  const W = 120;
  const H = 124;
  const n = hw.driver.count;
  let parts = `<defs><linearGradient id="cab-${hw.id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${lighten(st.cabinet, 0.1)}"/><stop offset="1" stop-color="${darken(st.cabinet, 0.3)}"/></linearGradient></defs>`;
  parts += `<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="8" fill="url(#cab-${hw.id})"/>`;
  parts += `<rect x="7" y="7" width="${W - 14}" height="${H - 14}" rx="6" fill="${st.baffle}"/>`;
  const r = Math.min(46, 16 + hw.driver.size * 2.6) / (n > 1 ? 1.45 : 1);
  if (n > 1) {
    parts += driver(W / 2 - r - 2, H / 2 - 4, r, st.woofer);
    parts += driver(W / 2 + r + 2, H / 2 - 4, r, st.woofer);
  } else parts += driver(W / 2, H / 2 - (hw.port ? 8 : 0), r, st.woofer);
  if (hw.enclosure === 'ported') {
    parts += `<rect x="${W / 2 - 34}" y="${H - 24}" width="68" height="7" rx="3.5" fill="#050507" stroke="rgba(255,255,255,0.1)"/>`;
  }
  parts += `<text x="${W - 12}" y="${H - 12}" text-anchor="end" font-size="6.5" font-family="Inter, sans-serif" font-weight="700" fill="${st.accent}" letter-spacing="1.5">${escapeXml(hw.brand.toUpperCase())}</text>`;
  return `<svg class="hw-svg" viewBox="0 0 ${W} ${H}" width="${width}" height="${(width * H) / W}" role="img" aria-label="${escapeXml(hw.name)}">${parts}</svg>`;
}

export function hardwareSvg(hw, opts) {
  return hw.category === 'subwoofer' ? subSvg(hw, opts) : speakerSvg(hw, opts);
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}
