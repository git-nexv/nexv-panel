'use strict';
/* NexV Panel — single-page frontend, no build step. */

/* The panel can live under a secret base path; the server injects it here.
   Every request and redirect is built from it, so nothing depends on how the
   current URL happens to be spelled. */
const BASE = window.__NEXV_BASE__ || './';
const REQUEST_TIMEOUT = 20000;

/* localStorage throws outright when the browser blocks site data - Safari with
   "Block All Cookies", private windows, some in-app browsers. It only ever
   holds the theme preference, so every access degrades to a no-op. */
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* preference is not persisted */ }
  }
};

/* ------------------------------- helpers -------------------------------- */

const api = {
  async request(method, path, body) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT);
    let res;
    try {
      res = await fetch(`${BASE}api${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: abort.signal
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError'
        ? 'The server did not respond in time'
        : 'Could not reach the server');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) { location.href = `${BASE}login`; throw new Error('unauthorized'); }
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        throw new Error(`Unexpected reply from ${path} (HTTP ${res.status})`);
      }
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  get: (p) => api.request('GET', p),
  post: (p, b) => api.request('POST', p, b),
  put: (p, b) => api.request('PUT', p, b),
  del: (p) => api.request('DELETE', p)
};

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

function bytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDate(ts) {
  if (!ts) return 'Never';
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
  } catch (_) { return new Date(ts).toLocaleString(); }
}

function daysLeft(ts) {
  if (!ts) return null;
  return Math.ceil((ts - Date.now()) / 86400000);
}

function toast(message, kind = 'ok') {
  const node = el('div', { class: `toast ${kind}`, text: message });
  document.getElementById('toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 260);
  }, 3600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch (_) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copied to clipboard');
  }
}

/* -------------------------------- icons --------------------------------- */

const ICONS = {
  dashboard: '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
  inbounds: '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  outbounds: '<path d="M13 3v2h4.6l-8.3 8.3 1.4 1.4L19 6.4V11h2V3h-8ZM5 5h6v2H7v10h10v-4h2v6H5V5Z"/>',
  routing: '<path d="M6 3a3 3 0 0 0-1 5.8V11a3 3 0 0 0 3 3h3v2.2a3 3 0 1 0 2 0V14h3a3 3 0 0 0 3-3V8.8A3 3 0 1 0 16 3a3 3 0 0 0-1 5.8V11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8.8A3 3 0 0 0 6 3Z"/>',
  clients: '<path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 1a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm0 2c-2.7 0-6 1.3-6 3.5V20h8v-2.5c0-1 .5-2 1.4-2.8A11 11 0 0 0 8 14Zm8 0c-3 0-8 1.5-8 4.2V20h16v-1.8C24 15.5 19 14 16 14Z"/>',
  settings: '<path d="M12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Zm7.4-2.4.1-1.1-.1-1.1 2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-1.9-1.1L14.8 3H9.2l-.4 2.4a7.6 7.6 0 0 0-1.9 1.1l-2.3-.9-2 3.4 2 1.5-.1 1.1.1 1.1-2 1.5 2 3.4 2.3-.9a7.6 7.6 0 0 0 1.9 1.1l.4 2.4h5.6l.4-2.4a7.6 7.6 0 0 0 1.9-1.1l2.3.9 2-3.4Z"/>',
  logs: '<path d="M4 4h16v2H4V4Zm0 5h16v2H4V9Zm0 5h11v2H4v-2Zm0 5h11v2H4v-2Z"/>',
  account: '<path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Zm0 2c-4 0-9 2-9 5v3h18v-3c0-3-5-5-9-5Z"/>',
  logout: '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3Zm7.3 4.3-1.4 1.4L18.2 11H9v2h9.2l-2.3 2.3 1.4 1.4L22 12l-4.7-4.7Z"/>',
  theme: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z"/>',
  menu: '<path d="M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h18v2H3v-2Z"/>',
  refresh: '<path d="M12 6V3L8 7l4 4V8a4 4 0 1 1-4 4H6a6 6 0 1 0 6-6Z"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/>',
  edit: '<path d="m3 17.2 10.6-10.6 3.8 3.8L6.8 21H3v-3.8ZM20.7 6.3l-1.9 1.9-3.8-3.8 1.9-1.9a1 1 0 0 1 1.4 0l2.4 2.4a1 1 0 0 1 0 1.4Z"/>',
  trash: '<path d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2h4v2H4V5h4l1-2Z"/>',
  qr: '<path d="M3 3h8v8H3V3Zm2 2v4h4V5H5Zm8-2h8v8h-8V3Zm2 2v4h4V5h-4ZM3 13h8v8H3v-8Zm2 2v4h4v-4H5Zm10 0h2v2h-2v-2Zm4-2h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm2 2h2v2h-2v-2Zm2-2h2v4h-2v-4Z"/>',
  copy: '<path d="M8 4h10a2 2 0 0 1 2 2v10h-2V6H8V4ZM5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/>',
  power: '<path d="M11 3h2v10h-2V3Zm5.4 2.6 1.4-1.4A9 9 0 1 1 6.2 4.2l1.4 1.4a7 7 0 1 0 8.8 0Z"/>',
  up: '<path d="m12 7 6 6-1.4 1.4L12 9.8l-4.6 4.6L6 13l6-6Z"/>',
  more: '<path d="M12 8a2 2 0 1 1 2-2 2 2 0 0 1-2 2Zm0 6a2 2 0 1 1 2-2 2 2 0 0 1-2 2Zm0 6a2 2 0 1 1 2-2 2 2 0 0 1-2 2Z"/>',
  download: '<path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4L11 12.2V3ZM5 19h14v2H5v-2Z"/>',
  sparkle: '<path d="M12 2.5 13.6 8 19 9.6 13.6 11.2 12 16.6 10.4 11.2 5 9.6 10.4 8 12 2.5ZM18.5 14l.8 2.7 2.7.8-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7Z"/>',
  upload: '<path d="M11 21h2v-9.2l3.3 3.3 1.4-1.4L12 8l-5.7 5.7 1.4 1.4L11 11.8V21ZM5 3h14v2H5V3Z"/>',
  down: '<path d="m12 17-6-6 1.4-1.4L12 14.2l4.6-4.6L18 11l-6 6Z"/>',
  empty: '<path d="M4 6h16v12H4V6Zm2 2v8h12V8H6Z" opacity=".7"/>'
};

function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    node.innerHTML = icon(node.dataset.icon);
    delete node.dataset.icon;
  });
}

/* -------------------------------- modal --------------------------------- */

function modal({ title, subtitle, body, actions, width }) {
  const root = document.getElementById('modalRoot');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal', style: width ? `width:min(${width}px,100%)` : '' });

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  box.append(el('h2', { text: title }));
  if (subtitle) box.append(el('div', { class: 'modal-sub', text: subtitle }));
  box.append(body);

  if (actions !== false) {
    const bar = el('div', { class: 'modal-actions' });
    for (const action of (actions || [])) {
      bar.append(el('button', {
        class: `btn ${action.kind || 'ghost'}`,
        text: action.label,
        onclick: () => action.onClick(close)
      }));
    }
    bar.append(el('button', { class: 'btn ghost', text: 'Close', onclick: close }));
    box.append(bar);
  }

  backdrop.append(box);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  hydrateIcons(box);
  return { close, box };
}

function confirmDialog(message, onYes) {
  modal({
    title: 'Please confirm',
    body: el('p', { class: 'muted', text: message }),
    actions: [{ label: 'Yes, continue', kind: 'danger', onClick: (close) => { close(); onYes(); } }]
  });
}

/** Build one labelled form control and append it to a form grid. */
function formField(form, label, control, opts = {}) {
  const box = el('div', { class: `field ${opts.full ? 'full' : ''}` }, [el('label', { text: label }), control]);
  if (opts.hint) box.append(el('div', { class: 'hint', text: opts.hint }));
  form.append(box);
  return control;
}

function selectOf(options, value) {
  const control = el('select');
  for (const opt of options) {
    const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
    control.append(el('option', { value: o.value, selected: String(value ?? '') === String(o.value) }, [o.label]));
  }
  return control;
}

/* ------------------------------ page: shell ------------------------------ */

const PAGES = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'inbounds', label: 'Inbounds', icon: 'inbounds' },
  { id: 'clients', label: 'Clients', icon: 'clients' },
  { id: 'outbounds', label: 'Outbounds', icon: 'outbounds' },
  { id: 'routing', label: 'Routing', icon: 'routing' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'logs', label: 'Logs', icon: 'logs' },
  { id: 'account', label: 'Account', icon: 'account' }
];

const state = {
  page: 'dashboard',
  inbounds: [], clients: [], outbounds: [], routing: [], settings: {},
  protocols: null, timer: null
};

function navigate(page) {
  if (!PAGES.some((p) => p.id === page)) page = 'dashboard';
  state.page = page;
  location.hash = page;
  document.getElementById('pageTitle').textContent = (PAGES.find((p) => p.id === page) || {}).label || '';
  syncDock(true);
  render();
}

function render() {
  const view = document.getElementById('view');
  view.innerHTML = '';
  clearInterval(state.timer);
  state.timer = null;
  const painter = {
    dashboard: renderDashboard,
    inbounds: renderInbounds,
    clients: renderClients,
    outbounds: renderOutbounds,
    routing: renderRouting,
    settings: renderSettings,
    logs: renderLogs,
    account: renderAccount
  }[state.page] || renderDashboard;

  // shown until the painter settles, so a slow page is never a blank screen
  const loading = el('div', { class: 'card' }, [el('div', { class: 'skeleton', style: 'height:96px' })]);
  view.append(loading);

  // a page that throws must say so rather than leaving an empty screen behind
  Promise.resolve(painter(view))
    .then(() => loading.remove())
    .catch((err) => {
      view.innerHTML = '';
      view.append(el('div', { class: 'card empty' }, [
        el('div', { text: `Could not load this page: ${err.message}` }),
        el('button', { class: 'btn', style: 'margin-top:14px', text: 'Try again', onclick: render })
      ]));
    });
}

/* ----------------------------- page: dashboard --------------------------- */

function statCard(label, value, sub, barPercent, barKind) {
  return el('div', { class: 'card stat' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
    sub ? el('div', { class: 'sub', text: sub }) : null,
    barPercent !== undefined
      ? el('div', { class: `bar ${barKind || ''}`, html: `<i style="width:${Math.min(100, barPercent)}%"></i>` })
      : null
  ]);
}

async function renderDashboard(view) {
  const grid = el('div', { class: 'grid stats' });
  const info = el('div', { class: 'grid two', style: 'margin-top:16px' });
  view.append(grid, info);

  const paint = async () => {
    let status;
    try { status = await api.get('/status'); } catch (_) { return; }
    const s = status.system;

    grid.innerHTML = '';
    grid.append(
      statCard('CPU', `${s.cpu.percent}%`, `${s.cpu.cores} cores`, s.cpu.percent,
        s.cpu.percent > 85 ? 'danger' : s.cpu.percent > 60 ? 'warn' : ''),
      statCard('Memory', `${s.memory.percent}%`, `${bytes(s.memory.used)} of ${bytes(s.memory.total)}`,
        s.memory.percent, s.memory.percent > 85 ? 'danger' : s.memory.percent > 60 ? 'warn' : ''),
      statCard('Disk', `${s.disk.percent}%`, `${bytes(s.disk.used)} of ${bytes(s.disk.total)}`,
        s.disk.percent, s.disk.percent > 85 ? 'danger' : ''),
      statCard('Network', `${bytes(s.network.speed.rx)}/s ↓`, `${bytes(s.network.speed.tx)}/s ↑`),
      statCard('Active clients', String(status.counts.clientsActive), `of ${status.counts.clients} total`),
      statCard('Inbounds', String(status.counts.inboundsEnabled), `of ${status.counts.inbounds} total`),
      statCard('Total traffic', bytes(status.traffic.up + status.traffic.down),
        `${bytes(status.traffic.down)} ↓ · ${bytes(status.traffic.up)} ↑`),
      statCard('Uptime', duration(s.uptime), s.platform)
    );

    info.innerHTML = '';
    info.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'between', style: 'margin-bottom:14px' }, [
          el('strong', { text: 'Xray-core' }),
          el('span', {
            class: `chip ${status.xray.running ? 'ok' : 'danger'}`,
            html: `<i></i>${status.xray.running ? 'Running' : 'Stopped'}`
          })
        ]),
        el('div', { class: 'muted', text: status.xray.version || 'version unknown' }),
        el('div', { class: 'row', style: 'margin-top:16px' }, [
          el('button', { class: 'btn', html: `${icon('refresh')} Restart`, onclick: () => xrayAction('restart') }),
          el('button', { class: 'btn', html: `${icon('power')} Stop`, onclick: () => xrayAction('stop') }),
          el('button', { class: 'btn', html: `${icon('power')} Start`, onclick: () => xrayAction('start') })
        ])
      ]),
      el('div', { class: 'card' }, [
        el('strong', { text: 'Server' }),
        el('div', { class: 'muted', style: 'margin-top:12px;line-height:2' }, [
          el('div', { text: `Hostname: ${s.hostname}` }),
          el('div', { text: `Panel domain: ${status.settings.domain || 'not set'}` }),
          el('div', { text: `Load average: ${s.loadavg.map((n) => n.toFixed(2)).join(' / ')}` }),
          el('div', { text: `Outbounds: ${status.counts.outbounds} · Routing rules: ${status.counts.routingRules}` }),
          el('div', { text: `Expired: ${status.counts.clientsExpired} · Out of quota: ${status.counts.clientsDepleted}` })
        ])
      ])
    );

    const chip = document.getElementById('xrayChip');
    chip.className = `chip ${status.xray.running ? 'ok' : 'danger'}`;
    chip.innerHTML = `<i></i><span>Xray ${status.xray.running ? 'up' : 'down'}</span>`;
    // keep just "Xray x.y.z"; the full build string is too long for the chip
    const shortVersion = (status.xray.version || '').split('(')[0].trim();
    const chipTitle = document.getElementById('xrayChip');
    if (chipTitle) chipTitle.title = shortVersion || 'Xray-core';
  };

  await paint();
  // a hidden tab must not keep polling: it wakes the server for nothing
  state.timer = setInterval(() => { if (!document.hidden) paint(); }, 8000);
}

async function xrayAction(action) {
  try {
    await api.post(`/xray/${action}`);
    toast('Done');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** Shared table scaffolding: header row, loading state, empty state. */
function tableShell(view, { intro, addLabel, onAdd }) {
  view.append(el('div', { class: 'between', style: 'margin-bottom:16px' }, [
    el('div', { class: 'muted', text: intro }),
    onAdd ? el('button', { class: 'btn primary', html: `${icon('plus')} ${addLabel}`, onclick: onAdd }) : null
  ]));
  const wrap = el('div', { class: 'table-wrap' });
  wrap.innerHTML = '<div class="empty"><div class="skeleton" style="height:120px"></div></div>';
  view.append(wrap);
  return wrap;
}

/*
 * Phones get one card per row instead of a table you have to drag sideways.
 * The layout is CSS, but it needs every cell to carry its column name, which
 * only the header row knows.
 */
function mountTable(wrap, table) {
  const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  for (const tr of table.querySelectorAll('tbody tr')) {
    [...tr.children].forEach((td, i) => {
      if (!heads[i]) td.classList.add('cell-actions');
      else {
        td.setAttribute('data-label', heads[i]);
        if (heads[i] === 'Status') td.classList.add('cell-status');
      }
    });
    // the row's own name heads its card; a table without one (the log) gets no heading
    const title = [...tr.children].find((td) => td.querySelector('strong'));
    if (title) title.classList.add('cell-title');
  }
  wrap.innerHTML = '';
  wrap.append(table);
}

function emptyState(wrap, message) {
  wrap.innerHTML = `<div class="empty">${icon('empty', 42)}<div>${message}</div></div>`;
}

/* ----------------------------- page: inbounds ---------------------------- */

/**
 * A "..." button with a drop-down of actions, the way 3x-ui presents them.
 * Items are {label, onClick, danger} or the string 'sep'.
 */
function popupMenu(items, opts = {}) {
  const wrap = el('div', { class: 'menu-wrap' });
  const panel = el('div', { class: 'popup', hidden: 'hidden' });

  for (const item of items) {
    if (item === 'sep') { panel.append(el('div', { class: 'sep' })); continue; }
    if (!item) continue;
    panel.append(el('button', {
      type: 'button',
      class: item.danger ? 'danger' : '',
      text: item.label,
      onclick: (event) => { event.stopPropagation(); close(); item.onClick(); }
    }));
  }

  const close = () => {
    panel.hidden = true;
    panel.remove();
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
  };
  const onOutside = (event) => {
    if (!wrap.contains(event.target) && !panel.contains(event.target)) close();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };

  /*
   * The menu lives on <body>, not next to its button: a row menu sits inside
   * the table's horizontal scroller, which would clip it to a sliver.
   */
  /* Re-anchor rather than close: on a phone the button often has to be
     scrolled into view, and a menu that shuts on every scroll cannot be used. */
  const place = () => {
    const box = button.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const margin = 8;
    let left = box.right - width;
    let top = box.bottom + 6;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    if (top + height > window.innerHeight - margin) top = Math.max(margin, box.top - height - 6);
    panel.style.position = 'fixed';
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.insetInlineEnd = 'auto';
  };

  const open = () => {
    document.querySelectorAll('.popup').forEach((p) => p.remove());
    document.body.append(panel);
    panel.hidden = false;
    place();
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
  };

  const button = el('button', {
    class: opts.class || 'btn icon ghost',
    title: opts.title || 'More actions',
    html: opts.html || icon('more'),
    onclick: (event) => {
      event.stopPropagation();
      if (panel.isConnected && !panel.hidden) close();
      else open();
    }
  });

  wrap.append(button);
  return wrap;
}

/** Show text in a dialog the admin can copy or save. */
function textDialog(title, subtitle, text) {
  const area = el('textarea', { readonly: 'readonly', style: 'min-height:280px' }, [text]);
  const body = el('div', {}, [
    area,
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn', html: `${icon('copy')} Copy all`, onclick: () => copy(text) }),
      el('button', {
        class: 'btn ghost', text: 'Select all',
        onclick: () => { area.focus(); area.select(); }
      })
    ])
  ]);
  modal({ title, subtitle, body, width: 720 });
}

async function fetchText(path) {
  const res = await fetch(`${BASE}api${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function loadProtocols() {
  if (!state.protocols) state.protocols = await api.get('/protocols');
  return state.protocols;
}

/** Read a .json file the admin picks, and hand back the parsed contents. */
function pickJsonFile() {
  return new Promise((resolve) => {
    const picker = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      picker.remove();
      if (!file) return resolve(null);
      try {
        resolve(JSON.parse(await file.text()));
      } catch (_) {
        toast('That file is not valid JSON', 'err');
        resolve(null);
      }
    });
    document.body.append(picker);
    picker.click();
  });
}

async function importInboundFile() {
  const data = await pickJsonFile();
  if (!data) return;
  try {
    const result = await api.post('/inbounds/import', data);
    toast(`Imported with ${result.clients} client(s)`);
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function showUrls(kind, inboundId) {
  const query = inboundId ? `?inboundId=${encodeURIComponent(inboundId)}` : '';
  try {
    const text = await fetchText(`/${kind === 'sub' ? 'sub-urls' : 'urls'}${query}`);
    if (!text.trim()) return toast('Nothing to export yet');
    textDialog(
      kind === 'sub' ? 'Subscription URLs' : 'Share links',
      kind === 'sub'
        ? 'One per client. The same links keep working after an import, as long as the domain matches.'
        : 'One per client, ready to paste into a client app.',
      text
    );
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function resetTraffic(inboundId, label) {
  confirmDialog(`Reset the traffic counters for ${label}?`, async () => {
    try {
      const result = await api.post('/inbounds/reset-traffic', inboundId ? { inboundId } : {});
      toast(`Traffic reset for ${result.count} client(s)`);
      render();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function renderInbounds(view) {
  view.append(el('div', { class: 'between', style: 'margin-bottom:16px' }, [
    el('div', { class: 'muted', text: 'Each inbound is one port and one protocol that clients connect to.' }),
    el('div', { class: 'row' }, [
      popupMenu([
        { label: 'Import an inbound', onClick: importInboundFile },
        'sep',
        { label: 'Export all URLs', onClick: () => showUrls('links', null) },
        { label: 'Export all URLs — subscription', onClick: () => showUrls('sub', null) },
        'sep',
        { label: 'Reset traffic for all inbounds', danger: true, onClick: () => resetTraffic(null, 'every inbound') }
      ], { class: 'btn ghost', html: icon('menu'), title: 'Inbound actions' }),
      el('button', { class: 'btn primary', html: `${icon('plus')} New inbound`, onclick: () => inboundForm(null) })
    ])
  ]));

  const wrap = el('div', { class: 'table-wrap' });
  wrap.innerHTML = '<div class="empty"><div class="skeleton" style="height:120px"></div></div>';
  view.append(wrap);

  await loadProtocols();
  state.inbounds = await api.get('/inbounds');
  if (!state.inbounds.length) {
    return emptyState(wrap, 'No inbounds yet. Create one to start accepting connections.');
  }

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>Name</th><th>Protocol</th><th>Port</th><th>Transport</th>
    <th>Clients</th><th>Traffic</th><th>Status</th><th></th>
  </tr></thead>`;
  const tbody = el('tbody');

  for (const inb of state.inbounds) {
    tbody.append(el('tr', {}, [
      el('td', {}, [el('strong', { text: inb.remark })]),
      el('td', {}, [el('span', { class: 'chip brand', text: inb.protocol })]),
      el('td', { class: 'mono', text: String(inb.port) }),
      el('td', { class: 'muted', text: `${inb.network}${inb.security !== 'none' ? ` · ${inb.security}` : ''}` }),
      el('td', { text: String(inb.clientCount) }),
      el('td', { class: 'muted num', text: bytes(inb.up + inb.down) }),
      el('td', {}, [el('span', {
        class: `chip ${inb.enable === false ? '' : 'ok'}`,
        html: `<i></i>${inb.enable === false ? 'Disabled' : 'Enabled'}`
      })]),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn icon ghost', title: 'Edit', html: icon('edit'), onclick: () => inboundForm(inb) }),
        el('button', {
          class: 'btn icon ghost', title: 'Enable / disable', html: icon('power'),
          onclick: async () => { await api.post(`/inbounds/${inb.id}/toggle`); render(); }
        }),
        popupMenu([
          { label: 'Edit', onClick: () => inboundForm(inb) },
          { label: 'Export inbound', onClick: () => { location.href = `${BASE}api/inbounds/${inb.id}/export`; } },
          { label: 'Export all URLs', onClick: () => showUrls('links', inb.id) },
          { label: 'Export all URLs — subscription', onClick: () => showUrls('sub', inb.id) },
          'sep',
          { label: 'Reset traffic', onClick: () => resetTraffic(inb.id, `"${inb.remark}"`) },
          'sep',
          {
            label: 'Delete',
            danger: true,
            onClick: () => confirmDialog(`Delete inbound "${inb.remark}" and all of its clients?`, async () => {
              try {
                await api.del(`/inbounds/${inb.id}`);
                toast('Inbound deleted');
                render();
              } catch (err) { toast(err.message, 'err'); }
            })
          }
        ])
      ])])
    ]));
  }
  table.append(tbody);
  mountTable(wrap, table);
}

const PROTOCOL_LABELS = {
  vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks',
  socks: 'SOCKS5', http: 'HTTP', 'dokodemo-door': 'Dokodemo-door', wireguard: 'WireGuard',
  freedom: 'Freedom (direct)', blackhole: 'Blackhole (block)', dns: 'DNS'
};

const SS_METHODS = [
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'
];

/** A tabbed dialog body: returns the wrapper plus one form grid per tab. */
/**
 * A text input with a Generate button beside it. Nothing is ever filled in
 * behind the admin's back: an empty field stays empty until this is pressed.
 */
function generatedField(value, kind, opts = {}) {
  const input = el('input', { type: 'text', value: value ?? '', placeholder: opts.placeholder || '' });
  const button = el('button', {
    class: 'btn ghost',
    type: 'button',
    text: 'Generate',
    onclick: async () => {
      button.disabled = true;
      const label = button.textContent;
      button.textContent = '...';
      try {
        const query = opts.query ? `?${opts.query()}` : '';
        const result = await api.get(`/generate/${kind}${query}`);
        input.value = result.value ?? result.privateKey ?? '';
        if (opts.onResult) opts.onResult(result);
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        button.textContent = label;
        button.disabled = false;
      }
    }
  });
  const row = el('div', { class: 'input-row' }, [input, button]);
  row.input = input;
  return row;
}

/** A text field with a labelled action button beside it. */
function actionField(value, label, onClick, opts = {}) {
  const input = opts.multiline
    ? el('textarea', { placeholder: opts.placeholder || '', style: 'min-height:90px' }, [value || ''])
    : el('input', { type: 'text', value: value ?? '', placeholder: opts.placeholder || '' });
  const button = el('button', {
    class: 'btn ghost', type: 'button', text: label,
    onclick: async () => {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = '...';
      try { await onClick(input); } catch (err) { toast(err.message, 'err'); }
      button.textContent = original;
      button.disabled = false;
    }
  });
  const row = el('div', { class: 'input-row' }, [input, button]);
  row.input = input;
  return row;
}

function tabbed(names) {
  const wrap = el('div');
  const bar = el('div', { class: 'tabs' });
  const panels = {};
  const tabs = [];

  names.forEach((name, index) => {
    const panel = el('div', { class: 'tab-panel form-grid' });
    if (index > 0) panel.hidden = true;
    panels[name] = panel;

    const tab = el('div', {
      class: `tab ${index === 0 ? 'active' : ''}`,
      text: name,
      onclick: () => {
        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        for (const [key, node] of Object.entries(panels)) node.hidden = key !== name;
      }
    });
    tabs.push(tab);
    bar.append(tab);
  });

  wrap.append(bar, ...Object.values(panels));
  return { wrap, panels };
}

/** Segmented control, the way 3x-ui presents Security and certificate source. */
function segmented(options, value, onChange) {
  const box = el('div', { class: 'seg' });
  const buttons = [];
  for (const opt of options) {
    const button = el('button', {
      type: 'button',
      class: value === opt.value ? 'active' : '',
      text: opt.label,
      onclick: () => {
        buttons.forEach((b) => b.classList.remove('active'));
        button.classList.add('active');
        box.dataset.value = opt.value;
        onChange(opt.value);
      }
    });
    buttons.push(button);
    box.append(button);
  }
  box.dataset.value = value;
  return box;
}

/** Multi-select as a row of chips (ALPN, sniffing targets). */
function chipSet(options, selected) {
  const box = el('div', { class: 'chips' });
  for (const opt of options) {
    const input = el('input', { type: 'checkbox', value: opt });
    input.checked = selected.includes(opt);
    box.append(el('label', {}, [input, opt]));
  }
  box.values = () => Array.from(box.querySelectorAll('input:checked')).map((i) => i.value);
  return box;
}

function toggle(checked) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  return el('label', { class: 'switch' }, [input, el('span', { class: 'track' })]);
}
const toggleValue = (node) => node.querySelector('input').checked;

function inboundForm(existing) {
  const v = existing || {};
  const protocols = (state.protocols && state.protocols.inbound) || ['vless'];
  const { wrap, panels } = tabbed(['Basics', 'Protocol', 'Stream', 'Security', 'Sniffing']);

  /* one helper for every labelled control, so each tab reads as a list */
  const add = (tab, label, control, opts = {}) => formField(panels[tab], label, control, opts);
  const text = (value, opts = {}) => el('input', {
    type: opts.type || 'text', value: value ?? '', placeholder: opts.placeholder || ''
  });

  /* ------------------------------- Basics ------------------------------- */
  const remark = add('Basics', 'Remark', text(v.remark || 'inbound-1'));
  const port = add('Basics', 'Port', text(v.port || Math.floor(20000 + Math.random() * 40000), { type: 'number' }));
  const listen = add('Basics', 'Listen IP', text(v.listen || ''), { placeholder: '0.0.0.0', hint: 'Empty listens on every address' });
  const address = add('Basics', 'Connect address', text(v.address || ''), {
    full: true, hint: 'Used in share links. Defaults to the panel domain or server IP.'
  });
  const enable = add('Basics', 'Enabled', toggle(v.enable !== false));

  /* ------------------------------ Protocol ------------------------------ */
  const protocol = add('Protocol', 'Protocol', selectOf(
    protocols.map((p) => ({ value: p, label: PROTOCOL_LABELS[p] || p })), v.protocol || 'vless'
  ));
  const ssMethod = add('Protocol', 'Cipher', selectOf(SS_METHODS, v.method || '2022-blake3-aes-128-gcm'));
  const ssPasswordRow = generatedField(v.password || '', 'sskey', {
    query: () => `method=${encodeURIComponent(ssMethod.value)}`,
    placeholder: 'press Generate'
  });
  add('Protocol', 'Inbound password', ssPasswordRow, {
    full: true, hint: 'Must match the cipher; Generate makes a key of the right size'
  });
  const ssPassword = ssPasswordRow.input;
  const udp = add('Protocol', 'UDP relay', toggle(v.udp !== false));
  const targetAddress = add('Protocol', 'Forward to address', text(v.targetAddress || '127.0.0.1'));
  const targetPort = add('Protocol', 'Forward to port', text(v.targetPort || 0, { type: 'number' }));
  const targetNetwork = add('Protocol', 'Forwarded networks', selectOf(['tcp,udp', 'tcp', 'udp'], v.targetNetwork || 'tcp,udp'));
  const followRedirect = add('Protocol', 'Follow redirect', toggle(v.followRedirect));
  const wgPrivateKeyRow = generatedField(v.wgPrivateKey || '', 'wireguard', { placeholder: 'press Generate' });
  add('Protocol', 'WireGuard private key', wgPrivateKeyRow, { full: true });
  const wgPrivateKey = wgPrivateKeyRow.input;
  const wgMtu = add('Protocol', 'MTU', text(v.wgMtu || 1420, { type: 'number' }));

  /* ------------------------------- Stream ------------------------------- */
  const network = add('Stream', 'Transmission', selectOf([
    { value: 'tcp', label: 'TCP' }, { value: 'ws', label: 'WebSocket' },
    { value: 'grpc', label: 'gRPC' }, { value: 'httpupgrade', label: 'HTTPUpgrade' },
    { value: 'xhttp', label: 'XHTTP' }, { value: 'kcp', label: 'mKCP' }
  ], v.network || 'tcp'));
  const wsHost = add('Stream', 'Host', text(v.wsHost || ''));
  const wsPath = add('Stream', 'Path', text(v.wsPath || '/'));
  const xhttpMode = add('Stream', 'Mode', selectOf(['auto', 'packet-up', 'stream-up', 'stream-one'], v.xhttpMode || 'auto'));
  const xhttpMaxUploadSize = add('Stream', 'Max upload size (bytes)', text(v.xhttpMaxUploadSize || ''), { placeholder: 'xray default' });
  const xhttpMaxBufferedUpload = add('Stream', 'Max buffered upload', text(v.xhttpMaxBufferedUpload || '', { type: 'number' }), { placeholder: '30' });
  const xhttpMinUploadInterval = add('Stream', 'Min upload interval (ms)', text(v.xhttpMinUploadInterval || ''), { placeholder: 'e.g. 50-150' });
  const xhttpMaxHeaderBytes = add('Stream', 'Server max header bytes', text(v.xhttpMaxHeaderBytes || '', { type: 'number' }), { placeholder: 'xray default' });
  const grpcService = add('Stream', 'gRPC service name', text(v.grpcServiceName || 'nexv-grpc'));
  const kcpSeed = add('Stream', 'mKCP seed', text(v.kcpSeed || ''));
  const kcpHeader = add('Stream', 'mKCP header', selectOf(['none', 'srtp', 'utp', 'wechat-video', 'dtls', 'wireguard'], v.kcpHeader || 'none'));

  /* ------------------------------ Security ------------------------------ */
  let security = v.security || 'none';
  const securitySeg = segmented(
    [{ value: 'none', label: 'None' }, { value: 'tls', label: 'TLS' }, { value: 'reality', label: 'Reality' }],
    security,
    (value) => { security = value; sync(); }
  );
  add('Security', 'Security', securitySeg, { full: true });

  const sni = add('Security', 'SNI', text(v.sni || ''), { placeholder: 'Server Name Indication' });
  const cipherSuites = add('Security', 'Cipher suites', text(v.cipherSuites || ''), { placeholder: 'Auto' });
  const tlsMinVersion = add('Security', 'Min version', selectOf(['1.0', '1.1', '1.2', '1.3'], v.tlsMinVersion || '1.2'));
  const tlsMaxVersion = add('Security', 'Max version', selectOf(['1.0', '1.1', '1.2', '1.3'], v.tlsMaxVersion || '1.3'));
  const fingerprint = add('Security', 'uTLS', selectOf(
    ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'], v.fingerprint || 'chrome'
  ));
  const alpn = add('Security', 'ALPN', chipSet(['h2', 'http/1.1', 'h3'], v.alpn || ['h2', 'http/1.1']), { full: true });
  const curvePreferences = add('Security', 'Curve preferences', text((v.curvePreferences || []).join(',')), {
    full: true, placeholder: 'X25519,P-256'
  });
  const rejectUnknownSni = add('Security', 'Reject unknown SNI', toggle(v.rejectUnknownSni));

  let certSource = (v.certContent && v.keyContent) ? 'content' : 'path';
  const certSeg = segmented(
    [{ value: 'path', label: 'File path' }, { value: 'content', label: 'File content' }],
    certSource,
    (value) => { certSource = value; sync(); }
  );
  add('Security', 'Digital certificate', certSeg, { full: true });

  const certFile = add('Security', 'Certificate path', text(v.certFile || ''), {
    full: true, placeholder: '/etc/letsencrypt/live/example.com/fullchain.pem'
  });
  const keyFile = add('Security', 'Private key path', text(v.keyFile || ''), {
    full: true, placeholder: '/etc/letsencrypt/live/example.com/privkey.pem'
  });
  const setCertBtn = el('button', {
    class: 'btn', type: 'button', text: 'Set cert from panel',
    onclick: async () => {
      try {
        const settings = await api.get('/settings');
        if (!settings.certFile || !settings.keyFile) {
          return toast('The panel has no certificate yet. Run: nexv cert <domain>', 'err');
        }
        certFile.value = settings.certFile;
        keyFile.value = settings.keyFile;
        if (!sni.value && settings.domain) sni.value = settings.domain;
        toast('Filled in from the panel certificate');
      } catch (err) { toast(err.message, 'err'); }
    }
  });
  add('Security', ' ', el('div', { class: 'row' }, [setCertBtn]), { full: true });
  const certContent = add('Security', 'Certificate', el('textarea', {}, [v.certContent || '']), {
    full: true, placeholder: '-----BEGIN CERTIFICATE-----'
  });
  const keyContent = add('Security', 'Private key', el('textarea', {}, [v.keyContent || '']), { full: true });
  const ocspStapling = add('Security', 'OCSP stapling (s)', text(v.ocspStapling || 0, { type: 'number' }));
  const certOneTimeLoading = add('Security', 'One time loading', toggle(v.certOneTimeLoading));
  const certUsage = add('Security', 'Usage option', selectOf(['encipherment', 'verify', 'issue'], v.certUsage || 'encipherment'));
  const masterKeyLog = add('Security', 'Master key log', text(v.masterKeyLog || ''), { full: true, placeholder: '/path/to/sslkeylog.txt' });

  const echKeysRow = actionField(v.echServerKeys || '', 'Get new ECH cert', async (input) => {
    if (!sni.value.trim()) return toast('Fill in the SNI first', 'err');
    const result = await api.get(`/generate/ech?sni=${encodeURIComponent(sni.value.trim())}`);
    input.value = result.echServerKeys || '';
    echConfig.value = result.echConfigList || '';
    toast('ECH keys generated');
  }, { multiline: true, placeholder: 'press Get new ECH cert' });
  add('Security', 'ECH key', echKeysRow, { full: true, hint: 'Server-side keys. Needs an SNI.' });
  const echKeys = echKeysRow.input;
  const echConfig = add('Security', 'ECH config', el('textarea', { style: 'min-height:90px' }, [v.echConfigList || '']), {
    full: true, hint: 'Handed to clients; filled in by the button above.'
  });

  const rDest = add('Security', 'REALITY dest', text((v.reality && v.reality.dest) || 'www.cloudflare.com:443'));
  const rNames = add('Security', 'REALITY server names', text((v.reality && (v.reality.serverNames || []).join(',')) || 'www.cloudflare.com'));
  const rPrivRow = generatedField((v.reality && v.reality.privateKey) || '', 'reality', {
    placeholder: 'press Generate',
    onResult: (keys) => { rPub.value = keys.publicKey || ''; }
  });
  add('Security', 'REALITY private key', rPrivRow, { full: true, hint: 'Generate fills the public key too' });
  const rPriv = rPrivRow.input;
  const rPub = add('Security', 'REALITY public key', text((v.reality && v.reality.publicKey) || ''), { full: true });
  const rShortRow = generatedField((v.reality && (v.reality.shortIds || []).join(',')) || '', 'shortid');
  add('Security', 'REALITY short IDs', rShortRow);
  const rShort = rShortRow.input;

  /* ------------------------------ Sniffing ------------------------------ */
  const sniffing = add('Sniffing', 'Sniffing', toggle(v.sniffing !== false));
  const sniffDestOverride = add('Sniffing', 'Destination override',
    chipSet(['http', 'tls', 'quic', 'fakedns'], v.sniffDestOverride || ['http', 'tls', 'quic']), { full: true });
  const sniffMetadataOnly = add('Sniffing', 'Metadata only', toggle(v.sniffMetadataOnly));
  const sniffRouteOnly = add('Sniffing', 'Route only', toggle(v.sniffRouteOnly));

  /* --------------------------- field visibility -------------------------- */
  const fieldOf = (control) => control.closest('.field');
  const show = (nodes, on) => [].concat(nodes).forEach((n) => n.classList.toggle('hidden', !on));

  function sync() {
    const proto = protocol.value;
    const net = network.value;
    // wireguard and dokodemo-door carry no xray transport of their own
    const hasStream = proto !== 'wireguard' && proto !== 'dokodemo-door';

    show([fieldOf(ssMethod), fieldOf(ssPassword)], proto === 'shadowsocks');
    show(fieldOf(udp), proto === 'socks');
    show([fieldOf(targetAddress), fieldOf(targetPort), fieldOf(targetNetwork), fieldOf(followRedirect)], proto === 'dokodemo-door');
    show([fieldOf(wgPrivateKey), fieldOf(wgMtu)], proto === 'wireguard');

    show(fieldOf(network), hasStream);
    show([fieldOf(wsHost), fieldOf(wsPath)], hasStream && ['ws', 'httpupgrade', 'xhttp'].includes(net));
    show([fieldOf(xhttpMode), fieldOf(xhttpMaxUploadSize), fieldOf(xhttpMaxBufferedUpload),
      fieldOf(xhttpMinUploadInterval), fieldOf(xhttpMaxHeaderBytes)], hasStream && net === 'xhttp');
    show(fieldOf(grpcService), hasStream && net === 'grpc');
    show([fieldOf(kcpSeed), fieldOf(kcpHeader)], hasStream && net === 'kcp');

    const tls = hasStream && security === 'tls';
    const reality = hasStream && security === 'reality';
    show(fieldOf(securitySeg), hasStream);
    show([fieldOf(sni), fieldOf(cipherSuites), fieldOf(tlsMinVersion), fieldOf(tlsMaxVersion),
      fieldOf(fingerprint), fieldOf(alpn), fieldOf(curvePreferences), fieldOf(rejectUnknownSni),
      fieldOf(certSeg), fieldOf(ocspStapling), fieldOf(certOneTimeLoading), fieldOf(certUsage),
      fieldOf(masterKeyLog), fieldOf(echKeys), fieldOf(echConfig), setCertBtn.closest('.field')], tls);
    show([fieldOf(certFile), fieldOf(keyFile)], tls && certSource === 'path');
    show([fieldOf(certContent), fieldOf(keyContent)], tls && certSource === 'content');
    show([fieldOf(rDest), fieldOf(rNames), fieldOf(rPriv), fieldOf(rPub), fieldOf(rShort)], reality);

    // REALITY only works over raw TCP or gRPC/xhttp; keep the pairing sane
    if (reality && (net === 'ws' || net === 'httpupgrade')) {
      security = 'none';
      securitySeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === 0));
      toast('REALITY cannot be combined with WebSocket', 'err');
      sync();
    }
  }
  [protocol, network].forEach((c) => c.addEventListener('change', sync));
  sync();

  modal({
    title: existing ? 'Edit inbound' : 'Add inbound',
    subtitle: 'Saving writes the Xray config and restarts the service.',
    body: wrap,
    width: 720,
    actions: [{
      label: existing ? 'Save changes' : 'Create',
      kind: 'primary',
      onClick: async (close) => {
        const payload = {
          remark: remark.value,
          port: Number(port.value),
          listen: listen.value.trim(),
          address: address.value,
          enable: toggleValue(enable),
          protocol: protocol.value,
          method: ssMethod.value,
          password: ssPassword.value,
          udp: toggleValue(udp),
          targetAddress: targetAddress.value,
          targetPort: Number(targetPort.value),
          targetNetwork: targetNetwork.value,
          followRedirect: toggleValue(followRedirect),
          wgPrivateKey: wgPrivateKey.value.trim(),
          wgMtu: Number(wgMtu.value),
          network: network.value,
          wsHost: wsHost.value,
          wsPath: wsPath.value,
          xhttpMode: xhttpMode.value,
          xhttpMaxUploadSize: xhttpMaxUploadSize.value,
          xhttpMaxBufferedUpload: xhttpMaxBufferedUpload.value,
          xhttpMinUploadInterval: xhttpMinUploadInterval.value,
          xhttpMaxHeaderBytes: xhttpMaxHeaderBytes.value,
          grpcServiceName: grpcService.value,
          kcpSeed: kcpSeed.value,
          kcpHeader: kcpHeader.value,
          security,
          sni: sni.value,
          cipherSuites: cipherSuites.value,
          tlsMinVersion: tlsMinVersion.value,
          tlsMaxVersion: tlsMaxVersion.value,
          fingerprint: fingerprint.value,
          alpn: alpn.values(),
          curvePreferences: curvePreferences.value,
          rejectUnknownSni: toggleValue(rejectUnknownSni),
          certFile: certSource === 'path' ? certFile.value : '',
          keyFile: certSource === 'path' ? keyFile.value : '',
          certContent: certSource === 'content' ? certContent.value : '',
          keyContent: certSource === 'content' ? keyContent.value : '',
          ocspStapling: Number(ocspStapling.value),
          certOneTimeLoading: toggleValue(certOneTimeLoading),
          certUsage: certUsage.value,
          masterKeyLog: masterKeyLog.value,
          echServerKeys: echKeys.value.trim(),
          echConfigList: echConfig.value.trim(),
          sniffing: toggleValue(sniffing),
          sniffDestOverride: sniffDestOverride.values(),
          sniffMetadataOnly: toggleValue(sniffMetadataOnly),
          sniffRouteOnly: toggleValue(sniffRouteOnly),
          reality: {
            dest: rDest.value,
            serverNames: rNames.value.split(',').map((x) => x.trim()).filter(Boolean),
            privateKey: rPriv.value,
            publicKey: rPub.value,
            shortIds: rShort.value.split(',').map((x) => x.trim()).filter(Boolean)
          }
        };
        try {
          if (existing) await api.put(`/inbounds/${existing.id}`, payload);
          else await api.post('/inbounds', payload);
          close();
          toast('Inbound saved');
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      }
    }]
  });
}

/* ------------------------------ page: clients ---------------------------- */

async function renderClients(view) {
  const wrap = tableShell(view, {
    intro: 'Clients of each inbound, with their quota and expiry.',
    addLabel: 'New client',
    onAdd: () => clientForm(null)
  });

  await loadProtocols();
  const [inbounds, clients] = await Promise.all([api.get('/inbounds'), api.get('/clients')]);
  state.inbounds = inbounds;
  state.clients = clients;

  if (!inbounds.length) return emptyState(wrap, 'Create an inbound first, then add clients to it.');
  if (!clients.length) return emptyState(wrap, 'No clients yet.');

  const withLinks = (state.protocols && state.protocols.withLinks) || [];
  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>Client</th><th>Inbound</th><th>Used</th><th>Quota</th>
    <th>Expires</th><th>Status</th><th></th>
  </tr></thead>`;
  const tbody = el('tbody');

  for (const c of clients) {
    const used = (c.up || 0) + (c.down || 0);
    const quota = (c.totalGB || 0) * 1024 ** 3;
    const percent = quota ? (used / quota) * 100 : 0;
    const left = daysLeft(c.expiryTime);
    const shareable = withLinks.includes(c.protocol) && !!c.link;

    let statusChip;
    if (c.enable === false) statusChip = el('span', { class: 'chip', html: '<i></i>Disabled' });
    else if (c.expired) statusChip = el('span', { class: 'chip danger', html: '<i></i>Expired' });
    else if (c.depleted) statusChip = el('span', { class: 'chip danger', html: '<i></i>Out of quota' });
    else statusChip = el('span', { class: 'chip ok', html: '<i></i>Active' });

    tbody.append(el('tr', {}, [
      el('td', {}, [
        el('strong', { text: c.email }),
        el('div', { class: 'faint mono', style: 'font-size:11px', text: c.protocol })
      ]),
      el('td', { class: 'muted', text: c.inboundRemark }),
      el('td', {}, [
        el('div', { class: 'num', text: bytes(used) }),
        quota ? el('div', { class: `bar ${percent > 90 ? 'danger' : percent > 70 ? 'warn' : ''}`, style: 'width:110px', html: `<i style="width:${Math.min(100, percent)}%"></i>` }) : null
      ]),
      el('td', { class: 'muted num', text: c.totalGB ? `${c.totalGB} GB` : 'Unlimited' }),
      el('td', { class: 'muted' }, [
        el('div', { text: fmtDate(c.expiryTime) }),
        left !== null ? el('div', { class: 'faint', style: 'font-size:11px', text: left > 0 ? `${left} days left` : 'past due' }) : null
      ]),
      el('td', {}, [statusChip]),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        shareable ? el('button', { class: 'btn icon ghost', title: 'QR code and links', html: icon('qr'), onclick: () => showClientLink(c) }) : null,
        shareable ? el('button', { class: 'btn icon ghost', title: 'Copy config link', html: icon('copy'), onclick: () => copy(c.link) }) : null,
        el('button', { class: 'btn icon ghost', title: 'Edit', html: icon('edit'), onclick: () => clientForm(c) }),
        el('button', {
          class: 'btn icon ghost', title: 'Enable / disable', html: icon('power'),
          onclick: async () => { await api.post(`/clients/${c.id}/toggle`); render(); }
        }),
        el('button', {
          class: 'btn icon danger', title: 'Delete', html: icon('trash'),
          onclick: () => confirmDialog(`Delete client "${c.email}"?`, async () => {
            try {
              await api.del(`/clients/${c.id}`);
              toast('Client deleted');
              render();
            } catch (err) { toast(err.message, 'err'); }
          })
        })
      ])])
    ]));
  }
  table.append(tbody);
  mountTable(wrap, table);
}

async function showClientLink(client) {
  const [qr, sub] = await Promise.all([
    api.get(`/clients/${client.id}/qrcode`),
    api.get(`/clients/${client.id}/sub-url`)
  ]);
  const body = el('div', { class: 'qr-box' }, [
    el('img', { src: qr.dataUrl, alt: 'QR code' }),
    el('div', { class: 'link-box', text: qr.content }),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', html: `${icon('copy')} Copy config link`, onclick: () => copy(qr.content) }),
      el('button', { class: 'btn', html: `${icon('copy')} Copy subscription`, onclick: () => copy(sub.url) })
    ]),
    el('div', { class: 'link-box', text: sub.url })
  ]);
  modal({ title: `Config for ${client.email}`, subtitle: 'Scan the code or copy a link into your client app.', body, width: 440 });
}

function clientForm(existing) {
  const v = existing || {};
  const form = el('div', { class: 'form-grid' });

  const email = formField(form, 'Client name', el('input', { value: v.email || '', placeholder: 'user-01' }));
  const inboundSel = el('select');
  for (const inb of state.inbounds) {
    inboundSel.append(el('option', { value: inb.id, selected: v.inboundId === inb.id }, [`${inb.remark} · ${inb.protocol}:${inb.port}`]));
  }
  formField(form, 'Inbound', inboundSel);

  const uuidRow = generatedField(v.uuid || '', 'uuid', { placeholder: 'leave empty to generate on save' });
  formField(form, 'UUID', uuidRow, { full: true });
  const uuid = uuidRow.input;
  const passwordRow = generatedField(v.password || '', 'password', { placeholder: 'leave empty to generate on save' });
  formField(form, 'Password / key', passwordRow,
    { full: true, hint: 'Used by Trojan, Shadowsocks, SOCKS and HTTP inbounds' });
  const password = passwordRow.input;
  const totalGB = formField(form, 'Quota (GB)', el('input', { type: 'number', min: '0', value: v.totalGB || 0 }), { hint: '0 means unlimited' });

  const days = el('input', { type: 'number', min: '0', value: v.expiryTime ? Math.max(0, daysLeft(v.expiryTime)) : 30 });
  formField(form, 'Valid for (days)', days, { hint: '0 means no expiry' });

  const limitIp = formField(form, 'Concurrent IP limit', el('input', { type: 'number', min: '0', value: v.limitIp || 0 }));
  const flowSel = selectOf([{ value: '', label: 'No flow' }, { value: 'xtls-rprx-vision', label: 'xtls-rprx-vision' }], v.flow || '');
  formField(form, 'Flow (VLESS over TCP only)', flowSel);
  const wgPublicKey = formField(form, 'WireGuard peer public key', el('input', { value: v.wgPublicKey || '' }), { full: true });
  const wgAllowedIPs = formField(form, 'WireGuard allowed IPs', el('input', { value: (v.wgAllowedIPs || []).join(',') , placeholder: '10.0.0.2/32' }), { full: true });
  const comment = formField(form, 'Note', el('input', { value: v.comment || '' }), { full: true });

  // only show the WireGuard peer fields when the selected inbound needs them
  const syncProtocol = () => {
    const inb = state.inbounds.find((i) => i.id === inboundSel.value);
    const isWg = inb && inb.protocol === 'wireguard';
    for (const control of [wgPublicKey, wgAllowedIPs]) control.closest('.field').classList.toggle('hidden', !isWg);
  };
  inboundSel.addEventListener('change', syncProtocol);
  syncProtocol();

  modal({
    title: existing ? 'Edit client' : 'New client',
    body: form,
    width: 640,
    actions: [{
      label: 'Save',
      kind: 'primary',
      onClick: async (close) => {
        const dayCount = Number(days.value);
        const payload = {
          email: email.value.trim(),
          inboundId: inboundSel.value,
          uuid: uuid.value.trim() || undefined,
          password: password.value.trim() || undefined,
          totalGB: Number(totalGB.value),
          expiryTime: dayCount > 0 ? Date.now() + dayCount * 86400000 : 0,
          limitIp: Number(limitIp.value),
          flow: flowSel.value,
          wgPublicKey: wgPublicKey.value.trim(),
          wgAllowedIPs: wgAllowedIPs.value,
          comment: comment.value
        };
        try {
          if (existing) await api.put(`/clients/${existing.id}`, payload);
          else await api.post('/clients', payload);
          close();
          toast('Client saved');
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      }
    }]
  });
}

/* ----------------------------- page: outbounds --------------------------- */

async function renderOutbounds(view) {
  const wrap = tableShell(view, {
    intro: 'Where traffic leaves the server. "direct" and "blocked" are always available.',
    addLabel: 'New outbound',
    onAdd: () => outboundForm(null)
  });

  await loadProtocols();
  state.outbounds = await api.get('/outbounds');
  state.settings = await api.get('/settings');

  if (!state.outbounds.length) {
    return emptyState(wrap, 'No custom outbounds. Traffic leaves directly through the server.');
  }

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>Tag</th><th>Protocol</th><th>Server</th><th>Transport</th><th>Status</th><th></th>
  </tr></thead>`;
  const tbody = el('tbody');

  for (const out of state.outbounds) {
    const isDefault = (state.settings.defaultOutbound || 'direct') === out.tag;
    tbody.append(el('tr', {}, [
      el('td', {}, [
        el('strong', { text: out.tag }),
        isDefault ? el('div', { class: 'faint', style: 'font-size:11px', text: 'default route' }) : null
      ]),
      el('td', {}, [el('span', { class: 'chip brand', text: out.protocol })]),
      el('td', { class: 'mono', text: out.address ? `${out.address}:${out.port}` : '—' }),
      el('td', { class: 'muted', text: `${out.network || 'tcp'}${out.security && out.security !== 'none' ? ` · ${out.security}` : ''}` }),
      el('td', {}, [el('span', {
        class: `chip ${out.enable === false ? '' : 'ok'}`,
        html: `<i></i>${out.enable === false ? 'Disabled' : 'Enabled'}`
      })]),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn icon ghost', title: 'Edit', html: icon('edit'), onclick: () => outboundForm(out) }),
        el('button', {
          class: 'btn icon ghost', title: 'Enable / disable', html: icon('power'),
          onclick: async () => { await api.post(`/outbounds/${out.id}/toggle`); render(); }
        }),
        el('button', {
          class: 'btn icon danger', title: 'Delete', html: icon('trash'),
          onclick: () => confirmDialog(`Delete outbound "${out.tag}"?`, async () => {
            try {
              await api.del(`/outbounds/${out.id}`);
              toast('Outbound deleted');
              render();
            } catch (err) { toast(err.message, 'err'); }
          })
        })
      ])])
    ]));
  }
  table.append(tbody);
  mountTable(wrap, table);
}

function outboundForm(existing) {
  const v = existing || {};
  const form = el('div', { class: 'form-grid' });
  const protocols = (state.protocols && state.protocols.outbound) || ['freedom'];

  const input = (label, value, opts = {}) => {
    const control = opts.options
      ? selectOf(opts.options, value)
      : el('input', { type: opts.type || 'text', value: value ?? '', placeholder: opts.placeholder || '' });
    return formField(form, label, control, opts);
  };

  const tag = input('Tag', v.tag || 'proxy', { hint: 'Referenced by routing rules' });
  const protocol = input('Protocol', v.protocol || 'freedom', {
    options: protocols.map((p) => ({ value: p, label: PROTOCOL_LABELS[p] || p }))
  });
  const address = input('Server address', v.address || '');
  const port = input('Server port', v.port || 443, { type: 'number' });
  const uuid = input('UUID', v.uuid || '', { full: true });
  const username = input('Username', v.username || '');
  const password = input('Password', v.password || '');
  const method = input('Cipher', v.method || 'aes-256-gcm', {
    options: ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm']
  });
  const flow = input('Flow', v.flow || '', { options: [{ value: '', label: 'No flow' }, { value: 'xtls-rprx-vision', label: 'xtls-rprx-vision' }] });
  const network = input('Transport', v.network || 'tcp', {
    options: [
      { value: 'tcp', label: 'TCP' }, { value: 'ws', label: 'WebSocket' },
      { value: 'grpc', label: 'gRPC' }, { value: 'httpupgrade', label: 'HTTPUpgrade' }
    ]
  });
  const security = input('Security', v.security || 'none', {
    options: [{ value: 'none', label: 'None' }, { value: 'tls', label: 'TLS' }]
  });
  const wsPath = input('Path', v.wsPath || '/');
  const wsHost = input('Host header', v.wsHost || '');
  const grpcService = input('gRPC service name', v.grpcServiceName || '');
  const sni = input('SNI', v.sni || '');
  const domainStrategy = input('Domain strategy', v.domainStrategy || 'AsIs', {
    options: ['AsIs', 'UseIP', 'UseIPv4', 'UseIPv6']
  });
  const blackholeResponse = input('Blackhole response', v.blackholeResponse || 'none', {
    options: ['none', 'http']
  });
  const wgPrivateKey = input('WireGuard private key', v.wgPrivateKey || '', { full: true });
  const wgPeerPublicKey = input('Peer public key', v.wgPeerPublicKey || '', { full: true });
  const wgAddress = input('Local addresses', (v.wgAddress || ['10.0.0.2/32']).join(','), { full: true });
  const wgMtu = input('MTU', v.wgMtu || 1420, { type: 'number' });

  const fieldOf = (control) => control.closest('.field');
  const show = (nodes, on) => nodes.forEach((n) => n.classList.toggle('hidden', !on));
  const groups = {
    server: [fieldOf(address), fieldOf(port)],
    uuid: [fieldOf(uuid)],
    userpass: [fieldOf(username), fieldOf(password)],
    passwordOnly: [fieldOf(password)],
    ss: [fieldOf(method)],
    flow: [fieldOf(flow)],
    stream: [fieldOf(network), fieldOf(security)],
    ws: [fieldOf(wsPath), fieldOf(wsHost)],
    grpc: [fieldOf(grpcService)],
    tls: [fieldOf(sni)],
    freedom: [fieldOf(domainStrategy)],
    blackhole: [fieldOf(blackholeResponse)],
    wg: [fieldOf(wgPrivateKey), fieldOf(wgPeerPublicKey), fieldOf(wgAddress), fieldOf(wgMtu)]
  };

  const sync = () => {
    const p = protocol.value;
    const proxyLike = ['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http'].includes(p);
    const net = network.value;

    show(groups.server, proxyLike || p === 'wireguard');
    show(groups.uuid, p === 'vless' || p === 'vmess');
    show(groups.userpass, p === 'socks' || p === 'http');
    show(groups.passwordOnly, p === 'trojan' || p === 'shadowsocks' || p === 'socks' || p === 'http');
    show(groups.ss, p === 'shadowsocks');
    show(groups.flow, p === 'vless');
    show(groups.stream, proxyLike);
    show(groups.ws, proxyLike && (net === 'ws' || net === 'httpupgrade'));
    show(groups.grpc, proxyLike && net === 'grpc');
    show(groups.tls, proxyLike && security.value === 'tls');
    show(groups.freedom, p === 'freedom');
    show(groups.blackhole, p === 'blackhole');
    show(groups.wg, p === 'wireguard');
  };
  [protocol, network, security].forEach((c) => c.addEventListener('change', sync));
  sync();

  modal({
    title: existing ? 'Edit outbound' : 'New outbound',
    subtitle: 'Outbounds are selected by routing rules, by tag.',
    body: form,
    width: 680,
    actions: [{
      label: existing ? 'Save changes' : 'Create outbound',
      kind: 'primary',
      onClick: async (close) => {
        const payload = {
          tag: tag.value.trim(),
          protocol: protocol.value,
          address: address.value.trim(),
          port: Number(port.value),
          uuid: uuid.value.trim(),
          username: username.value.trim(),
          password: password.value,
          method: method.value,
          flow: flow.value,
          network: network.value,
          security: security.value,
          wsPath: wsPath.value,
          wsHost: wsHost.value,
          grpcServiceName: grpcService.value,
          sni: sni.value,
          domainStrategy: domainStrategy.value,
          blackholeResponse: blackholeResponse.value,
          wgPrivateKey: wgPrivateKey.value.trim(),
          wgPeerPublicKey: wgPeerPublicKey.value.trim(),
          wgAddress: wgAddress.value,
          wgMtu: Number(wgMtu.value)
        };
        try {
          if (existing) await api.put(`/outbounds/${existing.id}`, payload);
          else await api.post('/outbounds', payload);
          close();
          toast('Outbound saved');
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      }
    }]
  });
}

/* ------------------------------ page: routing ---------------------------- */

async function renderRouting(view) {
  const wrap = tableShell(view, {
    intro: 'Rules are evaluated top to bottom; the first match decides the outbound.',
    addLabel: 'New rule',
    onAdd: () => routingForm(null)
  });

  const data = await api.get('/routing');
  state.routing = data.rules;

  // default route / domain strategy sit above the rule list
  const defaultSel = selectOf(data.outboundTags, data.defaultOutbound);
  const strategySel = selectOf(['AsIs', 'IPIfNonMatch', 'IPOnDemand'], data.domainStrategy);
  const controls = el('div', { class: 'card' }, [
    el('div', { class: 'form-grid' }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Default outbound' }), defaultSel,
        el('div', { class: 'hint', text: 'Used when no rule matches' })
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Domain strategy' }), strategySel,
        el('div', { class: 'hint', text: 'How domains are resolved before matching IP rules' })
      ])
    ]),
    el('button', {
      class: 'btn primary', text: 'Save routing options',
      onclick: async () => {
        try {
          await api.put('/settings', { defaultOutbound: defaultSel.value, domainStrategy: strategySel.value });
          toast('Routing options saved');
          render();
        } catch (err) { toast(err.message, 'err'); }
      }
    })
  ]);
  view.insertBefore(controls, wrap);
  view.insertBefore(el('div', { class: 'section-title', text: 'Rules' }), wrap);

  if (!state.routing.length) {
    return emptyState(wrap, 'No routing rules. Everything follows the default outbound.');
  }

  const move = async (index, delta) => {
    const order = state.routing.map((r) => r.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    try {
      await api.post('/routing/reorder', { order });
      render();
    } catch (err) { toast(err.message, 'err'); }
  };

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>#</th><th>Name</th><th>Match</th><th>Outbound</th><th>Status</th><th></th>
  </tr></thead>`;
  const tbody = el('tbody');

  state.routing.forEach((rule, index) => {
    const conditions = [
      rule.domain && `domain: ${rule.domain}`,
      rule.ip && `ip: ${rule.ip}`,
      rule.port && `port: ${rule.port}`,
      rule.source && `source: ${rule.source}`,
      rule.network && `network: ${rule.network}`,
      rule.protocol && `protocol: ${rule.protocol}`,
      rule.inboundTag && `inbound: ${rule.inboundTag}`,
      rule.user && `user: ${rule.user}`
    ].filter(Boolean);

    tbody.append(el('tr', {}, [
      el('td', { class: 'muted mono', text: String(index + 1) }),
      el('td', {}, [el('strong', { text: rule.name })]),
      el('td', { class: 'muted', style: 'max-width:320px' }, [
        el('div', { class: 'mono', style: 'white-space:normal', text: conditions.join('  ·  ') })
      ]),
      el('td', {}, [el('span', { class: 'chip brand', text: rule.outboundTag })]),
      el('td', {}, [el('span', {
        class: `chip ${rule.enable === false ? '' : 'ok'}`,
        html: `<i></i>${rule.enable === false ? 'Disabled' : 'Enabled'}`
      })]),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn icon ghost', title: 'Move up', html: icon('up'), onclick: () => move(index, -1) }),
        el('button', { class: 'btn icon ghost', title: 'Move down', html: icon('down'), onclick: () => move(index, 1) }),
        el('button', { class: 'btn icon ghost', title: 'Edit', html: icon('edit'), onclick: () => routingForm(rule, data.outboundTags) }),
        el('button', {
          class: 'btn icon ghost', title: 'Enable / disable', html: icon('power'),
          onclick: async () => { await api.post(`/routing/${rule.id}/toggle`); render(); }
        }),
        el('button', {
          class: 'btn icon danger', title: 'Delete', html: icon('trash'),
          onclick: () => confirmDialog(`Delete rule "${rule.name}"?`, async () => {
            try {
              await api.del(`/routing/${rule.id}`);
              toast('Rule deleted');
              render();
            } catch (err) { toast(err.message, 'err'); }
          })
        })
      ])])
    ]));
  });
  table.append(tbody);
  mountTable(wrap, table);
}

async function routingForm(existing, tags) {
  const v = existing || {};
  const outboundTags = tags || (await api.get('/routing')).outboundTags;
  const form = el('div', { class: 'form-grid' });

  const name = formField(form, 'Rule name', el('input', { value: v.name || 'rule-1' }));
  const outboundTag = formField(form, 'Send matching traffic to', selectOf(outboundTags, v.outboundTag || 'direct'));
  const domain = formField(form, 'Domains', el('input', { value: v.domain || '', placeholder: 'geosite:category-ads-all, example.com' }),
    { full: true, hint: 'Comma separated. Supports geosite:, domain:, full: and regexp: prefixes.' });
  const ip = formField(form, 'IP ranges', el('input', { value: v.ip || '', placeholder: 'geoip:ir, 1.1.1.1/32' }),
    { full: true, hint: 'Comma separated. Supports geoip: prefixes and CIDRs.' });
  const port = formField(form, 'Destination ports', el('input', { value: v.port || '', placeholder: '443 or 1000-2000' }));
  const sourcePort = formField(form, 'Source ports', el('input', { value: v.sourcePort || '' }));
  const network = formField(form, 'Network', selectOf([{ value: '', label: 'Any' }, 'tcp', 'udp', 'tcp,udp'], v.network || ''));
  const protocol = formField(form, 'Protocols', el('input', { value: v.protocol || '', placeholder: 'http, tls, bittorrent' }));
  const source = formField(form, 'Source IPs', el('input', { value: v.source || '' }), { full: true });
  const inboundTag = formField(form, 'Inbound tags', el('input', { value: v.inboundTag || '' }), { full: true });
  const user = formField(form, 'Users', el('input', { value: v.user || '' }), { full: true, hint: 'Client emails as shown in the Xray config' });

  modal({
    title: existing ? 'Edit rule' : 'New routing rule',
    subtitle: 'Fill in at least one condition. Empty fields are ignored.',
    body: form,
    width: 680,
    actions: [{
      label: existing ? 'Save changes' : 'Create rule',
      kind: 'primary',
      onClick: async (close) => {
        const payload = {
          name: name.value.trim(),
          outboundTag: outboundTag.value,
          domain: domain.value,
          ip: ip.value,
          port: port.value,
          sourcePort: sourcePort.value,
          network: network.value,
          protocol: protocol.value,
          source: source.value,
          inboundTag: inboundTag.value,
          user: user.value
        };
        try {
          if (existing) await api.put(`/routing/${existing.id}`, payload);
          else await api.post('/routing', payload);
          close();
          toast('Rule saved');
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      }
    }]
  });
}

/* ----------------------------- page: settings ---------------------------- */

async function renderSettings(view) {
  const s = await api.get('/settings');
  state.settings = s;

  const card = el('div', { class: 'card' });
  const grid = el('div', { class: 'form-grid' });
  const inputs = {};

  const add = (key, label, value, opts = {}) => {
    const control = el('input', { type: opts.type || 'text', value: value ?? '', placeholder: opts.placeholder || '' });
    inputs[key] = control;
    grid.append(el('div', { class: `field ${opts.full ? 'full' : ''}` }, [
      el('label', { text: label }), control,
      opts.hint ? el('div', { class: 'hint', text: opts.hint }) : null
    ]));
  };

  add('domain', 'Panel domain', s.domain, { hint: 'Used for share links and TLS' });
  add('webBasePath', 'Secret web path', s.webBasePath || '',
    { hint: 'For example /myPanel. Empty means no secret path. You will be moved to the new URL after saving.' });
  add('panelPort', 'Panel port', s.panelPort, { type: 'number', hint: 'Changing this needs a panel restart (nexv restart)' });
  add('subPort', 'Subscription port', s.subPort, { type: 'number' });
  add('subPath', 'Subscription path', s.subPath);
  add('subTitle', 'Subscription title', s.subTitle || 'NexV');
  add('certFile', 'Default TLS certificate (Xray inbounds)', s.certFile, { full: true, placeholder: '/etc/letsencrypt/live/example.com/fullchain.pem' });
  add('keyFile', 'Default TLS private key (Xray inbounds)', s.keyFile, { full: true, placeholder: '/etc/letsencrypt/live/example.com/privkey.pem' });
  add('panelCertFile', 'Panel TLS certificate', s.panelCertFile, {
    full: true,
    placeholder: 'leave empty to reuse the certificate above',
    hint: 'Set this to serve the panel itself over HTTPS. Restart the panel afterwards (nexv restart).'
  });
  add('panelKeyFile', 'Panel TLS private key', s.panelKeyFile, {
    full: true, placeholder: 'leave empty to reuse the key above'
  });

  const logLevel = selectOf(['none', 'error', 'warning', 'info', 'debug'], s.xrayLogLevel || 'warning');
  grid.append(el('div', { class: 'field' }, [el('label', { text: 'Xray log level' }), logLevel]));

  const torrent = el('input', { type: 'checkbox' });
  torrent.checked = !!s.blockTorrent;
  grid.append(el('div', { class: 'field' }, [
    el('label', { text: 'BitTorrent' }),
    el('label', { class: 'switch' }, [torrent, el('span', { class: 'track' }), el('span', { class: 'muted', text: 'Block torrent traffic' })])
  ]));

  const httpRedirect = el('input', { type: 'checkbox' });
  httpRedirect.checked = !!s.httpRedirect;
  grid.append(el('div', { class: 'field' }, [
    el('label', { text: 'Redirect port 80' }),
    el('label', { class: 'switch' }, [
      httpRedirect, el('span', { class: 'track' }),
      el('span', { class: 'muted', text: 'Answer on port 80 and redirect here' })
    ]),
    el('div', { class: 'hint', text: 'Off by default. Ignored while an inbound uses port 80.' })
  ]));

  card.append(grid, el('div', { class: 'row', style: 'margin-top:8px' }, [
    el('button', {
      class: 'btn primary', text: 'Save settings',
      onclick: async () => {
        const payload = {
          xrayLogLevel: logLevel.value,
          blockTorrent: torrent.checked,
          httpRedirect: httpRedirect.checked
        };
        for (const [key, control] of Object.entries(inputs)) {
          payload[key] = control.type === 'number' ? Number(control.value) : control.value;
        }
        const oldPath = s.webBasePath || '';
        try {
          const result = await api.put('/settings', payload);
          const newPath = result.webBasePath || '';
          if (newPath !== oldPath) {
            // the current page lives under the old path; send the admin to the new one
            const url = `${location.origin}${newPath}/`;
            modal({
              title: 'The panel path changed',
              subtitle: 'Save the new address — the old one stops working.',
              body: el('div', {}, [el('div', { class: 'link-box', text: url })]),
              actions: [{ label: 'Go to the new address', kind: 'primary', onClick: () => { location.href = url; } }]
            });
            return;
          }
          toast(result.restartNeeded
            ? 'Saved — run "nexv restart" on the server to apply the port and TLS changes'
            : 'Settings saved');
        } catch (err) { toast(err.message, 'err'); }
      }
    })
  ]));
  view.append(card);

  view.append(el('div', { class: 'section-title', text: 'Backup' }));
  view.append(el('div', { class: 'card row' }, [
    el('a', { class: 'btn', href: `${BASE}api/backup`, download: '' }, ['Download backup']),
    el('button', {
      class: 'btn', text: 'Restore from file',
      onclick: () => {
        const picker = el('input', { type: 'file', accept: 'application/json', class: 'hidden' });
        picker.addEventListener('change', async () => {
          const file = picker.files[0];
          if (!file) return;
          try {
            await api.post('/restore', JSON.parse(await file.text()));
            toast('Configuration restored');
            render();
          } catch (err) { toast(err.message, 'err'); }
        });
        document.body.append(picker);
        picker.click();
        setTimeout(() => picker.remove(), 60000);
      }
    }),
    el('button', {
      class: 'btn ghost', text: 'View config.json',
      onclick: async () => {
        const cfg = await api.get('/xray/config');
        modal({
          title: 'Current Xray configuration',
          body: el('textarea', { readonly: 'readonly', style: 'min-height:340px' }, [JSON.stringify(cfg, null, 2)]),
          width: 760
        });
      }
    })
  ]));
}

/* ------------------------------- page: logs ------------------------------ */

async function renderLogs(view) {
  const logs = await api.get('/logs');
  if (!logs.length) {
    view.innerHTML = `<div class="card empty">${icon('empty', 42)}<div>Nothing logged yet.</div></div>`;
    return;
  }
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table');
  table.innerHTML = '<thead><tr><th>Time</th><th>Type</th><th>Event</th></tr></thead>';
  const tbody = el('tbody');
  for (const log of logs) {
    tbody.append(el('tr', {}, [
      el('td', { class: 'muted mono', text: fmtDate(log.at) }),
      el('td', {}, [el('span', { class: 'chip', text: log.type })]),
      el('td', { text: log.message })
    ]));
  }
  table.append(tbody);
  mountTable(wrap, table);
  view.append(wrap);
}

/* ------------------------------ page: account ---------------------------- */

async function renderAccount(view) {
  const me = await api.get('/me');
  const form = el('div', { class: 'form-grid' });
  const username = el('input', { value: me.username });
  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', autocomplete: 'new-password' });

  form.append(
    el('div', { class: 'field' }, [el('label', { text: 'Username' }), username]),
    el('div', { class: 'field' }, [el('label', { text: 'Current password' }), current]),
    el('div', { class: 'field full' }, [
      el('label', { text: 'New password' }), next,
      el('div', { class: 'hint', text: 'Leave empty to keep the current password' })
    ])
  );

  view.append(el('div', { class: 'card' }, [
    form,
    el('button', {
      class: 'btn primary', text: 'Save account',
      onclick: async () => {
        try {
          await api.post('/account', {
            username: username.value.trim(),
            password: next.value || undefined,
            currentPassword: current.value
          });
          toast('Account updated — please sign in again');
          setTimeout(() => { location.href = `${BASE}login`; }, 1200);
        } catch (err) { toast(err.message, 'err'); }
      }
    })
  ]));
}

/* ------------------------------ update chip ------------------------------ */

/**
 * Announce a newer panel in the header. Checked once per session and then
 * every six hours; a server that cannot reach GitHub simply never shows it.
 */
async function checkForUpdate() {
  let info;
  try { info = await api.get('/version'); } catch (_) { return; }
  const bar = document.querySelector('.topbar');
  const existing = document.getElementById('updateChip');
  if (existing) existing.remove();
  if (!info.updateAvailable || !bar) return;

  const chip = el('button', {
    id: 'updateChip', class: 'update-chip', type: 'button',
    title: `Version ${info.latest} is available`,
    html: `${icon('sparkle', 15)}<span>Update ${info.latest}</span>`,
    onclick: () => modal({
      title: `Version ${info.latest} is available`,
      subtitle: `This panel is running ${info.current}.`,
      body: el('div', {}, [
        el('p', { class: 'muted', text: 'Update from the server\u2019s terminal. Your inbounds, clients and settings are left alone.' }),
        el('div', { class: 'link-box', text: 'nexv update' }),
        el('div', { class: 'row', style: 'margin-top:12px' }, [
          el('button', { class: 'btn', html: `${icon('copy')} Copy command`, onclick: () => copy('nexv update') })
        ])
      ]),
      width: 460
    })
  });
  bar.insertBefore(chip, document.getElementById('xrayChip'));
}

/* --------------------------------- dock ---------------------------------- */

/** The four pages that earn a permanent spot; the rest live under More. */
const DOCK_PAGES = ['dashboard', 'inbounds', 'clients', 'account'];

const dock = { bar: null, more: null, moreItem: null, moreOpen: false };

/** Wide enough to show every page at once? Then More is not needed. */
const WIDE = () => window.matchMedia('(min-width: 981px)').matches;

function buildDock() {
  const host = el('div', { class: 'dock' });
  const bar = el('div', { class: 'dock-bar glass' });
  bar.append(el('span', { class: 'dock-thumb' }));

  // on a wide screen every page fits in the bar, so nothing is hidden away
  const wide = WIDE();
  const entries = wide ? PAGES : DOCK_PAGES.map((id) => PAGES.find((p) => p.id === id)).filter(Boolean);
  const rest = wide ? [] : PAGES.filter((p) => !DOCK_PAGES.includes(p.id));

  for (const page of entries) {
    bar.append(el('button', {
      class: 'dock-item', type: 'button', 'data-page': page.id,
      html: `${icon(page.icon, 22)}<span>${page.label}</span>`
    }));
  }

  const moreItem = el('button', {
    class: 'dock-solo glass', type: 'button', title: 'More', html: icon('more', 22)
  });

  /* the More sheet is the same bar, stood on end */
  const more = el('div', { class: 'dock-more glass' });
  more.append(el('span', { class: 'dock-thumb' }));

  const rows = [
    ...rest.map((page) => ({ page: page.id, icon: page.icon, label: page.label })),
    {
      icon: 'theme',
      label: 'Toggle theme',
      run: () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light')
    },
    {
      icon: 'logout',
      label: 'Sign out',
      run: async () => {
        try { await api.post('/logout'); } catch (_) { /* sign out locally anyway */ }
        location.href = `${BASE}login`;
      }
    }
  ];
  for (const entry of rows) {
    const row = el('button', {
      class: 'dock-row', type: 'button', 'data-page': entry.page || '',
      html: `${icon(entry.icon, 19)}<span>${entry.label}</span>`
    });
    row.run = entry.run;
    more.append(row);
  }

  host.append(bar);
  if (!wide) host.append(moreItem);
  host.classList.toggle('no-more', wide);
  document.body.append(host, more);
  Object.assign(dock, { bar, more, moreItem, wide });

  moreItem.addEventListener('click', (event) => { event.stopPropagation(); toggleMore(); });
  document.addEventListener('click', (event) => {
    if (dock.moreOpen && !more.contains(event.target) && !moreItem.contains(event.target)) closeMore();
  });

  dock.barLens = liquidLens(bar, '.dock-item', 'x', (item) => {
    closeMore();
    if (item.dataset.page !== state.page) navigate(item.dataset.page);
  });
  dock.moreLens = liquidLens(more, '.dock-row', 'y', (row) => {
    closeMore();
    if (typeof row.run === 'function') return row.run();
    if (row.dataset.page && row.dataset.page !== state.page) navigate(row.dataset.page);
  });

  let wasWide = wide;
  window.addEventListener('resize', () => {
    if (WIDE() !== wasWide) {
      // the set of items changes across the breakpoint, so rebuild rather than
      // leave pages stranded in a More button that is no longer shown
      wasWide = WIDE();
      host.remove();
      more.remove();
      buildDock();
      syncDock(false);
      return;
    }
    syncDock(false);
  });
}

function toggleMore() { dock.moreOpen ? closeMore() : openMore(); }

function openMore() {
  dock.moreOpen = true;
  const solo = dock.moreItem.getBoundingClientRect();
  dock.more.style.right = `${Math.round(window.innerWidth - solo.right)}px`;
  dock.more.style.left = 'auto';
  dock.more.classList.add('open');
  dock.moreItem.classList.add('active');

  // bottom row first, so the sheet unrolls up out of the button
  const rows = Array.from(dock.more.querySelectorAll('.dock-row'));
  rows.forEach((row, i) => { row.style.animationDelay = `${(rows.length - 1 - i) * 18}ms`; });

  requestAnimationFrame(() => dock.moreLens.select(state.page, false));
}

function closeMore() {
  if (!dock.moreOpen) return;
  dock.moreOpen = false;
  dock.more.classList.remove('open');
  dock.moreItem.classList.remove('active');
}

/** Park both capsules on the current page. */
function syncDock(animate = true) {
  if (!dock.barLens) return;
  dock.barLens.select(state.page, animate);
  dock.moreLens.select(state.page, animate);
  if (dock.wide) return;
  const inBar = DOCK_PAGES.includes(state.page);
  dock.moreItem.classList.toggle('active', dock.moreOpen || !inBar);
}

/**
 * The lens that marks the current item and follows a finger.
 *
 * Pressing lifts it out of the bar and widens it past the item, it then trails
 * the finger by a frame or two, stretches along the direction of travel with
 * its speed, and lands with a jelly bounce. Coordinates come from layout
 * offsets, never from rects: the bar's padding and any in-flight transform
 * both throw a rect off.
 */
function liquidLens(container, selector, axis, onPick) {
  const vertical = axis === 'y';
  const thumb = container.querySelector('.dock-thumb');
  const items = () => Array.from(container.querySelectorAll(selector));

  const size = (el2) => (vertical ? el2.offsetHeight : el2.offsetWidth);
  const start = (el2) => (vertical ? el2.offsetTop : el2.offsetLeft);
  const centre = (el2) => start(el2) + size(el2) / 2;

  let activeIdx = -1;
  let pressing = false;
  let dragging = false;
  let pointerId = null;
  let startPos = 0;
  let target = 0;
  let cur = 0;
  let last = 0;
  let lensSize = 0;
  let raf = 0;

  const put = (pos, s) => {
    thumb.style.setProperty(vertical ? '--y' : '--x', `${pos.toFixed(2)}px`);
    if (s != null) thumb.style.setProperty(vertical ? '--h' : '--w', `${s.toFixed(2)}px`);
  };

  const nearest = (pos) => {
    const list = items();
    let best = 0;
    let dist = Infinity;
    list.forEach((item, i) => {
      const d = Math.abs(centre(item) - pos);
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  };

  // the finger's coordinate, expressed in the same origin as offsetLeft/Top
  const toLocal = (event) => {
    const first = items()[0];
    if (!first) return 0;
    const box = first.getBoundingClientRect();
    return vertical
      ? event.clientY - box.top + first.offsetTop
      : event.clientX - box.left + first.offsetLeft;
  };

  function select(pageId, animate = true) {
    const list = items();
    const idx = list.findIndex((item) => item.dataset.page === pageId);
    activeIdx = idx;
    list.forEach((item, i) => item.classList.toggle('active', i === idx));
    if (idx < 0) { thumb.classList.remove('on'); return; }
    if (!animate) thumb.classList.add('dragging');
    put(start(list[idx]), size(list[idx]));
    thumb.classList.add('on');
    if (!animate) requestAnimationFrame(() => thumb.classList.remove('dragging'));
  }

  function frame() {
    // trail the finger instead of snapping to it: this is what reads as liquid
    cur += (target - cur) * 0.32;
    const velocity = cur - last;
    last = cur;
    const stretch = Math.min(0.24, Math.abs(velocity) * 0.018);
    thumb.style.setProperty('--sx', (vertical ? 1 - stretch * 0.55 : 1 + stretch).toFixed(3));
    thumb.style.setProperty('--sy', (vertical ? 1 + stretch : 1 - stretch * 0.55).toFixed(3));
    put(cur);
    const under = nearest(cur + lensSize / 2);
    items().forEach((item, i) => item.classList.toggle('under', i === under));
    if (pressing) raf = requestAnimationFrame(frame);
  }

  container.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const item = event.target.closest(selector);
    if (!item) return;
    const list = items();
    const i = list.indexOf(item);

    pressing = true;
    dragging = false;
    pointerId = event.pointerId;
    try { container.setPointerCapture(event.pointerId); } catch (_) { /* older browsers */ }

    // the lens is wider than the item it sits on, the way iOS draws it
    lensSize = size(item) * (vertical ? 1.12 : 1.32);
    const lensStart = centre(item) - lensSize / 2;
    startPos = vertical ? event.clientY : event.clientX;

    thumb.classList.remove('release', 'dragging');
    if (activeIdx < 0) put(start(item), size(item));
    requestAnimationFrame(() => {
      thumb.classList.add('on', 'lifted');
      put(lensStart, lensSize);
    });
    cur = last = target = lensStart;
    list.forEach((other, k) => other.classList.toggle('under', k === i));
  });

  container.addEventListener('pointermove', (event) => {
    if (!pressing || event.pointerId !== pointerId) return;
    const pos = vertical ? event.clientY : event.clientX;
    if (!dragging && Math.abs(pos - startPos) > 6) {
      dragging = true;
      thumb.classList.add('dragging');
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    }
    if (dragging) {
      const list = items();
      // clamp the lens CENTRE, not its edge: it is wider than an item, so
      // clamping the edge stops it short of the last one
      const min = centre(list[0]);
      const max = centre(list[list.length - 1]);
      target = Math.max(min, Math.min(max, toLocal(event))) - lensSize / 2;
      event.preventDefault();
    }
  });

  function finish(event, cancelled) {
    if (!pressing || (event && event.pointerId !== pointerId)) return;
    pressing = false;
    cancelAnimationFrame(raf);

    const list = items();
    let idx;
    if (dragging) {
      idx = nearest(cur + lensSize / 2);
    } else {
      const under = event && document.elementFromPoint(event.clientX, event.clientY);
      idx = list.indexOf((under && under.closest(selector)) || null);
    }

    list.forEach((item) => item.classList.remove('under'));
    thumb.classList.remove('lifted', 'dragging');
    thumb.style.setProperty('--sx', 1);
    thumb.style.setProperty('--sy', 1);

    if (cancelled || idx < 0) {
      const currentId = list[activeIdx] && list[activeIdx].dataset.page;
      return select(currentId, true);
    }

    const picked = list[idx];
    activeIdx = idx;
    list.forEach((item, i) => item.classList.toggle('active', i === idx));
    put(start(picked), size(picked));
    thumb.classList.add('on');
    // restart the bounce even when the same item is picked twice
    thumb.classList.remove('release');
    void thumb.offsetWidth;
    thumb.classList.add('release');
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) { /* unsupported */ } }

    // let the capsule land before the page changes under it
    const wasDrag = dragging;
    dragging = false;
    setTimeout(() => onPick(picked), wasDrag ? 140 : 90);
  }

  container.addEventListener('pointerup', (event) => finish(event, false));
  container.addEventListener('pointercancel', (event) => finish(event, true));
  container.addEventListener('lostpointercapture', (event) => { if (pressing) finish(event, false); });
  container.addEventListener('contextmenu', (event) => event.preventDefault());

  // keyboard activation never produces a pointer event
  container.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    const item = event.target.closest(selector);
    if (item) onPick(item);
  });

  return { select };
}

/* --------------------------------- boot ---------------------------------- *//* --------------------------------- boot ---------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('nexv-theme', theme);
}

/** Last resort: show what went wrong instead of an empty shell. */
function bootFailure(message) {
  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = '';
  view.append(el('div', { class: 'card' }, [
    el('strong', { text: 'The panel could not start' }),
    el('p', { class: 'muted', text: message }),
    el('button', { class: 'btn primary', text: 'Reload', onclick: () => location.reload() })
  ]));
}

window.addEventListener('error', (event) => {
  if (!document.getElementById('nav').children.length) bootFailure(event.message || 'unexpected script error');
});

function boot() {
  document.getElementById('themeToggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await api.post('/logout'); } catch (_) { /* sign out locally anyway */ }
    location.href = `${BASE}login`;
  });

  document.getElementById('restartXray').addEventListener('click', async function () {
    this.disabled = true;
    await xrayAction('restart');
    this.disabled = false;
  });

  window.addEventListener('hashchange', () => {
    const page = location.hash.slice(1);
    if (page && page !== state.page) navigate(page);
  });

  applyTheme(store.get('nexv-theme') || 'dark');
  hydrateIcons();
  buildDock();
  navigate(location.hash.slice(1) || 'dashboard');
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
  // the bar has just been laid out; park the capsule without a flight
  requestAnimationFrame(() => syncDock(false));
}

try {
  boot();
} catch (err) {
  // the navigation bar and icons are drawn by boot(); without this the page
  // would sit there as an empty shell with no hint of what happened
  bootFailure(err.message);
  throw err;
}
