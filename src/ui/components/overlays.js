// Toasts, modals (alert/confirm/prompt/custom), context menus and tooltips.

import { h, icon, clear } from '../dom.js';

// ------------------------------------------------------------------ toasts
let toastRoot = null;

export function toast(message, { type = 'info', action = null, timeout = 3600 } = {}) {
  if (!toastRoot) {
    toastRoot = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastRoot);
  }
  const el = h(
    'div.toast',
    { class: type === 'error' ? 'error' : '' },
    icon(type === 'error' ? 'warning' : type === 'success' ? 'check' : 'info', 16),
    h('span', message),
    action ? h('button', { onClick: () => { action.fn(); dismiss(); } }, action.label) : null,
  );
  toastRoot.appendChild(el);
  while (toastRoot.children.length > 4) toastRoot.firstChild.remove();
  let gone = false;
  function dismiss() {
    if (gone) return;
    gone = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }
  setTimeout(dismiss, timeout);
  return dismiss;
}

// ------------------------------------------------------------------ modals
let openModals = 0;

/**
 * Show a modal. `render(close)` returns the modal content. Resolves with the
 * value passed to close().
 */
export function modal(render, { wide = false, dismissable = true, label = 'Dialog' } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const backdrop = h('div.modal-backdrop');
    const box = h('div.modal', { class: wide ? 'wide' : '', role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      openModals--;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        close(null);
      }
      if (e.key === 'Tab') {
        const f = [...box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop && dismissable) close(null);
    });
    box.appendChild(render(close));
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    openModals++;
    document.addEventListener('keydown', onKey, true);
    const auto = box.querySelector('[autofocus], input, .btn.primary, button');
    if (auto) setTimeout(() => auto.focus(), 20);
  });
}

export function isModalOpen() {
  return openModals > 0;
}

export function confirmDialog(title, message, { ok = 'OK', danger = false } = {}) {
  return modal((close) =>
    h(
      'div',
      h('h2', title),
      h('p.muted', message),
      h('div.modal-actions', h('button.btn.ghost', { onClick: () => close(false) }, 'Cancel'), h('button.btn', { class: danger ? 'danger' : 'primary', onClick: () => close(true) }, ok)),
    ),
  ).then((v) => !!v);
}

export function promptDialog(title, { value = '', placeholder = '', ok = 'Save', label = '' } = {}) {
  return modal((close) => {
    const input = h('input.input', { value, placeholder, style: { width: '100%' }, autofocus: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim());
    });
    return h(
      'div',
      h('h2', title),
      label ? h('div.field', h('label', label), input) : input,
      h('div.modal-actions', h('button.btn.ghost', { onClick: () => close(null) }, 'Cancel'), h('button.btn.primary', { onClick: () => close(input.value.trim()) }, ok)),
    );
  });
}

// ------------------------------------------------------------------ context menu
let activeMenu = null;

export function closeMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

/**
 * items: [{label, icon, onClick, danger, hint, disabled, submenu:[...]}, '-', {heading}]
 */
export function openMenu(x, y, items) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu' });
  const build = (list, container) => {
    for (const it of list) {
      if (!it) continue;
      if (it === '-') {
        container.appendChild(h('div.menu-sep'));
        continue;
      }
      if (it.heading) {
        container.appendChild(h('div.menu-heading', it.heading));
        continue;
      }
      const btn = h(
        'button.menu-item',
        { role: 'menuitem', class: it.danger ? 'danger' : '', disabled: it.disabled },
        it.icon ? icon(it.icon, 16) : h('span', { style: { width: '16px' } }),
        h('span.ellipsis', it.label),
        it.hint ? h('span.dim', it.hint) : null,
        it.submenu ? icon('chevron', 14, 'dim') : null,
      );
      if (it.submenu) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = btn.getBoundingClientRect();
          openSubmenu(r.right - 4, r.top - 5, it.submenu, menu);
        });
      } else {
        btn.addEventListener('click', () => {
          closeMenu();
          it.onClick?.();
        });
      }
      container.appendChild(btn);
    }
  };
  build(items, menu);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`;
  activeMenu = menu;
  const first = menu.querySelector('.menu-item');
  if (first) first.focus();
  menu.addEventListener('keydown', (e) => {
    const all = [...menu.querySelectorAll('.menu-item:not([disabled])')];
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      all[(i + 1) % all.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      all[(i - 1 + all.length) % all.length]?.focus();
    } else if (e.key === 'Escape') closeMenu();
  });
  return menu;
}

function openSubmenu(x, y, items, parent) {
  parent.querySelectorAll('.menu.sub').forEach((m) => m.remove());
  const sub = h('div.menu.sub');
  for (const it of items) {
    if (it === '-') {
      sub.appendChild(h('div.menu-sep'));
      continue;
    }
    const btn = h('button.menu-item', it.icon ? icon(it.icon, 16) : null, h('span.ellipsis', it.label));
    btn.addEventListener('click', () => {
      closeMenu();
      it.onClick?.();
    });
    sub.appendChild(btn);
  }
  parent.appendChild(sub);
  const r = sub.getBoundingClientRect();
  const left = x + r.width > window.innerWidth ? x - r.width - parent.getBoundingClientRect().width + 8 : x;
  sub.style.position = 'fixed';
  sub.style.left = `${Math.max(6, left)}px`;
  sub.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`;
  sub.style.maxHeight = '60vh';
  sub.style.overflowY = 'auto';
}

document.addEventListener('pointerdown', (e) => {
  if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ------------------------------------------------------------------ tooltips
let tipEl = null;
let tipTimer = null;

function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  if (!tipEl) {
    tipEl = h('div.tooltip', { role: 'tooltip' });
  }
  tipEl.textContent = text;
  document.body.appendChild(tipEl);
  const r = target.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  let top = r.top - tr.height - 8;
  if (top < 6) top = r.bottom + 8;
  tipEl.style.left = `${Math.max(6, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 6))}px`;
  tipEl.style.top = `${top}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) tipEl.remove();
}

document.addEventListener('pointerover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t || e.pointerType === 'touch') return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTip(t), 450);
});
document.addEventListener('pointerout', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (t) hideTip();
});
document.addEventListener('pointerdown', hideTip, true);

export { clear };
