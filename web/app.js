'use strict';
/* NexV Panel — single-page frontend, no build step. */

/* ------------------------------- helpers -------------------------------- */

const api = {
  async request(method, path, body) {
    // relative URL: the panel may be served under a secret base path
    const res = await fetch(`api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { location.href = 'login'; throw new Error('unauthorized'); }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

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
  if (d) return `${d} روز و ${h} ساعت`;
  if (h) return `${h} ساعت و ${m} دقیقه`;
  return `${m} دقیقه`;
}

function fmtDate(ts) {
  if (!ts) return '∞';
  try {
    return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ts));
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
    toast('در کلیپ‌بورد کپی شد');
  } catch (_) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('در کلیپ‌بورد کپی شد');
  }
}

/* -------------------------------- icons --------------------------------- */

const ICONS = {
  dashboard: '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
  inbounds: '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
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
    bar.append(el('button', { class: 'btn ghost', text: 'بستن', onclick: close }));
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
    title: 'تأیید عملیات',
    body: el('p', { class: 'muted', text: message }),
    actions: [{ label: 'بله، انجام بده', kind: 'danger', onClick: (close) => { close(); onYes(); } }]
  });
}

/* ------------------------------ page: shell ------------------------------ */

const PAGES = [
  { id: 'dashboard', label: 'داشبورد', icon: 'dashboard' },
  { id: 'inbounds', label: 'ورودی‌ها (Inbounds)', icon: 'inbounds' },
  { id: 'clients', label: 'کاربران', icon: 'clients' },
  { id: 'settings', label: 'تنظیمات پنل', icon: 'settings' },
  { id: 'logs', label: 'رویدادها', icon: 'logs' },
  { id: 'account', label: 'حساب مدیر', icon: 'account' }
];

const state = { page: 'dashboard', inbounds: [], clients: [], settings: {}, timer: null };

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const page of PAGES) {
    nav.append(el('div', {
      class: `nav-item ${state.page === page.id ? 'active' : ''}`,
      html: `${icon(page.icon)}<span>${esc(page.label)}</span>`,
      onclick: () => navigate(page.id)
    }));
  }
}

function navigate(page) {
  state.page = page;
  location.hash = page;
  document.getElementById('pageTitle').textContent = (PAGES.find((p) => p.id === page) || {}).label || '';
  document.getElementById('sidebar').classList.remove('open');
  renderNav();
  render();
}

function render() {
  const view = document.getElementById('view');
  view.innerHTML = '';
  clearInterval(state.timer);
  state.timer = null;
  ({
    dashboard: renderDashboard,
    inbounds: renderInbounds,
    clients: renderClients,
    settings: renderSettings,
    logs: renderLogs,
    account: renderAccount
  }[state.page] || renderDashboard)(view);
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
      statCard('پردازنده', `${s.cpu.percent}%`, `${s.cpu.cores} هسته`, s.cpu.percent,
        s.cpu.percent > 85 ? 'danger' : s.cpu.percent > 60 ? 'warn' : ''),
      statCard('حافظه', `${s.memory.percent}%`, `${bytes(s.memory.used)} از ${bytes(s.memory.total)}`,
        s.memory.percent, s.memory.percent > 85 ? 'danger' : s.memory.percent > 60 ? 'warn' : ''),
      statCard('دیسک', `${s.disk.percent}%`, `${bytes(s.disk.used)} از ${bytes(s.disk.total)}`,
        s.disk.percent, s.disk.percent > 85 ? 'danger' : ''),
      statCard('سرعت لحظه‌ای', `${bytes(s.network.speed.rx)}/s ↓`, `${bytes(s.network.speed.tx)}/s ↑`),
      statCard('کاربران فعال', String(status.counts.clientsActive), `از ${status.counts.clients} کاربر`),
      statCard('ورودی‌ها', String(status.counts.inboundsEnabled), `از ${status.counts.inbounds} ورودی`),
      statCard('ترافیک کل', bytes(status.traffic.up + status.traffic.down),
        `${bytes(status.traffic.down)} ↓ · ${bytes(status.traffic.up)} ↑`),
      statCard('آپ‌تایم سرور', duration(s.uptime), s.platform)
    );

    info.innerHTML = '';
    info.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'between', style: 'margin-bottom:14px' }, [
          el('strong', { text: 'وضعیت Xray-core' }),
          el('span', {
            class: `chip ${status.xray.running ? 'ok' : 'danger'}`,
            html: `<i></i>${status.xray.running ? 'در حال اجرا' : 'متوقف'}`
          })
        ]),
        el('div', { class: 'muted', text: status.xray.version || 'نسخه نامشخص' }),
        el('div', { class: 'row', style: 'margin-top:16px' }, [
          el('button', { class: 'btn', html: `${icon('refresh')} ری‌استارت`, onclick: () => xrayAction('restart') }),
          el('button', { class: 'btn', html: `${icon('power')} توقف`, onclick: () => xrayAction('stop') }),
          el('button', { class: 'btn', html: `${icon('power')} شروع`, onclick: () => xrayAction('start') })
        ])
      ]),
      el('div', { class: 'card' }, [
        el('strong', { text: 'اطلاعات سرور' }),
        el('div', { class: 'muted', style: 'margin-top:12px;line-height:2' }, [
          el('div', { text: `نام میزبان: ${s.hostname}` }),
          el('div', { text: `دامنه پنل: ${status.settings.domain || 'تنظیم نشده'}` }),
          el('div', { text: `بار سیستم: ${s.loadavg.map((n) => n.toFixed(2)).join(' / ')}` }),
          el('div', { text: `کاربران منقضی: ${status.counts.clientsExpired} · اتمام حجم: ${status.counts.clientsDepleted}` })
        ])
      ])
    );

    const chip = document.getElementById('xrayChip');
    chip.className = `chip ${status.xray.running ? 'ok' : 'danger'}`;
    chip.innerHTML = `<i></i><span>Xray ${status.xray.running ? 'فعال' : 'خاموش'}</span>`;
    // keep just "Xray x.y.z"; the full build string overflows the sidebar
    const shortVersion = (status.xray.version || '').split('(')[0].trim();
    document.getElementById('xrayVersion').textContent = shortVersion || 'Xray-core';
  };

  await paint();
  // a hidden tab must not keep polling: it wakes the server for nothing
  state.timer = setInterval(() => { if (!document.hidden) paint(); }, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) paint(); }, { once: false });
}

async function xrayAction(action) {
  try {
    await api.post(`/xray/${action}`);
    toast('عملیات با موفقیت انجام شد');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ----------------------------- page: inbounds ---------------------------- */

async function renderInbounds(view) {
  view.append(el('div', { class: 'between', style: 'margin-bottom:16px' }, [
    el('div', { class: 'muted', text: 'ورودی‌های Xray؛ هر ورودی یک پورت و پروتکل مستقل است.' }),
    el('button', { class: 'btn primary', html: `${icon('plus')} ورودی جدید`, onclick: () => inboundForm(null) })
  ]));

  const wrap = el('div', { class: 'table-wrap' });
  view.append(wrap);
  wrap.innerHTML = '<div class="empty"><div class="skeleton" style="height:120px"></div></div>';

  state.inbounds = await api.get('/inbounds');
  if (!state.inbounds.length) {
    wrap.innerHTML = `<div class="empty">${icon('empty', 42)}<div>هنوز ورودی‌ای نساخته‌اید. با دکمه «ورودی جدید» شروع کنید.</div></div>`;
    return;
  }

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>نام</th><th>پروتکل</th><th>پورت</th><th>ترنسپورت</th>
    <th>کاربران</th><th>ترافیک</th><th>وضعیت</th><th></th>
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
        html: `<i></i>${inb.enable === false ? 'غیرفعال' : 'فعال'}`
      })]),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn icon ghost', title: 'ویرایش', html: icon('edit'), onclick: () => inboundForm(inb) }),
        el('button', {
          class: 'btn icon ghost', title: 'فعال/غیرفعال', html: icon('power'),
          onclick: async () => { await api.post(`/inbounds/${inb.id}/toggle`); toast('انجام شد'); render(); }
        }),
        el('button', {
          class: 'btn icon danger', title: 'حذف', html: icon('trash'),
          onclick: () => confirmDialog(`ورودی «${inb.remark}» و همه کاربرانش حذف شود؟`, async () => {
            await api.del(`/inbounds/${inb.id}`);
            toast('ورودی حذف شد');
            render();
          })
        })
      ])])
    ]));
  }
  table.append(tbody);
  wrap.innerHTML = '';
  wrap.append(table);
}

function inboundForm(existing) {
  const v = existing || {};
  const form = el('div', { class: 'form-grid' });

  const input = (name, label, value, opts = {}) => {
    const field = el('div', { class: `field ${opts.full ? 'full' : ''}` });
    field.append(el('label', { text: label }));
    let control;
    if (opts.options) {
      control = el('select', { name });
      for (const opt of opts.options) {
        control.append(el('option', { value: opt.value, selected: String(value) === String(opt.value) }, [opt.label]));
      }
    } else {
      control = el('input', { name, type: opts.type || 'text', value: value ?? '', placeholder: opts.placeholder || '' });
    }
    field.append(control);
    if (opts.hint) field.append(el('div', { class: 'hint', text: opts.hint }));
    form.append(field);
    return control;
  };

  const remark = input('remark', 'نام ورودی', v.remark || 'inbound-1');
  const port = input('port', 'پورت', v.port || Math.floor(20000 + Math.random() * 40000), { type: 'number' });
  const protocol = input('protocol', 'پروتکل', v.protocol || 'vless', {
    options: [
      { value: 'vless', label: 'VLESS' }, { value: 'vmess', label: 'VMess' },
      { value: 'trojan', label: 'Trojan' }, { value: 'shadowsocks', label: 'Shadowsocks' }
    ]
  });
  const network = input('network', 'ترنسپورت', v.network || 'tcp', {
    options: [
      { value: 'tcp', label: 'TCP' }, { value: 'ws', label: 'WebSocket' },
      { value: 'grpc', label: 'gRPC' }, { value: 'httpupgrade', label: 'HTTPUpgrade' },
      { value: 'xhttp', label: 'XHTTP' }
    ]
  });
  const security = input('security', 'امنیت', v.security || 'none', {
    options: [{ value: 'none', label: 'None' }, { value: 'tls', label: 'TLS' }, { value: 'reality', label: 'REALITY' }]
  });
  const address = input('address', 'آدرس اتصال (اختیاری)', v.address || '', {
    hint: 'اگر خالی باشد از دامنه یا IP سرور استفاده می‌شود'
  });

  // conditional groups
  const wsPath = input('wsPath', 'مسیر (Path)', v.wsPath || '/nexv', {});
  const wsHost = input('wsHost', 'هدر Host', v.wsHost || '', {});
  const grpcService = input('grpcServiceName', 'نام سرویس gRPC', v.grpcServiceName || 'nexv-grpc', {});
  const sni = input('sni', 'SNI', v.sni || '', {});
  const certFile = input('certFile', 'مسیر گواهی TLS', v.certFile || '', { full: true, placeholder: '/etc/letsencrypt/live/example.com/fullchain.pem' });
  const keyFile = input('keyFile', 'مسیر کلید TLS', v.keyFile || '', { full: true, placeholder: '/etc/letsencrypt/live/example.com/privkey.pem' });
  const rDest = input('rdest', 'مقصد REALITY', (v.reality && v.reality.dest) || 'www.cloudflare.com:443', {});
  const rNames = input('rnames', 'Server Names', (v.reality && (v.reality.serverNames || []).join(',')) || 'www.cloudflare.com', {});
  const rPriv = input('rpriv', 'Private Key', (v.reality && v.reality.privateKey) || '', { full: true, hint: 'خالی بگذارید تا خودکار ساخته شود' });
  const rPub = input('rpub', 'Public Key', (v.reality && v.reality.publicKey) || '', { full: true });
  const rShort = input('rshort', 'Short IDs', (v.reality && (v.reality.shortIds || []).join(',')) || '', {});
  const ssMethod = input('method', 'روش رمزنگاری', v.method || '2022-blake3-aes-128-gcm', {
    options: ['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', 'aes-128-gcm', 'chacha20-ietf-poly1305']
      .map((m) => ({ value: m, label: m }))
  });

  const fieldOf = (control) => control.closest('.field');
  const groups = {
    ws: [fieldOf(wsPath), fieldOf(wsHost)],
    grpc: [fieldOf(grpcService)],
    tls: [fieldOf(sni), fieldOf(certFile), fieldOf(keyFile)],
    reality: [fieldOf(rDest), fieldOf(rNames), fieldOf(rPriv), fieldOf(rPub), fieldOf(rShort)],
    ss: [fieldOf(ssMethod)]
  };

  const sync = () => {
    const net = network.value;
    const sec = security.value;
    const show = (nodes, on) => nodes.forEach((n) => n.classList.toggle('hidden', !on));
    show(groups.ws, net === 'ws' || net === 'httpupgrade' || net === 'xhttp');
    show(groups.grpc, net === 'grpc');
    show(groups.tls, sec === 'tls');
    show(groups.reality, sec === 'reality');
    show(groups.ss, protocol.value === 'shadowsocks');
    // REALITY only works over raw TCP or gRPC/xhttp; keep the pairing sane
    if (sec === 'reality' && (net === 'ws' || net === 'httpupgrade')) {
      security.value = 'none';
      toast('REALITY با WebSocket سازگار نیست', 'err');
      sync();
    }
  };
  [network, security, protocol].forEach((c) => c.addEventListener('change', sync));
  sync();

  modal({
    title: existing ? 'ویرایش ورودی' : 'ورودی جدید',
    subtitle: 'پس از ذخیره، تنظیمات روی Xray اعمال و سرویس ری‌استارت می‌شود.',
    body: form,
    width: 680,
    actions: [{
      label: existing ? 'ذخیره تغییرات' : 'ایجاد ورودی',
      kind: 'primary',
      onClick: async (close) => {
        const payload = {
          remark: remark.value,
          port: Number(port.value),
          protocol: protocol.value,
          network: network.value,
          security: security.value,
          address: address.value,
          wsPath: wsPath.value,
          wsHost: wsHost.value,
          grpcServiceName: grpcService.value,
          sni: sni.value,
          certFile: certFile.value,
          keyFile: keyFile.value,
          method: ssMethod.value,
          reality: {
            dest: rDest.value,
            serverNames: rNames.value.split(',').map((s) => s.trim()).filter(Boolean),
            privateKey: rPriv.value,
            publicKey: rPub.value,
            shortIds: rShort.value.split(',').map((s) => s.trim()).filter(Boolean)
          }
        };
        try {
          if (existing) await api.put(`/inbounds/${existing.id}`, payload);
          else await api.post('/inbounds', payload);
          close();
          toast('ورودی ذخیره شد');
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
  view.append(el('div', { class: 'between', style: 'margin-bottom:16px' }, [
    el('div', { class: 'muted', text: 'کاربران هر ورودی، همراه با محدودیت حجم و تاریخ انقضا.' }),
    el('button', { class: 'btn primary', html: `${icon('plus')} کاربر جدید`, onclick: () => clientForm(null) })
  ]));

  const wrap = el('div', { class: 'table-wrap' });
  view.append(wrap);

  const [inbounds, clients] = await Promise.all([api.get('/inbounds'), api.get('/clients')]);
  state.inbounds = inbounds;
  state.clients = clients;

  if (!inbounds.length) {
    wrap.innerHTML = `<div class="empty">${icon('empty', 42)}<div>ابتدا یک ورودی بسازید، سپس کاربر اضافه کنید.</div></div>`;
    return;
  }
  if (!clients.length) {
    wrap.innerHTML = `<div class="empty">${icon('empty', 42)}<div>هنوز کاربری اضافه نشده است.</div></div>`;
    return;
  }

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>نام کاربر</th><th>ورودی</th><th>مصرف</th><th>حجم</th>
    <th>انقضا</th><th>وضعیت</th><th></th>
  </tr></thead>`;
  const tbody = el('tbody');

  for (const c of clients) {
    const used = (c.up || 0) + (c.down || 0);
    const quota = (c.totalGB || 0) * 1024 ** 3;
    const percent = quota ? (used / quota) * 100 : 0;
    const left = daysLeft(c.expiryTime);

    let statusChip;
    if (c.enable === false) statusChip = el('span', { class: 'chip', html: '<i></i>غیرفعال' });
    else if (c.expired) statusChip = el('span', { class: 'chip danger', html: '<i></i>منقضی' });
    else if (c.depleted) statusChip = el('span', { class: 'chip danger', html: '<i></i>اتمام حجم' });
    else statusChip = el('span', { class: 'chip ok', html: '<i></i>فعال' });

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
      el('td', { class: 'muted num', text: c.totalGB ? `${c.totalGB} GB` : 'نامحدود' }),
      el('td', { class: 'muted' }, [
        el('div', { text: fmtDate(c.expiryTime) }),
        left !== null ? el('div', { class: 'faint', style: 'font-size:11px', text: left > 0 ? `${left} روز مانده` : 'گذشته' }) : null
      ]),
      el('td', {}, [statusChip]),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn icon ghost', title: 'QR و لینک', html: icon('qr'), onclick: () => showClientLink(c) }),
        el('button', { class: 'btn icon ghost', title: 'کپی لینک', html: icon('copy'), onclick: () => copy(c.link) }),
        el('button', { class: 'btn icon ghost', title: 'ویرایش', html: icon('edit'), onclick: () => clientForm(c) }),
        el('button', {
          class: 'btn icon ghost', title: 'فعال/غیرفعال', html: icon('power'),
          onclick: async () => { await api.post(`/clients/${c.id}/toggle`); render(); }
        }),
        el('button', {
          class: 'btn icon danger', title: 'حذف', html: icon('trash'),
          onclick: () => confirmDialog(`کاربر «${c.email}» حذف شود؟`, async () => {
            await api.del(`/clients/${c.id}`);
            toast('کاربر حذف شد');
            render();
          })
        })
      ])])
    ]));
  }
  table.append(tbody);
  wrap.innerHTML = '';
  wrap.append(table);
}

async function showClientLink(client) {
  const [qr, sub] = await Promise.all([
    api.get(`/clients/${client.id}/qrcode`),
    api.get(`/clients/${client.id}/sub-url`)
  ]);
  const body = el('div', { class: 'qr-box' }, [
    el('img', { src: qr.dataUrl, alt: 'QR' }),
    el('div', { class: 'link-box', text: qr.content }),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', html: `${icon('copy')} کپی لینک کانفیگ`, onclick: () => copy(qr.content) }),
      el('button', { class: 'btn', html: `${icon('copy')} کپی لینک اشتراک`, onclick: () => copy(sub.url) })
    ]),
    el('div', { class: 'link-box', text: sub.url })
  ]);
  modal({ title: `کانفیگ ${client.email}`, subtitle: 'با اسکن QR یا کپی لینک، کانفیگ را به کلاینت اضافه کنید.', body, width: 440 });
}

function clientForm(existing) {
  const v = existing || {};
  const form = el('div', { class: 'form-grid' });

  const field = (label, control, opts = {}) => {
    const box = el('div', { class: `field ${opts.full ? 'full' : ''}` }, [el('label', { text: label }), control]);
    if (opts.hint) box.append(el('div', { class: 'hint', text: opts.hint }));
    form.append(box);
    return control;
  };

  const email = field('نام کاربر', el('input', { value: v.email || '', placeholder: 'user-01' }));
  const inboundSel = el('select');
  for (const inb of state.inbounds) {
    inboundSel.append(el('option', { value: inb.id, selected: v.inboundId === inb.id }, [`${inb.remark} · ${inb.protocol}:${inb.port}`]));
  }
  field('ورودی', inboundSel);

  const uuid = field('UUID', el('input', { value: v.uuid || '', placeholder: 'خالی = ساخت خودکار' }), { full: true });
  const totalGB = field('محدودیت حجم (GB)', el('input', { type: 'number', min: '0', value: v.totalGB || 0 }), { hint: '۰ یعنی نامحدود' });

  const days = el('input', { type: 'number', min: '0', value: v.expiryTime ? Math.max(0, daysLeft(v.expiryTime)) : 30 });
  field('اعتبار (روز)', days, { hint: '۰ یعنی بدون انقضا' });

  const limitIp = field('محدودیت IP همزمان', el('input', { type: 'number', min: '0', value: v.limitIp || 0 }));
  const flowSel = el('select');
  for (const opt of [{ value: '', label: 'بدون flow' }, { value: 'xtls-rprx-vision', label: 'xtls-rprx-vision' }]) {
    flowSel.append(el('option', { value: opt.value, selected: (v.flow || '') === opt.value }, [opt.label]));
  }
  field('Flow (فقط VLESS + TCP)', flowSel);
  const comment = field('یادداشت', el('input', { value: v.comment || '' }), { full: true });

  modal({
    title: existing ? 'ویرایش کاربر' : 'کاربر جدید',
    body: form,
    width: 640,
    actions: [{
      label: 'ذخیره',
      kind: 'primary',
      onClick: async (close) => {
        const dayCount = Number(days.value);
        const payload = {
          email: email.value.trim(),
          inboundId: inboundSel.value,
          uuid: uuid.value.trim() || undefined,
          totalGB: Number(totalGB.value),
          expiryTime: dayCount > 0 ? Date.now() + dayCount * 86400000 : 0,
          limitIp: Number(limitIp.value),
          flow: flowSel.value,
          comment: comment.value
        };
        try {
          if (existing) await api.put(`/clients/${existing.id}`, payload);
          else await api.post('/clients', payload);
          close();
          toast('کاربر ذخیره شد');
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

  add('domain', 'دامنه پنل', s.domain, { hint: 'برای لینک‌های اشتراک و TLS استفاده می‌شود' });
  add('webBasePath', 'مسیر مخفی پنل (Web Path)', s.webBasePath || '',
    { hint: 'مثلاً /myPanel — خالی یعنی بدون مسیر مخفی. بعد از ذخیره باید با آدرس جدید وارد شوید' });
  add('panelPort', 'پورت پنل', s.panelPort, { type: 'number', hint: 'تغییر پورت نیازمند ری‌استارت سرویس پنل است' });
  add('subPort', 'پورت لینک اشتراک', s.subPort, { type: 'number' });
  add('subPath', 'مسیر اشتراک', s.subPath);
  add('certFile', 'گواهی TLS پیش‌فرض', s.certFile, { full: true, placeholder: '/etc/letsencrypt/live/example.com/fullchain.pem' });
  add('keyFile', 'کلید TLS پیش‌فرض', s.keyFile, { full: true, placeholder: '/etc/letsencrypt/live/example.com/privkey.pem' });

  const logLevel = el('select');
  for (const level of ['none', 'error', 'warning', 'info', 'debug']) {
    logLevel.append(el('option', { value: level, selected: (s.xrayLogLevel || 'warning') === level }, [level]));
  }
  grid.append(el('div', { class: 'field' }, [el('label', { text: 'سطح لاگ Xray' }), logLevel]));

  const torrent = el('input', { type: 'checkbox' });
  torrent.checked = !!s.blockTorrent;
  grid.append(el('div', { class: 'field' }, [
    el('label', { text: 'مسدودسازی بیت‌تورنت' }),
    el('label', { class: 'switch' }, [torrent, el('span', { class: 'track' }), el('span', { class: 'muted', text: 'ترافیک تورنت بلاک شود' })])
  ]));

  card.append(grid, el('div', { class: 'row', style: 'margin-top:8px' }, [
    el('button', {
      class: 'btn primary', text: 'ذخیره تنظیمات',
      onclick: async () => {
        const payload = { xrayLogLevel: logLevel.value, blockTorrent: torrent.checked };
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
              title: 'مسیر پنل تغییر کرد',
              subtitle: 'آدرس جدید را ذخیره کنید؛ آدرس قبلی دیگر کار نمی‌کند.',
              body: el('div', {}, [el('div', { class: 'link-box', text: url })]),
              actions: [{ label: 'رفتن به آدرس جدید', kind: 'primary', onClick: () => { location.href = url; } }]
            });
            return;
          }
          toast(result.restartNeeded ? 'ذخیره شد — برای تغییر پورت پنل، سرویس را ری‌استارت کنید (nexv restart)' : 'تنظیمات ذخیره شد');
        } catch (err) { toast(err.message, 'err'); }
      }
    })
  ]));
  view.append(card);

  view.append(el('div', { class: 'section-title', text: 'پشتیبان‌گیری' }));
  view.append(el('div', { class: 'card row' }, [
    el('a', { class: 'btn', href: 'api/backup', download: '' }, ['دانلود فایل پشتیبان']),
    el('button', {
      class: 'btn', text: 'بازیابی از فایل',
      onclick: () => {
        const picker = el('input', { type: 'file', accept: 'application/json', class: 'hidden' });
        picker.addEventListener('change', async () => {
          const file = picker.files[0];
          if (!file) return;
          try {
            await api.post('/restore', JSON.parse(await file.text()));
            toast('پیکربندی بازیابی شد');
            render();
          } catch (err) { toast(err.message, 'err'); }
        });
        document.body.append(picker);
        picker.click();
        setTimeout(() => picker.remove(), 60000);
      }
    }),
    el('button', {
      class: 'btn ghost', text: 'مشاهده config.json',
      onclick: async () => {
        const cfg = await api.get('/xray/config');
        modal({
          title: 'پیکربندی فعلی Xray',
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
    view.innerHTML = `<div class="card empty">${icon('empty', 42)}<div>رویدادی ثبت نشده است.</div></div>`;
    return;
  }
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table');
  table.innerHTML = '<thead><tr><th>زمان</th><th>نوع</th><th>رویداد</th></tr></thead>';
  const tbody = el('tbody');
  for (const log of logs) {
    tbody.append(el('tr', {}, [
      el('td', { class: 'muted mono', text: fmtDate(log.at) }),
      el('td', {}, [el('span', { class: 'chip', text: log.type })]),
      el('td', { text: log.message })
    ]));
  }
  table.append(tbody);
  wrap.append(table);
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
    el('div', { class: 'field' }, [el('label', { text: 'نام کاربری' }), username]),
    el('div', { class: 'field' }, [el('label', { text: 'رمز عبور فعلی' }), current]),
    el('div', { class: 'field full' }, [
      el('label', { text: 'رمز عبور جدید' }), next,
      el('div', { class: 'hint', text: 'خالی بگذارید تا رمز تغییر نکند' })
    ])
  );

  view.append(el('div', { class: 'card' }, [
    form,
    el('button', {
      class: 'btn primary', text: 'ذخیره حساب',
      onclick: async () => {
        try {
          await api.post('/account', {
            username: username.value.trim(),
            password: next.value || undefined,
            currentPassword: current.value
          });
          toast('حساب به‌روزرسانی شد؛ دوباره وارد شوید');
          setTimeout(() => { location.href = 'login'; }, 1200);
        } catch (err) { toast(err.message, 'err'); }
      }
    })
  ]));
}

/* --------------------------------- boot ---------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('nexv-theme', theme);
}

document.getElementById('themeToggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.post('/logout');
  location.href = 'login';
});

document.getElementById('menuBtn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
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

applyTheme(localStorage.getItem('nexv-theme') || 'dark');
hydrateIcons();
navigate(location.hash.slice(1) || 'dashboard');
