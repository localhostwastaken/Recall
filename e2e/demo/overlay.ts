// The demo overlay: injected into every page of the recording (context.addInitScript, and again
// with page.evaluate after a navigation; it is idempotent). It draws, in a closed-off shadow root
// on <html> (so neither the page's CSS nor a transformed <body> can move it):
//
// - a caption bar at the bottom (navy on cream, a cobalt left border), with the current address
//   in small type above the caption, because a headless recording has no address bar;
// - a highlight ring and a pointer that moves to the element about to be clicked;
// - a "Sped up" badge for the parts the editor plays faster;
// - full-screen title cards;
// - a file chip that travels to a drop zone.
//
// Kept as plain JavaScript in a string (like the mock wallet), so no loader can inject helpers
// that do not exist in the page.

export type CardSpec = {
  kicker?: string;
  title: string;
  sub?: string;
  /** [label, value] rows, shown in a list (the end card's links). */
  rows?: [string, string][];
  foot?: string;
  /** A big step number for section headers. */
  step?: string;
};

export const OVERLAY_SCRIPT = String.raw`(() => {
  if (window.top !== window) return;
  // tsx keeps function names with a __name helper; functions this script's driver evaluates in
  // the page may carry it, so it must exist here.
  if (!window.__name) window.__name = (f) => f;
  if (window.__recallDemo) return;
  window.__recallDemo = true;

  // The app's own fonts (OFL), served from this machine by the recorder's route.
  const PAGE_CSS =
    "@font-face{font-family:'Recall Demo Sans';font-weight:400 700;font-display:swap;" +
    "src:url(https://demo.recall.invalid/fonts/public-sans-latin.woff2) format('woff2')}" +
    "@font-face{font-family:'Recall Demo Display';font-weight:400 800;font-display:swap;" +
    "src:url(https://demo.recall.invalid/fonts/bricolage-grotesque-latin.woff2) format('woff2')}" +
    // The publish page's sticky action bar would sit under the caption bar; in the video it
    // scrolls with the page instead, so the price and the button can be shown above the caption.
    '.approve-bar{position:static!important}';
  const CSS = ${'`'}
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; }
    .cap {
      position: fixed; left: 50%; bottom: 18px; transform: translate(-50%, 10px);
      width: max-content; max-width: min(1180px, calc(100vw - 48px));
      background: #fffdf5; color: #162743;
      border-left: 8px solid #2455df; border-radius: 6px;
      box-shadow: 0 12px 32px rgba(22, 39, 67, 0.28), 0 0 0 1px rgba(22, 39, 67, 0.14);
      padding: 10px 26px 13px 22px;
      opacity: 0; transition: opacity 0.28s ease, transform 0.28s ease;
    }
    .cap.on { opacity: 1; transform: translate(-50%, 0); }
    /* Next to the extension popup (drawn at the top right), the caption keeps to its left. */
    .cap.side { left: 24px; max-width: 820px; transform: translate(0, 10px); }
    .cap.side.on { transform: translate(0, 0); }
    .where {
      font: 500 14px/1.35 ui-monospace, 'SF Mono', Menlo, monospace; color: #52607a;
      margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .where:empty { display: none; }
    .text {
      font: 600 28px/1.3 'Recall Demo Sans', 'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
      letter-spacing: -0.005em;
    }
    .text.swap { animation: swap 0.32s ease; }
    @keyframes swap { from { opacity: 0.15; } to { opacity: 1; } }
    .fast {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%); display: none;
      background: #162743; color: #fffdf5; border-radius: 999px; padding: 8px 16px 9px;
      font: 700 18px/1 'Recall Demo Sans', 'Public Sans', system-ui, sans-serif; letter-spacing: 0.04em;
      box-shadow: 0 6px 18px rgba(22, 39, 67, 0.3);
    }
    .fast.on { display: block; }
    .fast b { color: #f7d84d; margin-left: 6px; }
    .ring {
      position: fixed; border: 4px solid #2455df; border-radius: 10px; opacity: 0;
      transition: opacity 0.25s ease;
    }
    .ring.on { opacity: 1; animation: pulse 1s ease-out 2; }
    @keyframes pulse {
      from { box-shadow: 0 0 0 0 rgba(36, 85, 223, 0.55); }
      to { box-shadow: 0 0 0 18px rgba(36, 85, 223, 0); }
    }
    .ptr {
      position: fixed; left: 0; top: 0; width: 30px; height: 30px; opacity: 0;
      transition: left 0.75s cubic-bezier(0.45, 0, 0.2, 1), top 0.75s cubic-bezier(0.45, 0, 0.2, 1), opacity 0.3s;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.35));
    }
    .ptr.on { opacity: 1; }
    .tap {
      position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
      border: 3px solid #2455df; opacity: 0;
    }
    .tap.on { animation: tap 0.6s ease-out; }
    @keyframes tap { from { opacity: 0.9; transform: scale(0.4); } to { opacity: 0; transform: scale(1.4); } }
    .chip {
      position: fixed; left: 0; top: 0; display: none; align-items: center; gap: 10px;
      background: #ffffff; color: #162743; border: 2px solid #2455df; border-radius: 8px;
      padding: 10px 14px; font: 600 17px/1.2 ui-monospace, 'SF Mono', Menlo, monospace;
      box-shadow: 0 14px 30px rgba(22, 39, 67, 0.3);
      transition: left 1.2s cubic-bezier(0.45, 0, 0.2, 1), top 1.2s cubic-bezier(0.45, 0, 0.2, 1);
    }
    .chip.on { display: flex; }
    .chip i { width: 18px; height: 22px; border: 2px solid #ae2a37; border-radius: 2px; background: #fff0ed; }
    .tick { position: fixed; left: 0; top: 0; width: 2px; height: 2px; background: #000; opacity: 0.01; }
    .card {
      position: fixed; inset: 0; background: #fffdf5; color: #162743;
      display: flex; flex-direction: column; justify-content: center;
      padding: 0 140px 40px 150px; opacity: 0; transition: opacity 0.45s ease;
    }
    .card.on { opacity: 1; }
    .card::before {
      content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 22px; background: #2455df;
    }
    .card::after {
      content: ''; position: absolute; right: 0; top: 0; width: 120px; height: 120px;
      background: linear-gradient(225deg, #f7d84d 0 50%, transparent 50%);
    }
    .kicker {
      display: flex; align-items: center; gap: 14px; color: #2455df;
      font: 700 24px/1.2 'Recall Demo Display', 'Bricolage Grotesque', system-ui, sans-serif; letter-spacing: -0.01em;
    }
    .kicker:empty { display: none; }
    .mark {
      width: 26px; height: 32px; border: 3px solid #2455df; border-radius: 3px; flex: none;
      background: linear-gradient(225deg, #f7d84d 0 9px, #e9efff 9px);
    }
    .step {
      font: 800 120px/1 'Recall Demo Display', 'Bricolage Grotesque', system-ui, sans-serif; color: #2455df;
      letter-spacing: -0.04em; margin-bottom: 8px;
    }
    .step:empty { display: none; }
    h1 {
      margin: 22px 0 0; max-width: 1000px;
      font: 800 62px/1.06 'Recall Demo Display', 'Bricolage Grotesque', system-ui, sans-serif; letter-spacing: -0.035em;
    }
    .sub {
      margin-top: 24px; max-width: 960px; color: #52607a;
      font: 400 27px/1.4 'Recall Demo Sans', 'Public Sans', system-ui, sans-serif;
    }
    .sub:empty { display: none; }
    .rule { margin-top: 30px; display: flex; gap: 0; }
    .rule span { width: 120px; height: 8px; background: #2455df; }
    .rule span + span { width: 40px; background: #f7d84d; }
    .rows { list-style: none; padding: 0; margin: 30px 0 0; }
    .rows:empty { display: none; }
    .rows li { display: flex; gap: 24px; align-items: baseline; padding: 6px 0; }
    .rows .k { width: 230px; flex: none; color: #52607a; font: 500 21px/1.4 'Recall Demo Sans', 'Public Sans', system-ui, sans-serif; }
    .rows .v { font: 600 23px/1.4 ui-monospace, 'SF Mono', Menlo, monospace; color: #162743; }
    .foot {
      position: absolute; left: 150px; bottom: 54px; color: #2455df;
      font: 700 22px/1.2 'Recall Demo Display', 'Bricolage Grotesque', system-ui, sans-serif;
    }
    .foot:empty { display: none; }
  ${'`'};

  const state = { caption: '', where: null, fast: false, card: null };
  let ui = null;

  const short = (s) => s.replace(/0x([0-9a-fA-F]{6})[0-9a-fA-F]{50,}([0-9a-fA-F]{4})/g, '0x$1\u2026$2');
  const whereNow = () => {
    if (state.where !== null) return state.where;
    if (location.protocol === 'chrome-extension:') return 'Recall extension';
    if (!/^https?:$/.test(location.protocol) || location.hostname.endsWith('.invalid')) return '';
    let s = location.host + location.pathname.replace(/\/$/, '') + location.search + location.hash;
    s = short(decodeURIComponent(s));
    return s.length > 96 ? s.slice(0, 95) + '\u2026' : s;
  };

  const el = (tag, cls, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    parent.appendChild(e);
    return e;
  };

  const mount = () => {
    if (ui && ui.host.isConnected) return;
    if (!document.documentElement) return;
    if (!document.getElementById('recall-demo-fonts')) {
      const f = document.createElement('style');
      f.id = 'recall-demo-fonts';
      f.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(f);
    }
    const host = document.createElement('recall-demo-overlay');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    const layer = el('div', 'layer', root);
    const card = el('div', 'card', layer);
    const cardStep = el('div', 'step', card);
    const kicker = el('div', 'kicker', card);
    const h1 = el('h1', '', card);
    const sub = el('div', 'sub', card);
    const rule = el('div', 'rule', card);
    el('span', '', rule);
    el('span', '', rule);
    const rows = el('ul', 'rows', card);
    const foot = el('div', 'foot', card);
    const ring = el('div', 'ring', layer);
    const tap = el('div', 'tap', layer);
    const chip = el('div', 'chip', layer);
    const ptr = el('div', 'ptr', layer);
    ptr.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2 L4 19 L8.6 14.8 L11.6 21.6 L14.6 20.3 L11.7 13.6 L18 13.6 Z" fill="#162743" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const fast = el('div', 'fast', layer);
    fast.innerHTML = 'Sped up<b>&raquo;</b>';
    const cap = el('div', 'cap', layer);
    const where = el('div', 'where', cap);
    const text = el('div', 'text', cap);
    const tick = el('div', 'tick', layer);
    document.documentElement.appendChild(host);
    ui = { host, card, cardStep, kicker, h1, sub, rows, foot, ring, tap, chip, ptr, fast, cap, where, text, tick };
    render(false);
  };

  const render = (animate) => {
    if (!ui) return;
    const prev = ui.text.textContent;
    ui.text.textContent = state.caption;
    if (animate && prev !== state.caption) {
      ui.text.classList.remove('swap');
      void ui.text.offsetWidth;
      ui.text.classList.add('swap');
    }
    ui.where.textContent = whereNow();
    ui.cap.classList.toggle('on', !!state.caption && !state.card);
    ui.cap.classList.toggle('side', location.protocol === 'chrome-extension:');
    ui.fast.classList.toggle('on', !!state.fast);
    const c = state.card;
    if (c) {
      ui.cardStep.textContent = c.step || '';
      ui.kicker.innerHTML = '';
      if (c.kicker) {
        const m = document.createElement('span');
        m.className = 'mark';
        ui.kicker.appendChild(m);
        ui.kicker.appendChild(document.createTextNode(c.kicker));
      }
      ui.h1.textContent = c.title || '';
      ui.sub.textContent = c.sub || '';
      ui.rows.innerHTML = '';
      for (const [k, v] of c.rows || []) {
        const li = document.createElement('li');
        const a = document.createElement('span');
        a.className = 'k';
        a.textContent = k;
        const b = document.createElement('span');
        b.className = 'v';
        b.textContent = v;
        li.appendChild(a);
        li.appendChild(b);
        ui.rows.appendChild(li);
      }
      ui.foot.textContent = c.foot || '';
    }
    ui.card.classList.toggle('on', !!c);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__caption = (t, where) => {
    state.caption = t || '';
    if (where !== undefined) state.where = where;
    mount();
    render(true);
  };
  window.__where = (w) => {
    state.where = w === undefined ? null : w;
    mount();
    render(false);
  };
  window.__fast = (on) => {
    state.fast = !!on;
    mount();
    render(false);
  };
  window.__card = (spec) => {
    state.card = spec || null;
    mount();
    render(false);
  };
  window.__highlight = (box) => {
    mount();
    if (!ui || !box) return;
    const pad = 6;
    Object.assign(ui.ring.style, {
      left: box.x - pad + 'px', top: box.y - pad + 'px',
      width: box.width + pad * 2 + 'px', height: box.height + pad * 2 + 'px',
    });
    ui.ring.classList.remove('on');
    void ui.ring.offsetWidth;
    ui.ring.classList.add('on');
    clearTimeout(window.__recallDemoRing);
    window.__recallDemoRing = setTimeout(() => ui && ui.ring.classList.remove('on'), 2400);
    const x = Math.round(box.x + Math.min(box.width * 0.5, 60));
    const y = Math.round(box.y + box.height * 0.6);
    ui.ptr.classList.add('on');
    ui.ptr.style.left = x + 'px';
    ui.ptr.style.top = y + 'px';
  };
  window.__unhighlight = () => {
    if (ui) ui.ring.classList.remove('on');
  };
  window.__tap = () => {
    if (!ui) return;
    ui.tap.style.left = ui.ptr.style.left;
    ui.tap.style.top = ui.ptr.style.top;
    ui.tap.classList.remove('on');
    void ui.tap.offsetWidth;
    ui.tap.classList.add('on');
  };
  window.__chip = async (name, from, to) => {
    mount();
    if (!ui) return;
    ui.chip.innerHTML = '';
    const i = document.createElement('i');
    ui.chip.appendChild(i);
    ui.chip.appendChild(document.createTextNode(name));
    ui.chip.style.transition = 'none';
    ui.chip.style.left = from.x + 'px';
    ui.chip.style.top = from.y + 'px';
    ui.chip.classList.add('on');
    void ui.chip.offsetWidth;
    ui.chip.style.transition = '';
    await sleep(350);
    ui.chip.style.left = to.x + 'px';
    ui.chip.style.top = to.y + 'px';
    ui.ptr.classList.add('on');
    ui.ptr.style.left = to.x + 20 + 'px';
    ui.ptr.style.top = to.y + 26 + 'px';
    await sleep(1300);
  };
  window.__chipOff = () => {
    if (ui) ui.chip.classList.remove('on');
  };

  // A heartbeat repaint, so a still page still yields frames for the recording.
  let beat = false;
  setInterval(() => {
    if (!ui || !ui.host.isConnected) mount();
    if (!ui) return;
    beat = !beat;
    ui.tick.style.opacity = beat ? '0.02' : '0.01';
    const w = whereNow();
    if (ui.where.textContent !== w) ui.where.textContent = w;
  }, 400);
  window.addEventListener('hashchange', () => render(false));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  mount();
})();`;

/** The blank page the title cards are drawn over (served by a route; nothing leaves the machine). */
export const CARD_ORIGIN = 'https://demo.recall.invalid/';
export const CARD_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Recall</title></head>
<body style="margin:0;background:#fffdf5"></body></html>`;
/** Font files the route serves under CARD_ORIGIN/fonts/ (the web app's own, OFL). */
export const FONT_FILES = ['public-sans-latin.woff2', 'bricolage-grotesque-latin.woff2'];
