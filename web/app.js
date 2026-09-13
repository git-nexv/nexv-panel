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
  // a per-second rate is rarely a whole number, and 833.3333333333334 B/s
  // is not something anyone wants to read; rounding first also stops 1023.7
  // printing as "1024 B" instead of tipping over into KB
  if (Math.round(n) < 1024) return `${Math.round(n)} B`;
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
  update: '<path d="M12 3 4.8 10.2l1.4 1.4L11 6.8V17h2V6.8l4.8 4.8 1.4-1.4L12 3ZM5 19h14v2H5v-2Z"/>',
  sun: '<path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2.5a1 1 0 0 1 1 1V22a1 1 0 1 1-2 0v-1.5a1 1 0 0 1 1-1Zm0-18a1 1 0 0 1 1 1V4a1 1 0 1 1-2 0V2.5a1 1 0 0 1 1-1ZM22 11a1 1 0 1 1 0 2h-1.5a1 1 0 1 1 0-2H22ZM3.5 11a1 1 0 1 1 0 2H2a1 1 0 1 1 0-2h1.5Zm15.4 6.5a1 1 0 0 1 1.4 1.4l-1 1a1 1 0 0 1-1.5-1.4l1.1-1Zm-14.9-13a1 1 0 0 1 1.4 0l1 1.1A1 1 0 0 1 5 7L3.9 6a1 1 0 0 1 0-1.4Zm14.9 0a1 1 0 0 1 1.4 1.4L19.3 7a1 1 0 0 1-1.5-1.4l1.1-1.1ZM5 17.5l1 1a1 1 0 0 1-1.4 1.4l-1-1A1 1 0 0 1 5 17.5Z"/>',
  bot: '<path d="M12 2a1 1 0 0 1 1 1v2h3a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4h3V3a1 1 0 0 1 1-1Zm-2.5 9A1.5 1.5 0 1 0 9.5 14a1.5 1.5 0 0 0 0-3Zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM2 10h1.2v5H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Zm19 0a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.2v-5H21Z"/>',
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
  search: '<path d="M10 3a7 7 0 1 1-4.2 12.6l-3.1 3.1-1.4-1.4 3.1-3.1A7 7 0 0 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"/>',
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
  { id: 'bot', label: 'Bot', icon: 'bot' },
  // settings sits at the end of the bar, the way a settings key usually does
  { id: 'settings', label: 'Settings', icon: 'settings' }
];

const state = {
  page: 'dashboard',
  inbounds: [], clients: [], outbounds: [], routing: [], settings: {},
  protocols: null, timer: null, version: null
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
    bot: renderBot
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

/*
 * A stat card built once and then written to. The dashboard refreshes every
 * eight seconds and used to rebuild all ten cards each time, which reflowed
 * the page under the reader's cursor; now only the text that changed moves.
 */
function statCard(label, withBar) {
  const value = el('div', { class: 'value' });
  const sub = el('div', { class: 'sub' });
  const bar = withBar ? el('div', { class: 'bar', html: '<i></i>' }) : null;
  const node = el('div', { class: 'card stat' }, [
    el('div', { class: 'label', text: label }), value, sub, bar
  ]);
  return {
    node,
    set(nextValue, nextSub, percent, kind) {
      if (value.textContent !== nextValue) value.textContent = nextValue;
      const subText = nextSub || '';
      if (sub.textContent !== subText) sub.textContent = subText;
      if (!bar) return;
      const width = `${Math.min(100, percent || 0)}%`;
      const cls = `bar ${kind || ''}`.trim();
      if (bar.className !== cls) bar.className = cls;
      if (bar.firstChild.style.width !== width) bar.firstChild.style.width = width;
    }
  };
}

async function renderDashboard(view) {
  const grid = el('div', { class: 'grid stats' });
  const info = el('div', { class: 'grid two', style: 'margin-top:16px' });
  view.append(grid, info);

  const stats = {
    cpu: statCard('CPU', true),
    memory: statCard('Memory', true),
    disk: statCard('Disk', true),
    network: statCard('Network'),
    active: statCard('Active clients'),
    inbounds: statCard('Inbounds'),
    traffic: statCard('Total traffic'),
    uptime: statCard('Uptime')
  };
  grid.append(...Object.values(stats).map((card) => card.node));

  const xrayState = el('span', { class: 'chip' });
  const xrayVersion = el('div', { class: 'muted' });
  const restart = el('button', { class: 'btn', html: `${icon('refresh')} Restart` });
  restart.onclick = () => xrayAction('restart', restart);
  const stop = el('button', { class: 'btn', html: `${icon('power')} Stop` });
  stop.onclick = () => xrayAction('stop', stop);
  const start = el('button', { class: 'btn', html: `${icon('power')} Start` });
  start.onclick = () => xrayAction('start', start);

  const serverLines = ['hostname', 'domain', 'load', 'counts', 'clients'].reduce((acc, key) => {
    acc[key] = el('div');
    return acc;
  }, {});

  info.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'between', style: 'margin-bottom:14px' }, [
        el('strong', { text: 'Xray-core' }), xrayState
      ]),
      xrayVersion,
      el('div', { class: 'row', style: 'margin-top:16px' }, [restart, stop, start])
    ]),
    el('div', { class: 'card' }, [
      el('strong', { text: 'Server' }),
      el('div', { class: 'muted', style: 'margin-top:12px;line-height:2' }, Object.values(serverLines))
    ])
  );

  const write = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  const paint = async () => {
    let status;
    try { status = await api.get('/status'); } catch (_) { return; }
    const s = status.system;

    stats.cpu.set(`${s.cpu.percent}%`, `${s.cpu.cores} cores`, s.cpu.percent,
      s.cpu.percent > 85 ? 'danger' : s.cpu.percent > 60 ? 'warn' : '');
    stats.memory.set(`${s.memory.percent}%`, `${bytes(s.memory.used)} of ${bytes(s.memory.total)}`,
      s.memory.percent, s.memory.percent > 85 ? 'danger' : s.memory.percent > 60 ? 'warn' : '');
    stats.disk.set(`${s.disk.percent}%`, `${bytes(s.disk.used)} of ${bytes(s.disk.total)}`,
      s.disk.percent, s.disk.percent > 85 ? 'danger' : '');
    stats.network.set(`${bytes(s.network.speed.rx)}/s \u2193`, `${bytes(s.network.speed.tx)}/s \u2191`);
    stats.active.set(String(status.counts.clientsActive), `of ${status.counts.clients} total`);
    stats.inbounds.set(String(status.counts.inboundsEnabled), `of ${status.counts.inbounds} total`);
    stats.traffic.set(bytes(status.traffic.up + status.traffic.down),
      `${bytes(status.traffic.down)} \u2193 \u00b7 ${bytes(status.traffic.up)} \u2191`);
    stats.uptime.set(duration(s.uptime), s.platform);

    const running = status.xray.running;
    const stateClass = `chip ${running ? 'ok' : 'danger'}`;
    if (xrayState.className !== stateClass) xrayState.className = stateClass;
    const stateHtml = `<i></i>${running ? 'Running' : 'Stopped'}`;
    if (xrayState.innerHTML !== stateHtml) xrayState.innerHTML = stateHtml;
    write(xrayVersion, status.xray.version || 'version unknown');

    write(serverLines.hostname, `Hostname: ${s.hostname}`);
    write(serverLines.domain, `Panel domain: ${status.settings.domain || 'not set'}`);
    write(serverLines.load, `Load average: ${s.loadavg.map((n) => n.toFixed(2)).join(' / ')}`);
    write(serverLines.counts, `Outbounds: ${status.counts.outbounds} \u00b7 Routing rules: ${status.counts.routingRules}`);
    write(serverLines.clients, `Expired: ${status.counts.clientsExpired} \u00b7 Out of quota: ${status.counts.clientsDepleted}`);

    paintXrayChip(status.xray);
  };

  await paint();
  // a hidden tab must not keep polling: it wakes the server for nothing
  state.timer = setInterval(() => { if (!document.hidden) paint(); }, 8000);
}

/** The header chip, from a status payload the caller already has. */
function paintXrayChip(xray) {
  const chip = document.getElementById('xrayChip');
  if (!chip) return;
  const cls = `chip ${xray.running ? 'ok' : 'danger'}`;
  if (chip.className !== cls) chip.className = cls;
  const html = `<i></i><span>Xray ${xray.running ? 'up' : 'down'}</span>`;
  if (chip.innerHTML !== html) chip.innerHTML = html;
  // keep just "Xray x.y.z"; the full build string is too long for the chip
  chip.title = (xray.version || '').split('(')[0].trim() || 'Xray-core';
}

/** Re-read the Xray state for the header, after an action changed it. */
async function refreshXrayChip() {
  try { paintXrayChip((await api.get('/status')).xray); } catch (_) { /* leave the chip as it is */ }
}

const XRAY_DONE = { restart: 'Xray restarted', stop: 'Xray stopped', start: 'Xray started' };

/**
 * Restarting takes a moment and used to give no sign it was working, which
 * read as a dead button: the icon spins while it runs and the header chip is
 * re-read straight afterwards, so the result is visible without a reload.
 */
async function xrayAction(action, button) {
  const mark = button && button.querySelector('svg');
  if (button) button.disabled = true;
  if (mark) mark.classList.add('spin');
  try {
    await api.post(`/xray/${action}`);
    toast(XRAY_DONE[action] || 'Done');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refreshXrayChip();
  if (mark) mark.classList.remove('spin');
  if (button) button.disabled = false;
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

/**
 * Paste an inbound in, as text. The export from this panel and the one 3x-ui
 * produces are the same shape, so either can be pasted here - clients, quotas
 * and subIds included, which is what keeps everyone's subscription working.
 */
function importInboundText() {
  const area = el('textarea', {
    style: 'min-height:260px',
    placeholder: 'Paste the inbound JSON here, clients and all'
  });
  const replace = el('input', { type: 'checkbox' });
  const status = el('div', { class: 'hint', style: 'margin-top:10px' });

  const body = el('div', {}, [
    area,
    el('label', { class: 'switch', style: 'margin-top:12px' }, [
      replace, el('span', { class: 'track' }),
      el('span', { class: 'muted', text: 'Take over clients whose names already exist' })
    ]),
    status
  ]);

  const go = async (close) => {
    const text = area.value.trim();
    if (!text) return toast('Paste the inbound first', 'err');
    status.textContent = 'Importing\u2026';
    try {
      const result = await api.post('/inbounds/import', { text, replace: replace.checked });
      let note = `Imported with ${result.clients} client(s)`;
      if (result.replaced) note += `, ${result.replaced} taken over`;
      toast(note);
      if (result.movedAddress) {
        toast(`This server cannot bind ${result.movedAddress}, so it is the share address now`);
      }
      close();
      render();
    } catch (err) {
      status.textContent = err.message;
      toast(err.message, 'err');
    }
  };

  modal({
    title: 'Import an inbound',
    subtitle: 'From this panel or from 3x-ui.',
    body,
    width: 720,
    actions: [{ label: 'Import', kind: 'primary', onClick: go }]
  });

  // the clipboard is where it almost always comes from
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText()
      .then((text) => { if (!area.value && /"protocol"/.test(text)) area.value = text; })
      .catch(() => { /* the browser said no, so they will paste it themselves */ });
  }
}

async function exportInboundText(inb) {
  let result;
  try { result = await api.get(`/inbounds/${inb.id}/export`); } catch (err) { return toast(err.message, 'err'); }

  const area = el('textarea', { readonly: 'readonly', style: 'min-height:300px' }, [result.panel]);
  const note = el('div', { class: 'hint', style: 'margin-top:10px' });
  const shapes = {
    Panel: {
      text: result.panel,
      hint: 'Exactly what 3x-ui\u2019s own "Export Inbound" prints, field for field. Paste it into this panel, or keep it as your copy of the inbound.'
    },
    API: {
      text: result.api,
      hint: 'The same inbound with settings, streamSettings and sniffing encoded as strings \u2014 the shape 3x-ui\u2019s API needs when you POST an inbound to it.'
    }
  };

  const pick = segmented(
    [{ value: 'Panel', label: 'Panel format' }, { value: 'API', label: 'API format' }],
    'Panel',
    (name) => {
      area.value = shapes[name].text;
      note.textContent = shapes[name].hint;
    }
  );
  note.textContent = shapes.Panel.hint;

  modal({
    title: `Export "${inb.remark}"`,
    subtitle: `${result.clients} client(s) included, with their subIds.`,
    body: el('div', {}, [
      el('div', { class: 'row', style: 'margin-bottom:12px' }, [pick]),
      area,
      note,
      el('div', { class: 'row', style: 'margin-top:12px' }, [
        el('button', { class: 'btn', html: `${icon('copy')} Copy all`, onclick: () => copy(area.value) }),
        el('button', { class: 'btn ghost', text: 'Select all', onclick: () => { area.focus(); area.select(); } })
      ])
    ]),
    width: 760
  });
}

/** Pick who sits on this inbound. Moving nobody's subId, nobody loses a link. */
async function attachClients(inb) {
  let clients;
  try { clients = await api.get('/clients'); } catch (err) { return toast(err.message, 'err'); }
  if (!clients.length) return toast('There are no clients yet');

  const boxes = new Map();
  const list = el('div', { class: 'attach-list' });
  for (const client of clients) {
    const box = el('input', { type: 'checkbox' });
    box.checked = client.inboundId === inb.id;
    boxes.set(client.id, box);
    list.append(el('label', { class: 'attach-row' }, [
      box,
      el('div', {}, [
        el('strong', { text: client.email }),
        el('div', { class: 'faint', style: 'font-size:11px', text: client.inboundId === inb.id ? 'already here' : (client.inboundRemark || 'not attached') })
      ])
    ]));
  }

  const setAll = (on) => { for (const box of boxes.values()) box.checked = on; };
  const body = el('div', {}, [
    el('div', { class: 'row', style: 'margin-bottom:12px' }, [
      el('button', { class: 'btn', text: 'Select all', onclick: () => setAll(true) }),
      el('button', { class: 'btn ghost', text: 'Select none', onclick: () => setAll(false) })
    ]),
    list
  ]);

  modal({
    title: `Clients on "${inb.remark}"`,
    subtitle: 'Ticked clients move here; unticked ones are taken off. Subscription links are unaffected.',
    body,
    width: 560,
    actions: [{
      label: 'Apply',
      kind: 'primary',
      onClick: async (close) => {
        const attach = [];
        const detach = [];
        for (const [id, box] of boxes) {
          const client = clients.find((c) => c.id === id);
          if (box.checked && client.inboundId !== inb.id) attach.push(id);
          if (!box.checked && client.inboundId === inb.id) detach.push(id);
        }
        if (!attach.length && !detach.length) { close(); return toast('Nothing changed'); }
        try {
          if (detach.length) await api.post(`/inbounds/${inb.id}/detach`, { clientIds: detach });
          if (attach.length) await api.post(`/inbounds/${inb.id}/attach`, { clientIds: attach });
          toast(`${attach.length} attached, ${detach.length} detached`);
          close();
          render();
        } catch (err) { toast(err.message, 'err'); }
      }
    }]
  });
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

/**
 * Deleting an inbound asks what should happen to the people on it. Keeping them
 * is the safe answer and stays the default: they keep their quota and their
 * subId, so a replacement inbound can adopt them and nobody's subscription link
 * breaks. Ticking the switch is the admin saying they are done with them too.
 */
function deleteInbound(inb) {
  const count = inb.clientCount || 0;

  const run = async (withClients) => {
    try {
      const result = await api.del(`/inbounds/${inb.id}${withClients ? '?withClients=1' : ''}`);
      toast(result.deleted
        ? `Inbound and ${result.deleted} client(s) deleted`
        : result.detached ? `Inbound deleted - ${result.detached} client(s) kept` : 'Inbound deleted');
      render();
    } catch (err) { toast(err.message, 'err'); }
  };

  if (!count) return confirmDialog(`Delete inbound "${inb.remark}"?`, () => run(false));

  const alsoClients = el('input', { type: 'checkbox' });
  const note = el('div', { class: 'hint', style: 'margin-top:8px' });
  const describe = () => {
    note.textContent = alsoClients.checked
      ? `The ${count} client(s) go with it. Their configs and subscription links stop working.`
      : `The ${count} client(s) are kept and become unattached, so another inbound can take them over.`;
  };
  alsoClients.addEventListener('change', describe);
  describe();

  modal({
    title: 'Please confirm',
    body: el('div', {}, [
      el('p', { class: 'muted', text: `Delete inbound "${inb.remark}"?` }),
      el('label', { class: 'switch', style: 'margin-top:12px' }, [
        alsoClients, el('span', { class: 'track' }),
        el('span', { class: 'muted', text: `Delete its ${count} client(s) as well` })
      ]),
      note
    ]),
    actions: [{
      label: 'Yes, continue',
      kind: 'danger',
      onClick: (close) => { close(); run(alsoClients.checked); }
    }]
  });
}

async function renderInbounds(view) {
  view.append(el('div', { class: 'between', style: 'margin-bottom:16px' }, [
    el('div', { class: 'muted', text: 'Each inbound is one port and one protocol that clients connect to.' }),
    el('div', { class: 'row' }, [
      popupMenu([
        { label: 'Import an inbound', onClick: importInboundText },
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
          { label: 'Export inbound', onClick: () => exportInboundText(inb) },
          { label: 'Export all URLs', onClick: () => showUrls('links', inb.id) },
          { label: 'Export all URLs — subscription', onClick: () => showUrls('sub', inb.id) },
          'sep',
          { label: 'Attach clients…', onClick: () => attachClients(inb) },
          { label: 'Reset traffic', onClick: () => resetTraffic(inb.id, `"${inb.remark}"`) },
          'sep',
          { label: 'Delete', danger: true, onClick: () => deleteInbound(inb) }
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

/*
 * One word for where a client stands, for the chip at the end of its row. Only
 * one can be shown, so the order decides: a client the admin switched off reads
 * as Disabled even when its time also ran out.
 */
function clientState(c) {
  if (c.enable === false) return 'disabled';
  if (c.expired) return 'expired';
  if (c.depleted) return 'depleted';
  return 'active';
}

/*
 * The boxes across the top of the list, each also the filter for what it counts.
 * They deliberately overlap - a client switched off after its time ran out is
 * both disabled and expired - so that the box, the filter and the bulk delete
 * of the same name always cover exactly the same people.
 */
const CLIENT_STATES = [
  { id: 'all', label: 'Total', tone: '', match: () => true },
  { id: 'active', label: 'Active', tone: 'ok', match: (c) => clientState(c) === 'active' },
  { id: 'disabled', label: 'Disabled', tone: 'off', match: (c) => c.enable === false },
  { id: 'expired', label: 'Expired', tone: 'bad', match: (c) => !!c.expired },
  { id: 'depleted', label: 'Out of quota', tone: 'bad', match: (c) => !!c.depleted }
];

/** What each bulk action sweeps up, matching the server's own scopes. */
const PURGE_SCOPES = {
  expired: { one: 'expired client', many: 'expired clients', match: (c) => c.expired },
  depleted: { one: 'client out of quota', many: 'clients out of quota', match: (c) => c.depleted },
  finished: {
    one: 'expired or out-of-quota client', many: 'expired and out-of-quota clients',
    match: (c) => c.expired || c.depleted
  },
  disabled: { one: 'disabled client', many: 'disabled clients', match: (c) => c.enable === false },
  all: { one: 'client', many: 'clients', match: () => true }
};

/** The chip at the end of a row, one per state clientState can return. */
const CLIENT_CHIPS = {
  disabled: { class: 'chip', label: 'Disabled' },
  expired: { class: 'chip danger', label: 'Expired' },
  depleted: { class: 'chip danger', label: 'Out of quota' },
  active: { class: 'chip ok', label: 'Active' }
};

/**
 * Delete everyone a scope matches, after saying out loud how many that is and
 * naming a few of them - "delete all clients" is not a button anybody should be
 * able to press without seeing whose configs are about to stop working.
 */
function purgeClients(scope) {
  const spec = PURGE_SCOPES[scope];
  const doomed = (state.clients || []).filter(spec.match);
  if (!doomed.length) return toast(`No ${spec.many} to delete`);
  const label = doomed.length === 1 ? spec.one : spec.many;

  const names = doomed.map((c) => c.email);
  const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? `, and ${names.length - 6} more` : '');

  modal({
    title: 'Please confirm',
    body: el('div', {}, [
      el('p', { class: 'muted', text: `Delete ${doomed.length} ${label}?` }),
      el('div', { class: 'hint', style: 'margin-top:8px', text: shown }),
      el('div', { class: 'hint', style: 'margin-top:8px', text: 'Their configs and subscription links stop working at once. This cannot be undone.' })
    ]),
    actions: [{
      label: `Delete ${doomed.length}`,
      kind: 'danger',
      onClick: async (close) => {
        close();
        try {
          const result = await api.post('/clients/purge', { scope });
          toast(result.deleted ? `Deleted ${result.deleted} client(s)` : 'Nothing matched');
          render();
        } catch (err) { toast(err.message, 'err'); }
      }
    }]
  });
}

async function renderClients(view) {
  view.append(el('div', { class: 'between', style: 'margin-bottom:16px' }, [
    el('div', { class: 'muted', text: 'Clients of each inbound, with their quota and expiry.' }),
    el('div', { class: 'row' }, [
      popupMenu([
        { label: 'Delete expired clients', danger: true, onClick: () => purgeClients('expired') },
        { label: 'Delete clients out of quota', danger: true, onClick: () => purgeClients('depleted') },
        { label: 'Delete expired and out of quota', danger: true, onClick: () => purgeClients('finished') },
        { label: 'Delete disabled clients', danger: true, onClick: () => purgeClients('disabled') },
        'sep',
        { label: 'Delete every client', danger: true, onClick: () => purgeClients('all') }
      ], { class: 'btn ghost', html: icon('menu'), title: 'Client actions' }),
      el('button', { class: 'btn primary', html: `${icon('plus')} New client`, onclick: () => clientForm(null) })
    ])
  ]));

  const stats = el('div', { class: 'stat-strip' });
  const search = el('input', {
    type: 'search', class: 'search-input', placeholder: 'Search clients by name…',
    autocomplete: 'off', spellcheck: 'false'
  });
  const tools = el('div', { class: 'list-tools', hidden: 'hidden' }, [
    stats,
    el('div', { class: 'search-box' }, [el('span', { class: 'search-icon', html: icon('search', 16) }), search])
  ]);
  view.append(tools);

  const wrap = el('div', { class: 'table-wrap' });
  wrap.innerHTML = '<div class="empty"><div class="skeleton" style="height:120px"></div></div>';
  view.append(wrap);

  await loadProtocols();
  const [inbounds, clients] = await Promise.all([api.get('/inbounds'), api.get('/clients')]);
  state.inbounds = inbounds;
  state.clients = clients;

  if (!inbounds.length) return emptyState(wrap, 'Create an inbound first, then add clients to it.');
  if (!clients.length) return emptyState(wrap, 'No clients yet.');

  /* the summary box, and the same boxes double as filters */
  let picked = CLIENT_STATES.some((s) => s.id === state.clientFilter) ? state.clientFilter : 'all';
  const buttons = new Map();
  for (const spec of CLIENT_STATES) {
    const count = clients.filter(spec.match).length;
    if (spec.id !== 'all' && !count) continue;   // no empty boxes to read past
    const button = el('button', {
      type: 'button', class: `stat ${spec.tone}`,
      title: spec.id === 'all' ? 'Show everyone' : `Show only the ${spec.label.toLowerCase()} ones`,
      onclick: () => { picked = picked === spec.id ? 'all' : spec.id; state.clientFilter = picked; applyFilter(); }
    }, [
      el('div', { class: 'stat-num', text: String(count) }),
      el('div', { class: 'stat-label', text: spec.label })
    ]);
    buttons.set(spec.id, button);
    stats.append(button);
  }
  tools.hidden = false;

  const withLinks = (state.protocols && state.protocols.withLinks) || [];
  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>Client</th><th>Inbound</th><th>Now</th><th>Used</th><th>Quota</th>
    <th>Expires</th><th>Status</th><th></th>
  </tr></thead>`;
  const tbody = el('tbody');

  for (const c of clients) {
    const used = (c.up || 0) + (c.down || 0);
    const quota = (c.totalGB || 0) * 1024 ** 3;
    const percent = quota ? (used / quota) * 100 : 0;
    const left = daysLeft(c.expiryTime);
    const shareable = withLinks.includes(c.protocol) && !!c.link;

    const chip = CLIENT_CHIPS[clientState(c)];
    const statusChip = el('span', { class: chip.class, html: `<i></i>${chip.label}` });

    const row = el('tr', {}, [
      el('td', {}, [
        el('strong', { text: c.email }),
        el('div', { class: 'faint mono', style: 'font-size:11px', text: c.protocol })
      ]),
      el('td', { class: 'muted', text: c.inboundRemark }),
      el('td', {}, [liveCell(c)]),
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
        onOffSwitch(c.enable !== false, async (on, revert) => {
          try {
            await api.post(`/clients/${c.id}/toggle`);
            toast(on ? `${c.email} is on` : `${c.email} is off`);
            c.enable = on;
            statusChip.className = `chip ${on ? 'ok' : ''}`;
            statusChip.innerHTML = `<i></i>${on ? 'Active' : 'Disabled'}`;
          } catch (err) {
            revert();
            toast(err.message, 'err');
          }
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
    ]);
    row.dataset.name = c.email.toLowerCase();
    row.dataset.buckets = CLIENT_STATES.filter((spec) => spec.match(c)).map((spec) => spec.id).join(' ');
    tbody.append(row);
  }

  /*
   * Filtering hides rows rather than rebuilding the table: a rebuild on every
   * keystroke would cost a round of link building per client and throw away
   * the scroll position while the admin is still typing.
   */
  const nothing = el('tr', { class: 'filter-empty', hidden: 'hidden' }, [
    el('td', { colspan: '8', class: 'muted', text: 'No client matches that.' })
  ]);

  function applyFilter() {
    const needle = search.value.trim().toLowerCase();
    let shown = 0;
    for (const row of tbody.querySelectorAll('tr[data-name]')) {
      const ok = row.dataset.buckets.split(' ').includes(picked)
        && (!needle || row.dataset.name.includes(needle));
      row.hidden = !ok;
      if (ok) shown++;
    }
    nothing.hidden = shown > 0;
    for (const [id, button] of buttons) button.classList.toggle('on', id === picked);
  }

  search.addEventListener('input', applyFilter);
  table.append(tbody);
  mountTable(wrap, table);
  tbody.append(nothing);   // after mountTable: it is a notice, not a row with columns
  applyFilter();
}


/**
 * The green dot 3x-ui shows, plus what it is actually doing: a client counts as
 * live while it is moving traffic or has opened a connection in the last
 * minute, and the addresses it is connected from sit behind the dot.
 */
function liveCell(client) {
  const speed = (client.speed && (client.speed.up + client.speed.down)) || 0;
  const dot = el('span', { class: `live-dot ${client.online ? 'on' : ''}` });
  const box = el('div', { class: 'live' }, [
    dot,
    el('div', {}, [
      el('div', { class: 'live-rate', text: client.online ? (speed ? `${bytes(speed)}/s` : 'idle') : 'offline' }),
      client.ipCount
        ? el('button', {
          class: 'live-ips', type: 'button',
          text: `${client.ipCount} IP${client.ipCount > 1 ? 's' : ''}`,
          onclick: () => showClientIps(client)
        })
        : null
    ])
  ]);
  return box;
}

/** Where this client is connecting from, and a way to start the list over. */
function showClientIps(client) {
  const limit = Number(client.limitIp || 0);
  const list = el('div', { class: 'attach-list' });
  for (const entry of client.ips) {
    list.append(el('div', { class: 'attach-row' }, [
      el('div', {}, [
        el('strong', { class: 'mono', text: entry.ip }),
        el('div', { class: 'faint', style: 'font-size:11px', text: `last seen ${fmtDate(entry.at)}` })
      ])
    ]));
  }

  modal({
    title: `Addresses for ${client.email}`,
    subtitle: limit
      ? `Allowed at once: ${limit}. Seen in the last five minutes: ${client.ips.length}.`
      : `Seen in the last five minutes: ${client.ips.length}. No IP limit is set on this client.`,
    body: el('div', {}, [
      list,
      el('div', { class: 'hint', style: 'margin-top:10px', text: 'Addresses are read from Xray\u2019s access log and forgotten after five minutes of silence.' })
    ]),
    width: 480,
    actions: [{
      label: 'Forget these',
      onClick: async (close) => {
        try {
          const result = await api.post(`/clients/${client.id}/forget-ips`, {});
          toast(`Forgot ${result.cleared} address(es)`);
          close();
          render();
        } catch (err) { toast(err.message, 'err'); }
      }
    }]
  });
}

/**
 * The header's light/dark switch, reused wherever something is simply on or
 * off. It flips as soon as it is pressed and rolls back if the server refuses,
 * so it never shows a state the panel is not actually in.
 */
function onOffSwitch(on, apply, title) {
  const node = el('button', {
    class: `mini-switch ${on ? 'on' : ''}`, type: 'button', role: 'switch',
    title: title || 'On / off',
    'aria-checked': on ? 'true' : 'false',
    html: '<span class="mini-knob"></span>'
  });
  let state = on;
  const paint = () => {
    node.classList.toggle('on', state);
    node.setAttribute('aria-checked', state ? 'true' : 'false');
  };
  node.addEventListener('click', async () => {
    state = !state;
    paint();
    node.disabled = true;
    await apply(state, () => { state = !state; paint(); });
    node.disabled = false;
  });
  return node;
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

  const trackIps = el('input', { type: 'checkbox' });
  trackIps.checked = s.trackIps !== false;
  grid.append(el('div', { class: 'field' }, [
    el('label', { text: 'Client addresses' }),
    el('label', { class: 'switch' }, [
      trackIps, el('span', { class: 'track' }),
      el('span', { class: 'muted', text: 'Record which IPs each client connects from' })
    ]),
    el('div', { class: 'hint', text: 'Turns on Xray\u2019s access log, which is where the Clients page reads them from.' })
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
          trackIps: trackIps.checked,
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
    el('button', {
      class: 'btn primary', text: 'Show backup as text',
      onclick: async () => {
        try {
          const dump = await api.get('/backup');
          textDialog(
            'Panel backup',
            'Everything: inbounds, clients, outbounds, routing, settings and the bot. Keep it somewhere safe.',
            JSON.stringify(dump, null, 2)
          );
        } catch (err) { toast(err.message, 'err'); }
      }
    }),
    el('button', {
      class: 'btn', text: 'Restore from text',
      onclick: () => {
        const area = el('textarea', { style: 'min-height:260px', placeholder: 'Paste a panel backup here' });
        modal({
          title: 'Restore the panel',
          subtitle: 'This replaces the inbounds, clients, outbounds and routing you have now.',
          body: area,
          width: 720,
          actions: [{
            label: 'Restore',
            kind: 'danger',
            onClick: async (close) => {
              let parsed;
              try { parsed = JSON.parse(area.value); } catch (_) { return toast('That is not valid JSON', 'err'); }
              try {
                await api.post('/restore', parsed);
                toast('Configuration restored');
                close();
                render();
              } catch (err) { toast(err.message, 'err'); }
            }
          }]
        });
      }
    }),
    el('a', { class: 'btn ghost', href: `${BASE}api/backup`, download: '' }, ['Download as a file']),
    el('button', {
      class: 'btn ghost', text: 'Restore from a file',
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

  view.append(el('div', { class: 'section-title', text: 'Account' }));
  await renderAccount(view);

  view.append(el('div', { class: 'section-title', text: 'Event log' }));
  await renderLogs(view);
}

/* -------------------------------- page: bot ------------------------------ */

const BOT_ACTIONS = [
  { value: 'screen', label: 'Open a screen' },
  { value: 'plans', label: 'Show the plans' },
  { value: 'configs', label: 'Send their configs' },
  { value: 'usage', label: 'Show their usage' },
  { value: 'support', label: 'Support screen' },
  { value: 'url', label: 'Open a link' },
  { value: 'text', label: 'Show a message' }
];

/** What the user will actually see in Telegram, drawn from a screen. */
function botPreview(screen, brand) {
  const body = String(screen.text || '')
    .replace(/{name}/g, 'Ali')
    .replace(/{brand}/g, brand || 'NexV')
    .replace(/{admin}/g, '@admin');
  const bubble = el('div', { class: 'tg-bubble' });
  // the bot sends HTML, so show it as the user would read it
  bubble.innerHTML = body
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)(b|i|code|u|s)&gt;/g, '<$1$2>')
    .replace(/\n/g, '<br>');
  const keys = el('div', { class: 'tg-keys' });
  for (const row of (screen.buttons || [])) {
    const line = el('div', { class: 'tg-row' });
    for (const btn of row) line.append(el('span', { class: 'tg-key', text: btn.label }));
    if (line.children.length) keys.append(line);
  }
  return el('div', { class: 'tg-preview' }, [bubble, keys]);
}

/** One screen's editor: its text, and rows of inline buttons under it. */
function botScreenCard(screen, ctx) {
  const card = el('div', { class: 'card bot-screen' });
  const redraw = () => { ctx.refresh(); };

  const key = el('input', { value: screen.key || '', placeholder: 'start' });
  key.addEventListener('input', () => { screen.key = key.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); });
  const title = el('input', { value: screen.title || '', placeholder: 'Welcome' });
  title.addEventListener('input', () => { screen.title = title.value; });
  const text = el('textarea', { style: 'min-height:110px' }, [screen.text || '']);
  text.addEventListener('input', () => { screen.text = text.value; ctx.preview(); });

  const grid = el('div', { class: 'form-grid' });
  formField(grid, 'Screen key', key, { hint: 'start is the first screen' });
  formField(grid, 'Title', title);
  formField(grid, 'Message', text, { full: true, hint: 'Placeholders: {name} {brand} {admin} · HTML: <b> <i> <code>' });

  const rows = el('div', { class: 'bot-rows' });
  const drawRows = () => {
    rows.innerHTML = '';
    screen.buttons = screen.buttons || [];
    screen.buttons.forEach((row, rowIndex) => {
      const line = el('div', { class: 'bot-row' });
      row.forEach((btn, btnIndex) => {
        const label = el('input', { value: btn.label || '', placeholder: 'Button text' });
        label.addEventListener('input', () => { btn.label = label.value; ctx.preview(); });
        const action = selectOf(BOT_ACTIONS, btn.action || 'screen');
        const value = el('input', {
          value: btn.value || '',
          placeholder: btn.action === 'url' ? 'https://…' : 'screen key'
        });
        const needsValue = () => ['screen', 'url', 'text'].includes(action.value);
        value.hidden = !needsValue();
        action.addEventListener('change', () => {
          btn.action = action.value;
          value.hidden = !needsValue();
          value.placeholder = action.value === 'url' ? 'https://…' : action.value === 'text' ? 'message' : 'screen key';
          ctx.preview();
        });
        value.addEventListener('input', () => { btn.value = value.value; });
        line.append(el('div', { class: 'bot-btn' }, [
          label, action, value,
          el('button', {
            class: 'btn icon danger', title: 'Remove button', html: icon('trash'),
            onclick: () => { row.splice(btnIndex, 1); if (!row.length) screen.buttons.splice(rowIndex, 1); drawRows(); ctx.preview(); }
          })
        ]));
      });
      if (row.length < 2) {
        line.append(el('button', {
          class: 'btn ghost', text: '+ side by side',
          onclick: () => { row.push({ label: 'Button', action: 'screen', value: 'start' }); drawRows(); ctx.preview(); }
        }));
      }
      rows.append(line);
    });
    rows.append(el('button', {
      class: 'btn', html: `${icon('plus')} Add a button row`,
      onclick: () => { screen.buttons.push([{ label: 'Button', action: 'screen', value: 'start' }]); drawRows(); ctx.preview(); }
    }));
    hydrateIcons(rows);
  };
  drawRows();

  card.append(
    el('div', { class: 'between', style: 'margin-bottom:12px' }, [
      el('strong', { text: screen.title || screen.key || 'Screen' }),
      el('button', {
        class: 'btn icon danger', title: 'Delete this screen', html: icon('trash'),
        onclick: () => { ctx.remove(screen); redraw(); }
      })
    ]),
    grid,
    el('div', { class: 'section-title', text: 'Inline buttons' }),
    rows
  );
  hydrateIcons(card);
  return card;
}

async function renderBot(view) {
  const data = await api.get('/bot');
  const inbounds = await api.get('/inbounds');
  const draft = {
    brand: data.brand,
    currency: data.currency,
    adminId: data.adminId,
    screens: JSON.parse(JSON.stringify(data.screens || [])),
    plans: JSON.parse(JSON.stringify(data.plans || [])),
    pay: JSON.parse(JSON.stringify(data.pay || { card: {}, crypto: { wallets: [] } })),
    channel: JSON.parse(JSON.stringify(data.channel || { enable: false, id: '', link: '', text: '' }))
  };

  const { wrap, panels } = tabbed(['Setup', 'Screens', 'Plans', 'Payment', 'Channel', 'Orders', 'AI']);
  for (const panel of Object.values(panels)) panel.className = 'tab-panel';
  view.append(wrap);

  const save = async (extra) => {
    const payload = Object.assign({
      brand: draft.brand, currency: draft.currency, adminId: draft.adminId,
      screens: draft.screens, plans: draft.plans, pay: draft.pay, channel: draft.channel
    }, extra || {});
    try {
      await api.put('/bot', payload);
      toast('Bot saved');
    } catch (err) { toast(err.message, 'err'); }
  };

  /* ---- Setup ---- */
  const statusChip = el('span', { class: 'chip' });
  const paintStatus = (status) => {
    statusChip.className = `chip ${status.running ? 'ok' : ''}`;
    statusChip.innerHTML = `<i></i>${status.running
      ? `Running${status.username ? ` as @${status.username}` : ''}`
      : 'Stopped'}`;
  };
  paintStatus(data.status);

  const token = el('input', { type: 'password', placeholder: data.hasToken ? data.tokenHint : '123456:ABC-DEF…' });
  const admin = el('input', { value: data.adminId || '', placeholder: '123456789 or @username' });
  admin.addEventListener('input', () => { draft.adminId = admin.value.trim(); });
  const brand = el('input', { value: data.brand || 'NexV' });
  brand.addEventListener('input', () => { draft.brand = brand.value; });
  const currency = el('input', { value: data.currency || 'Toman' });
  currency.addEventListener('input', () => { draft.currency = currency.value; });

  const setupGrid = el('div', { class: 'form-grid' });
  formField(setupGrid, 'Bot token from @BotFather', token, {
    full: true,
    hint: data.hasToken ? `A token is saved (${data.tokenHint}). Type a new one to replace it.` : 'Talk to @BotFather, send /newbot, and paste the token here.'
  });
  formField(setupGrid, 'Admin', admin, {
    hint: 'Numeric id or @username. Send /id to your bot to learn your id.'
  });
  formField(setupGrid, 'Brand name', brand, { hint: 'Used wherever {brand} appears' });
  formField(setupGrid, 'Currency', currency);

  const startBtn = el('button', {
    class: 'btn primary', html: `${icon('power')} ${data.status.running ? 'Stop the bot' : 'Start the bot'}`,
    onclick: async () => {
      startBtn.disabled = true;
      try {
        const running = startBtn.textContent.includes('Stop');
        const status = await api.post(running ? '/bot/stop' : '/bot/start', {});
        paintStatus(status);
        startBtn.innerHTML = `${icon('power')} ${status.running ? 'Stop the bot' : 'Start the bot'}`;
        hydrateIcons(startBtn);
        toast(status.running ? 'The bot is listening' : 'The bot is stopped');
      } catch (err) { toast(err.message, 'err'); }
      startBtn.disabled = false;
    }
  });

  panels.Setup.append(el('div', { class: 'card' }, [
    el('div', { class: 'between', style: 'margin-bottom:14px' }, [
      el('strong', { text: 'Connection' }), statusChip
    ]),
    setupGrid,
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('button', {
        class: 'btn primary', text: 'Save',
        onclick: () => save(token.value.trim() ? { token: token.value.trim() } : null)
      }),
      el('button', {
        class: 'btn', text: 'Test the token',
        onclick: async () => {
          try {
            const me = await api.post('/bot/test', token.value.trim() ? { token: token.value.trim() } : {});
            toast(`Token belongs to @${me.username}`);
          } catch (err) { toast(err.message, 'err'); }
        }
      }),
      startBtn,
      el('button', {
        class: 'btn ghost', text: 'Send me a test message',
        onclick: async () => {
          try { await api.post('/bot/ping', {}); toast('Sent'); } catch (err) { toast(err.message, 'err'); }
        }
      })
    ]),
    el('div', { class: 'hint', style: 'margin-top:12px', text: data.adminLinked
      ? 'The admin chat is linked, so orders and alerts can reach you.'
      : 'Send /start to your bot from the admin account once, so the panel learns where to send orders.' })
  ]));

  /* ---- Screens ---- */
  const list = el('div', { class: 'bot-list' });
  const preview = el('div', { class: 'card bot-preview-card' });
  const drawPreview = () => {
    preview.innerHTML = '';
    preview.append(el('strong', { text: 'Preview' }));
    for (const screen of draft.screens) {
      preview.append(el('div', { class: 'muted', style: 'margin:12px 0 4px', text: `/${screen.key}` }));
      preview.append(botPreview(screen, draft.brand));
    }
  };
  const drawScreens = () => {
    list.innerHTML = '';
    const ctx = {
      refresh: drawScreens,
      preview: drawPreview,
      remove: (screen) => { draft.screens = draft.screens.filter((s) => s !== screen); }
    };
    for (const screen of draft.screens) list.append(botScreenCard(screen, ctx));
    list.append(el('button', {
      class: 'btn', html: `${icon('plus')} Add a screen`,
      onclick: () => {
        draft.screens.push({ key: `screen${draft.screens.length + 1}`, title: 'New screen', text: 'Your message here.', buttons: [[{ label: '⬅️ Back', action: 'screen', value: 'start' }]] });
        drawScreens(); drawPreview();
      }
    }));
    hydrateIcons(list);
    drawPreview();
  };
  drawScreens();
  panels.Screens.append(
    el('div', { class: 'row', style: 'margin-bottom:14px' }, [
      el('button', { class: 'btn primary', text: 'Save the bot', onclick: () => save() }),
      el('button', {
        class: 'btn ghost', text: 'Load the Persian starter',
        onclick: () => confirmDialog('Replace every screen with the Persian starter?', async () => {
          try {
            const result = await api.post('/bot/reset-screens', {});
            draft.screens = result.screens;
            drawScreens();
            toast('Starter loaded');
          } catch (err) { toast(err.message, 'err'); }
        })
      })
    ]),
    el('div', { class: 'bot-split' }, [list, preview])
  );

  /* ---- Plans ---- */
  const plansBox = el('div');
  const drawPlans = () => {
    plansBox.innerHTML = '';
    draft.plans.forEach((plan, index) => {
      const grid = el('div', { class: 'form-grid' });
      const bind = (field, control, cast) => {
        control.addEventListener('input', () => { plan[field] = cast ? cast(control.value) : control.value; });
        return control;
      };
      formField(grid, 'Name', bind('name', el('input', { value: plan.name || '' })));
      formField(grid, 'Price', bind('price', el('input', { value: plan.price || '' })));
      formField(grid, 'Quota (GB)', bind('gb', el('input', { type: 'number', min: '0', value: plan.gb || 0 }), Number), { hint: '0 means unlimited' });
      formField(grid, 'Days', bind('days', el('input', { type: 'number', min: '1', value: plan.days || 30 }), Number));
      const inbound = selectOf(inbounds.map((i) => ({ value: i.id, label: `${i.remark} (${i.protocol}:${i.port})` })), plan.inboundId);
      inbound.addEventListener('change', () => { plan.inboundId = inbound.value; });
      formField(grid, 'Sold from inbound', inbound, { full: true, hint: 'The client is created on this inbound when you approve an order' });
      plansBox.append(el('div', { class: 'card' }, [
        el('div', { class: 'between', style: 'margin-bottom:12px' }, [
          el('strong', { text: plan.name || 'Plan' }),
          el('button', {
            class: 'btn icon danger', title: 'Remove', html: icon('trash'),
            onclick: () => { draft.plans.splice(index, 1); drawPlans(); }
          })
        ]),
        grid
      ]));
    });
    plansBox.append(el('div', { class: 'row' }, [
      el('button', {
        class: 'btn', html: `${icon('plus')} Add a plan`,
        onclick: () => {
          draft.plans.push({ name: 'New plan', gb: 30, days: 30, price: '0', inboundId: inbounds[0] ? inbounds[0].id : '', enable: true });
          drawPlans();
        }
      }),
      el('button', { class: 'btn primary', text: 'Save plans', onclick: () => save() })
    ]));
    hydrateIcons(plansBox);
  };
  drawPlans();
  panels.Plans.append(plansBox);

  /* ---- Payment ---- */
  const payBox = el('div');
  const drawPay = () => {
    payBox.innerHTML = '';
    const card = draft.pay.card = draft.pay.card || {};
    const crypto = draft.pay.crypto = draft.pay.crypto || {};
    crypto.wallets = crypto.wallets || [];

    const bind = (obj, field, control, cast) => {
      control.addEventListener('input', () => { obj[field] = cast ? cast(control.value) : control.value; });
      return control;
    };
    const toggleOf = (obj, label) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = obj.enable !== false;
      box.addEventListener('change', () => { obj.enable = box.checked; });
      return el('label', { class: 'switch' }, [box, el('span', { class: 'track' }), el('span', { class: 'muted', text: label })]);
    };

    /* card to card */
    const cardGrid = el('div', { class: 'form-grid' });
    formField(cardGrid, 'Card number', bind(card, 'number', el('input', { value: card.number || '', placeholder: '6037 9975 0000 0000' })), {
      hint: 'Shown to the buyer as a copyable line'
    });
    formField(cardGrid, 'Card holder', bind(card, 'holder', el('input', { value: card.holder || '', placeholder: 'نام و نام خانوادگی' })));
    formField(cardGrid, 'Extra note', bind(card, 'note', el('input', { value: card.note || '', placeholder: 'optional line shown under the card' })), { full: true });

    payBox.append(el('div', { class: 'card' }, [
      el('div', { class: 'between', style: 'margin-bottom:12px' }, [
        el('strong', { text: '💳 Card to card' }), toggleOf(card, 'Offer this method')
      ]),
      cardGrid,
      el('div', { class: 'hint', text: 'After showing these, the bot asks the buyer for a photo of the receipt and forwards it to you with their username and numeric id.' })
    ]));

    /* crypto */
    const walletList = el('div', { class: 'bot-rows' });
    const drawWallets = () => {
      walletList.innerHTML = '';
      crypto.wallets.forEach((wallet, index) => {
        const grid = el('div', { class: 'form-grid' });
        formField(grid, 'Asset', bind(wallet, 'asset', el('input', { value: wallet.asset || 'USDT', placeholder: 'USDT' })));
        formField(grid, 'Network', bind(wallet, 'network', el('input', { value: wallet.network || '', placeholder: 'TRC20' })), {
          hint: 'Shown next to the address so nobody sends on the wrong chain'
        });
        formField(grid, 'Wallet address', bind(wallet, 'address', el('input', { value: wallet.address || '', placeholder: 'T…' })), { full: true });
        walletList.append(el('div', { class: 'card' }, [
          el('div', { class: 'between', style: 'margin-bottom:12px' }, [
            el('strong', { text: `${wallet.asset || 'USDT'} · ${wallet.network || 'network?'}` }),
            el('button', {
              class: 'btn icon danger', title: 'Remove', html: icon('trash'),
              onclick: () => { crypto.wallets.splice(index, 1); drawWallets(); }
            })
          ]),
          grid
        ]));
      });
      walletList.append(el('button', {
        class: 'btn', html: `${icon('plus')} Add a wallet`,
        onclick: () => { crypto.wallets.push({ asset: 'USDT', network: 'TRC20', address: '' }); drawWallets(); }
      }));
      hydrateIcons(walletList);
    };
    drawWallets();

    const cryptoNote = bind(crypto, 'note', el('input', { value: crypto.note || '', placeholder: 'optional line shown under the wallets' }));
    const cryptoGrid = el('div', { class: 'form-grid' });
    formField(cryptoGrid, 'Extra note', cryptoNote, { full: true });

    payBox.append(el('div', { class: 'card' }, [
      el('div', { class: 'between', style: 'margin-bottom:12px' }, [
        el('strong', { text: '🪙 Crypto' }), toggleOf(crypto, 'Offer this method')
      ]),
      cryptoGrid,
      el('div', { class: 'section-title', text: 'Wallets' }),
      walletList,
      el('div', { class: 'hint', style: 'margin-top:10px', text: 'The buyer can answer with a screenshot or paste the transaction hash; either one reaches you with their username and numeric id.' })
    ]));

    payBox.append(el('div', { class: 'row' }, [
      el('button', { class: 'btn primary', text: 'Save payment settings', onclick: () => save() })
    ]));
    hydrateIcons(payBox);
  };
  drawPay();
  panels.Payment.append(payBox);

  /* ---- Channel ---- */
  const chan = draft.channel;
  const chanGrid = el('div', { class: 'form-grid' });
  const chanId = el('input', { value: chan.id || '', placeholder: '@mychannel  or  -1001234567890' });
  chanId.addEventListener('input', () => { chan.id = chanId.value.trim(); });
  const chanLink = el('input', { value: chan.link || '', placeholder: 'https://t.me/… (only needed for a private channel)' });
  chanLink.addEventListener('input', () => { chan.link = chanLink.value.trim(); });
  const chanText = el('textarea', { style: 'min-height:110px' }, [chan.text || '']);
  chanText.addEventListener('input', () => { chan.text = chanText.value; });

  formField(chanGrid, 'Channel', chanId, {
    hint: 'A public channel by @name, or the numeric id of a private one'
  });
  formField(chanGrid, 'Join link', chanLink, { hint: 'Left empty, an @name builds its own' });
  formField(chanGrid, 'Message', chanText, {
    full: true,
    hint: 'Shown to anyone who has not joined. Placeholders: {name} {brand}'
  });

  const chanVerdict = el('div', { class: 'hint', style: 'margin-top:12px' });
  const chanSwitch = onOffSwitch(chan.enable === true, async (on) => {
    chan.enable = on;
    await save();
  }, 'Require joining the channel');

  panels.Channel.append(el('div', { class: 'card' }, [
    el('div', { class: 'between', style: 'margin-bottom:14px' }, [
      el('strong', { text: '📢 Join the channel first' }), chanSwitch
    ]),
    el('div', { class: 'muted', style: 'margin-bottom:16px' }, [
      'While this is on, anyone who opens the bot sees your message with a Join button and a Check button, and gets no further until they have joined.'
    ]),
    chanGrid,
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('button', { class: 'btn primary', text: 'Save', onclick: () => save() }),
      el('button', {
        class: 'btn', text: 'Test the channel',
        onclick: async function () {
          const button = this;
          button.disabled = true;
          chanVerdict.textContent = 'Asking Telegram…';
          try {
            const result = await api.post('/bot/channel/test', { id: chanId.value.trim() });
            chanVerdict.textContent = result.message;
            chanVerdict.style.color = result.ok ? 'var(--ok)' : 'var(--danger)';
            if (result.link && !chanLink.value) {
              chanLink.value = result.link;
              chan.link = result.link;
            }
            toast(result.ok ? 'The bot is an admin there' : 'The bot is not an admin there', result.ok ? '' : 'err');
          } catch (err) {
            chanVerdict.textContent = err.message;
            chanVerdict.style.color = 'var(--danger)';
            toast(err.message, 'err');
          }
          button.disabled = false;
        }
      })
    ]),
    chanVerdict,
    el('div', { class: 'hint', style: 'margin-top:14px' }, [
      'The bot must be an administrator of the channel — Telegram will not say who is a member otherwise. Add it in the channel’s Administrators list, then press Test.'
    ])
  ]));

  /* ---- Orders ---- */
  if (!data.orders.length) {
    panels.Orders.append(el('div', { class: 'card empty', html: `${icon('empty', 42)}<div>No orders yet.</div>` }));
  } else {
    const wrapOrders = el('div', { class: 'table-wrap' });
    const table = el('table');
    table.innerHTML = '<thead><tr><th>When</th><th>Buyer</th><th>Plan</th><th>Status</th></tr></thead>';
    const tbody = el('tbody');
    for (const order of data.orders) {
      tbody.append(el('tr', {}, [
        el('td', { class: 'muted mono', text: fmtDate(order.at) }),
        el('td', {}, [
          el('strong', { text: order.name || String(order.userId) }),
          el('div', { class: 'faint', style: 'font-size:11px', text: order.username ? `@${order.username}` : String(order.userId) })
        ]),
        el('td', { class: 'muted', text: order.planName || '' }),
        el('td', {}, [el('span', {
          class: `chip ${order.status === 'done' ? 'ok' : order.status === 'pending' ? '' : 'danger'}`,
          html: `<i></i>${order.status}`
        })])
      ]));
    }
    table.append(tbody);
    mountTable(wrapOrders, table);
    panels.Orders.append(wrapOrders);
  }

  /* ---- AI ---- */
  const providers = data.providers || [];
  const aiProvider = selectOf(providers.map((p) => ({ value: p.value, label: p.label })), data.ai.provider);
  const aiKey = el('input', { type: 'password', placeholder: data.ai.hasKey ? 'a key is saved' : 'paste your key' });
  const aiModel = el('input', { value: data.ai.model || '', placeholder: '' });
  const aiUrl = el('input', { value: data.ai.baseUrl || '', placeholder: 'https://api.groq.com/openai/v1/chat/completions' });
  const aiGrid = el('div', { class: 'form-grid' });

  const urlField = el('div', { class: 'field full' }, [
    el('label', { text: 'Endpoint URL' }), aiUrl,
    el('div', { class: 'hint', text: 'Any server that speaks the OpenAI chat-completions shape' })
  ]);
  const followProvider = () => {
    const meta = providers.find((p) => p.value === aiProvider.value) || {};
    urlField.hidden = !meta.needsUrl;
    aiModel.placeholder = meta.model || 'model name';
  };
  aiProvider.addEventListener('change', followProvider);

  formField(aiGrid, 'Provider', aiProvider, { full: true, hint: 'Use whichever you already pay for' });
  formField(aiGrid, 'API key', aiKey, {
    full: true,
    hint: 'Kept on your server and used only for this. Leave empty to keep the saved one.'
  });
  formField(aiGrid, 'Model', aiModel, { full: true, hint: 'Leave empty for the provider\u2019s default' });
  aiGrid.append(urlField);
  followProvider();

  const describe = el('textarea', {
    style: 'min-height:120px',
    placeholder: 'Describe the bot you want. For example: a sales bot in Persian with a welcome screen, a plans screen, a tutorial screen for iPhone and Android, and a support screen.'
  });
  const proposal = el('div');

  panels.AI.append(el('div', { class: 'card' }, [
    el('strong', { text: 'Build the bot for me' }),
    el('div', { class: 'muted', style: 'margin:6px 0 16px' }, ['Describe it in your own words and review what comes back before it replaces anything. The bot writes in Persian unless you ask for another language.']),
    aiGrid,
    el('div', { class: 'row', style: 'margin-bottom:14px' }, [
      el('button', {
        class: 'btn', text: 'Save the provider',
        onclick: () => save({
          ai: {
            provider: aiProvider.value,
            apiKey: aiKey.value.trim() || undefined,
            model: aiModel.value.trim(),
            baseUrl: aiUrl.value.trim()
          }
        })
      })
    ]),
    describe,
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', {
        class: 'btn primary', html: `${icon('sparkle')} Design the bot`,
        onclick: async function () {
          const button = this;
          button.disabled = true;
          proposal.innerHTML = '<div class="skeleton" style="height:90px"></div>';
          try {
            const result = await api.post('/bot/ai', { description: describe.value, useCurrent: true });
            proposal.innerHTML = '';
            proposal.append(el('div', { class: 'section-title', text: `${result.screens.length} screens proposed` }));
            for (const screen of result.screens) {
              proposal.append(el('div', { class: 'muted', style: 'margin:12px 0 4px', text: `/${screen.key}` }));
              proposal.append(botPreview(screen, draft.brand));
            }
            proposal.append(el('div', { class: 'row', style: 'margin-top:16px' }, [
              el('button', {
                class: 'btn primary', text: 'Use these screens',
                onclick: async () => {
                  draft.screens = result.screens;
                  drawScreens();
                  await save();
                  proposal.innerHTML = '';
                  toast('The bot was rebuilt — open the Screens tab to fine-tune it');
                }
              }),
              el('button', { class: 'btn ghost', text: 'Discard', onclick: () => { proposal.innerHTML = ''; } })
            ]));
          } catch (err) {
            proposal.innerHTML = '';
            proposal.append(el('div', { class: 'card empty', text: err.message }));
          }
          button.disabled = false;
        }
      })
    ]),
    proposal
  ]));

  hydrateIcons(view);
}

/* --------------------- settings section: the event log ------------------- */

async function renderLogs(view) {
  const logs = await api.get('/logs');
  if (!logs.length) {
    view.append(el('div', { class: 'card empty', html: `${icon('empty', 42)}<div>Nothing logged yet.</div>` }));
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
 * Offer the update in place. The server hands the job to systemd and restarts
 * itself, so the browser watches /health until the new version answers.
 */
function updateDialog(info) {
  if (!info) return;
  // the dialog re-checks as it opens, so a stale chip is never acted on
  const fresh = !info.updateAvailable;
  const note = el('p', { class: 'muted' });
  const progress = el('div', { class: 'link-box', hidden: true, style: 'margin-top:12px; max-height:150px' });
  const body = el('div', {}, [note, progress]);
  const say = (text) => { progress.hidden = false; progress.textContent = text; };

  if (!info.canUpdate) {
    note.textContent = info.updateBlockedBy || 'Update from the server\u2019s terminal.';
    body.append(
      el('div', { class: 'link-box', style: 'margin-top:10px', text: 'nexv update' }),
      el('div', { class: 'row', style: 'margin-top:12px' }, [
        el('button', { class: 'btn', html: `${icon('copy')} Copy command`, onclick: () => copy('nexv update') })
      ])
    );
    return modal({
      title: fresh ? `You are on ${info.current}` : `Version ${info.latest} is available`,
      subtitle: fresh ? '' : `This panel is running ${info.current}.`,
      body,
      width: 460
    });
  }

  note.textContent = fresh
    ? 'Nothing to install \u2014 this is the newest version.'
    : 'Your inbounds, clients and settings are left alone.';

  const run = async () => {
    primary.disabled = true;
    say('Starting the update\u2026');
    try {
      await api.post('/update', {});
    } catch (err) {
      primary.disabled = false;
      return say(`Could not start: ${err.message}`);
    }
    say('Downloading and installing. The panel restarts on its own \u2014 keep this page open.');
    watchUpdate(info.latest, say, false);
  };

  // there is nothing to press when the panel is already current
  const primary = el('button', {
    class: 'btn primary', html: `${icon('update')} Update`, onclick: run
  });
  primary.disabled = fresh;

  const recheck = el('button', {
    class: 'btn', text: 'Check again',
    onclick: async () => {
      recheck.disabled = true;
      say('Checking\u2026');
      const next = await checkForUpdate(true);
      recheck.disabled = false;
      if (next && next.updateAvailable) {
        info = next;
        primary.disabled = false;
        note.textContent = 'Your inbounds, clients and settings are left alone.';
        say(`Version ${next.latest} is available. Press Update to install it.`);
      } else {
        say(next ? `Still the newest: ${next.current}` : 'The server could not reach the repository.');
      }
    }
  });
  body.insertBefore(el('div', { class: 'row', style: 'margin-top:14px' }, [primary, recheck]), progress);

  return modal({
    title: fresh ? `You are on ${info.current}` : `Version ${info.latest} is available`,
    subtitle: fresh ? 'The panel checks for itself every six hours.' : `This panel is running ${info.current}.`,
    body,
    width: 460
  });
}

/** Poll until the restarted panel reports the new version, then reload. */
async function watchUpdate(target, say, sameVersion) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let wentDown = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let health = null;
    // the panel is restarting for part of this, so a failed probe is expected
    try { health = await api.get('/health'); } catch (_) { wentDown = true; }
    // a reinstall comes back on the same version, so watch for the restart:
    // the panel is new when its uptime is shorter than this dialog has waited
    const restarted = health && (sameVersion ? (wentDown || health.uptime < 20) : health.version === target);
    if (restarted) {
      say(`Updated to ${health.version}. Reloading\u2026`);
      return setTimeout(() => location.reload(), 1200);
    }
    let tail = '';
    try { tail = (await api.get('/update/log')).log || ''; } catch (_) { /* still down */ }
    if (tail) say(tail);
  }
  say('The update is taking longer than expected. Check the server with: nexv logs 50');
}


/**
 * Announce a newer panel in the header. Checked once per session and then
 * every six hours; a server that cannot reach GitHub simply never shows it.
 */
async function checkForUpdate(force) {
  let info;
  try { info = await api.get(`/version${force ? '?force=1' : ''}`); } catch (_) { return null; }
  state.version = info;

  const bar = document.querySelector('.topbar');
  if (!bar) return info;
  let chip = document.getElementById('updateChip');
  if (!chip) {
    // the key stays in the header whether or not there is an update: it is
    // where you go to update the panel, not just where a notice appears
    chip = el('button', {
      id: 'updateChip', class: 'update-chip', type: 'button',
      // ask again as it opens, so what the dialog offers is never stale
      onclick: async () => updateDialog(await checkForUpdate(true) || state.version)
    });
    bar.insertBefore(chip, document.getElementById('xrayChip'));
  }
  chip.classList.toggle('ready', !!info.updateAvailable);
  chip.title = info.updateAvailable
    ? `Version ${info.latest} is available`
    : `Up to date · ${info.current}`;
  chip.innerHTML = `${icon('update', 15)}<span>${info.updateAvailable ? `Update ${info.latest}` : info.current}</span>`;
  return info;
}

/* --------------------------------- dock ---------------------------------- */

/** The four pages that earn a permanent spot; the rest live under More. */
const DOCK_PAGES = ['dashboard', 'inbounds', 'clients', 'settings'];

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
      html: `${icon(entry.icon, 18)}<span>${entry.label}</span>`
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
  dock.moreItem.classList.add('active', 'open');

  // bottom row first, so the sheet unrolls up out of the button
  const rows = Array.from(dock.more.querySelectorAll('.dock-row'));
  rows.forEach((row, i) => { row.style.animationDelay = `${(rows.length - 1 - i) * 12}ms`; });

  requestAnimationFrame(() => dock.moreLens.select(state.page, false));
}

function closeMore() {
  if (!dock.moreOpen) return;
  dock.moreOpen = false;
  dock.more.classList.remove('open');
  dock.moreItem.classList.remove('active', 'open');
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
  /*
   * Item positions cannot change while a finger is down, so they are measured
   * once on press. Reading offsetLeft inside the animation frame - right after
   * writing the thumb's transform - forced a synchronous layout of the whole
   * bar on every frame, which is what made dragging stutter on a desktop.
   */
  let held = null;

  const put = (pos, s) => {
    thumb.style.setProperty(vertical ? '--y' : '--x', `${pos.toFixed(2)}px`);
    if (s != null) thumb.style.setProperty(vertical ? '--h' : '--w', `${s.toFixed(2)}px`);
  };

  const measure = () => items().map((item) => ({ item, start: start(item), size: size(item) }));

  const nearest = (pos) => {
    const list = held || measure();
    let best = 0;
    let dist = Infinity;
    list.forEach((entry, i) => {
      const d = Math.abs(entry.start + entry.size / 2 - pos);
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
    (held || measure()).forEach((entry, i) => entry.item.classList.toggle('under', i === under));
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
    held = measure();
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
      const list = held || measure();
      // clamp the lens CENTRE, not its edge: it is wider than an item, so
      // clamping the edge stops it short of the last one
      const min = list[0].start + list[0].size / 2;
      const last2 = list[list.length - 1];
      const max = last2.start + last2.size / 2;
      target = Math.max(min, Math.min(max, toLocal(event))) - lensSize / 2;
      event.preventDefault();
    }
  });

  function finish(event, cancelled) {
    if (!pressing || (event && event.pointerId !== pointerId)) return;
    pressing = false;
    cancelAnimationFrame(raf);

    const list = items();
    held = null;
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
  const face = document.querySelector('#themeToggle .ts-face');
  if (face) face.innerHTML = icon(theme === 'light' ? 'sun' : 'theme', 14);
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.setAttribute('aria-checked', theme === 'light' ? 'false' : 'true');
}

/**
 * The header's light/dark switch. It flips on a tap, and the knob can also be
 * carried across with a finger: it follows, squashes with the speed it is
 * moving and settles on the nearer side, the way the dock's capsule does.
 */
function themeSwitch(node) {
  if (!node) return;
  const knob = node.querySelector('.ts-knob');
  const travel = () => node.clientWidth - knob.offsetWidth - 4;
  const isLight = () => document.documentElement.dataset.theme === 'light';

  let pressing = false;
  let pointerId = null;
  let dragging = false;
  let startX = 0;
  let startTx = 0;
  let tx = 0;
  let lastTx = 0;

  const put = (value) => {
    tx = Math.max(0, Math.min(travel(), value));
    node.style.setProperty('--tx', `${tx.toFixed(1)}px`);
    // the knob stretches the way it does in the dock, then rounds out again
    const stretch = Math.min(0.22, Math.abs(tx - lastTx) * 0.02);
    knob.style.setProperty('--sx', (1 + stretch).toFixed(3));
    knob.style.setProperty('--sy', (1 - stretch * 0.6).toFixed(3));
    lastTx = tx;
  };

  const settle = (light) => {
    node.style.removeProperty('--tx');
    knob.style.setProperty('--sx', 1);
    knob.style.setProperty('--sy', 1);
    node.classList.remove('dragging');
    applyTheme(light ? 'light' : 'dark');
  };

  node.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pressing = true;
    dragging = false;
    pointerId = event.pointerId;
    startX = event.clientX;
    startTx = isLight() ? 0 : travel();
    lastTx = startTx;
    try { node.setPointerCapture(event.pointerId); } catch (_) { /* older browsers */ }
  });

  node.addEventListener('pointermove', (event) => {
    if (!pressing || event.pointerId !== pointerId) return;
    if (!dragging && Math.abs(event.clientX - startX) > 4) {
      dragging = true;
      node.classList.add('dragging');
    }
    if (dragging) {
      put(startTx + (event.clientX - startX));
      event.preventDefault();
    }
  });

  const release = (event, cancelled) => {
    if (!pressing || (event && event.pointerId !== pointerId)) return;
    pressing = false;
    if (cancelled) return settle(isLight());
    // a tap flips it; a drag lands on whichever side the knob ended nearer
    settle(dragging ? tx < travel() / 2 : !isLight());
    dragging = false;
  };
  node.addEventListener('pointerup', (event) => release(event, false));
  node.addEventListener('pointercancel', (event) => release(event, true));
  node.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); settle(!isLight()); }
  });
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
  const view = document.getElementById('view');
  if (view && !view.children.length) bootFailure(event.message || 'unexpected script error');
});

function boot() {
  themeSwitch(document.getElementById('themeToggle'));

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await api.post('/logout'); } catch (_) { /* sign out locally anyway */ }
    location.href = `${BASE}login`;
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
  setInterval(() => checkForUpdate(), 6 * 60 * 60 * 1000);
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
