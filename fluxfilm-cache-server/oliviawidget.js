/* FluxFilm - Olivia chat window (served at /olivia.js, loaded by index.html). Plain JS, no build step.
 *
 * window.ffOlivia.open() -> true when Olivia is on for this logged-in customer: shows "Chat with Olivia / WhatsApp us".
 *                          false -> the caller opens WhatsApp as before (index.html ffOpenHelp_).
 * Everything Olivia says and every button comes from the server (/api oliviaChat). This file only draws it.
 * A login card is kept in memory only - never saved in sessionStorage.
 */
(function () {
  'use strict';
  if (window.ffOlivia) return;
  var API = '/api';
  var WA = 'https://wa.me/message/UWTAS2ZMVF4QJ1';
  var st = { phone: '', enabled: false, checkedFor: '', wa: WA, convId: '', lang: '', messages: [], busy: false, pollTimer: null, open: false };

  function phoneNow() {
    try {
      var s = JSON.parse(localStorage.getItem('ff_session_v2') || '{}');
      var p = (s && s.phone) || localStorage.getItem('ff_phone') || '';
      p = String(p).replace(/\D/g, '');
      return p.length >= 10 ? p.slice(-10) : '';
    } catch (e) { return ''; }
  }
  function installed() {
    try { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; } catch (e) { return false; }
  }
  function call(action, args) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action, args: args }) })
      .then(function (r) { return r.json(); });
  }
  function load() {
    try {
      var saved = JSON.parse(sessionStorage.getItem('ff_olivia') || 'null');
      if (saved && saved.phone === st.phone) { st.convId = saved.convId || ''; st.messages = saved.messages || []; }
    } catch (e) {}
    try { st.lang = localStorage.getItem('ff_olivia_lang') || ''; } catch (e) {}
  }
  function save() {
    try {
      var safe = st.messages.map(function (m) { return m.card && m.card.type === 'access' ? Object.assign({}, m, { card: { type: 'access-hidden' } }) : m; });
      sessionStorage.setItem('ff_olivia', JSON.stringify({ phone: st.phone, convId: st.convId, messages: safe.slice(-60) }));
      if (st.lang) localStorage.setItem('ff_olivia_lang', st.lang);
    } catch (e) {}
  }
  function refresh() {
    var p = phoneNow();
    if (!p) { st.enabled = false; st.checkedFor = ''; return; }
    // Same phone: re-ask the server at most every 5 minutes (admin may switch Olivia on or off).
    if (p === st.checkedFor && Date.now() - (st.checkedAt || 0) < 5 * 60e3) return;
    st.checkedFor = p; st.checkedAt = Date.now();
    call('oliviaStatus', [p]).then(function (r) {
      if (phoneNow() !== p) return;
      st.enabled = !!(r && r.ok && r.enabled); st.wa = (r && r.whatsappLink) || WA;
    }).catch(function () { st.checkedFor = ''; });
  }

  // -- styles --
  var css = '' +
    '.ffo-bg{position:fixed;inset:0;z-index:90;background:rgba(15,23,42,.35);display:flex;align-items:flex-end;justify-content:center;font-family:"Plus Jakarta Sans",system-ui,sans-serif}' +
    '.ffo-sheet{width:100%;max-width:440px;background:#fff;border-radius:22px 22px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -10px 40px rgba(15,23,42,.2)}' +
    '.ffo-sheet h3{margin:0 0 4px;font-size:18px;font-weight:900;color:#0f172a}.ffo-sheet p{margin:0 0 14px;color:#475569;font-size:14px;font-weight:600}' +
    '.ffo-opt{display:flex;gap:12px;align-items:center;width:100%;border:1.5px solid #e2e8f0;background:#fff;border-radius:16px;padding:14px;margin-bottom:10px;text-align:left;font:inherit;cursor:pointer;min-height:64px}' +
    '.ffo-opt b{display:block;font-size:16px;color:#0f172a}.ffo-opt span{display:block;font-size:13px;color:#64748b;font-weight:600}.ffo-opt i{font-style:normal;font-size:30px}' +
    '.ffo-opt.ai{border-color:#34d399;background:#ecfdf5}' +
    '.ffo-panel{position:fixed;inset:0;z-index:91;background:#f5f7fb;display:flex;flex-direction:column;font-family:"Plus Jakarta Sans",system-ui,sans-serif}' +
    '@media(min-width:700px){.ffo-panel{inset:auto 20px 20px auto;width:400px;height:min(680px,calc(100dvh - 40px));border-radius:22px;box-shadow:0 20px 60px rgba(15,23,42,.3);overflow:hidden}}' +
    '.ffo-top{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:#04140e;color:#fff}' +
    '.ffo-top .av{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#34d399,#059669);display:grid;place-items:center;font-size:22px;flex:none}' +
    '.ffo-top b{display:block;font-size:16px}.ffo-top small{display:block;font-size:12px;color:#a7f3d0;font-weight:600}' +
    '.ffo-x{margin-left:auto;border:0;background:rgba(255,255,255,.12);color:#fff;width:40px;height:40px;border-radius:50%;font-size:22px;cursor:pointer}' +
    '.ffo-list{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px}' +
    '.ffo-m{max-width:86%;padding:10px 13px;border-radius:18px;font-size:15.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;font-weight:500}' +
    '.ffo-m.o{background:#fff;color:#0f172a;border-bottom-left-radius:6px;box-shadow:0 1px 2px rgba(15,23,42,.08)}' +
    '.ffo-m.c{align-self:flex-end;background:#16a34a;color:#fff;border-bottom-right-radius:6px}' +
    '.ffo-btns{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 4px}' +
    '.ffo-b{border:1.5px solid #16a34a;background:#fff;color:#15803d;border-radius:999px;padding:10px 14px;font:inherit;font-size:14.5px;font-weight:800;cursor:pointer;min-height:44px;text-align:left}' +
    '.ffo-b:disabled{opacity:.45}' +
    '.ffo-card{background:#fff;border-radius:18px;padding:14px;box-shadow:0 1px 2px rgba(15,23,42,.08);max-width:92%}' +
    '.ffo-card img{display:block;width:220px;max-width:100%;height:auto;margin:6px auto;border-radius:12px;border:1px solid #e2e8f0}' +
    '.ffo-amt{text-align:center;font-size:26px;font-weight:900;color:#0f172a}' +
    '.ffo-upi{display:block;text-align:center;margin-top:8px;background:#16a34a;color:#fff;border-radius:14px;padding:12px;font-weight:800;text-decoration:none}' +
    '.ffo-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #f1f5f9;font-size:14.5px}' +
    '.ffo-row span{color:#64748b;font-weight:700;flex:none}.ffo-row code{font-family:ui-monospace,monospace;font-weight:800;color:#0f172a;word-break:break-all;text-align:right}' +
    '.ffo-copy{border:0;background:#ecfdf5;color:#15803d;border-radius:10px;padding:6px 10px;font:inherit;font-size:12.5px;font-weight:800;cursor:pointer;flex:none}' +
    '.ffo-foot{display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid #e2e8f0}' +
    '.ffo-in{flex:1;min-width:0;border:1.5px solid #cbd5e1;border-radius:999px;padding:12px 16px;font:inherit;font-size:16px}' +
    '.ffo-send{border:0;background:#16a34a;color:#fff;border-radius:50%;width:48px;height:48px;font-size:20px;cursor:pointer;flex:none}' +
    '.ffo-typing{align-self:flex-start;color:#64748b;font-size:13px;font-weight:700;padding:4px 8px}' +
    '.ffo-note{font-size:12.5px;color:#92400e;background:#fffbeb;border-radius:10px;padding:8px 10px;margin-top:8px;font-weight:600}';
  function injectCss() {
    if (document.getElementById('ffo-css')) return;
    var el = document.createElement('style'); el.id = 'ffo-css'; el.textContent = css; document.head.appendChild(el);
  }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function openLink(kind) {
    var url = kind === 'helper' ? (typeof NETFLIX_HOUSEHOLD_LINK !== 'undefined' ? NETFLIX_HOUSEHOLD_LINK : '') : st.wa; // eslint-disable-line no-undef
    if (!url) url = st.wa;
    try { var w = window.open(url, '_blank'); if (w) w.opener = null; else location.href = url; } catch (e) { location.href = url; }
  }

  function openUrl(url) {
    // Only WhatsApp group / chat links come from the server (olivia.js checks them too).
    if (!/^https:\/\/(chat\.whatsapp\.com|wa\.me|api\.whatsapp\.com)\//i.test(String(url))) return;
    try { var w = window.open(url, '_blank'); if (w) w.opener = null; else location.href = url; } catch (e) { location.href = url; }
  }
  // -- "How can we help?" chooser --
  function chooser() {
    injectCss();
    if (document.querySelector('.ffo-bg')) return;
    var bg = h('div', 'ffo-bg'); bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-label', 'Help');
    var sh = h('div', 'ffo-sheet');
    sh.appendChild(h('h3', null, 'How can we help? \uD83D\uDE0A'));
    sh.appendChild(h('p', null, 'Chat with Olivia here, or message our team on WhatsApp.'));
    function opt(cls, icon, title, sub, fn) {
      var b = h('button', 'ffo-opt ' + cls); b.appendChild(h('i', null, icon));
      var d = h('div'); d.appendChild(h('b', null, title)); d.appendChild(h('span', null, sub)); b.appendChild(d);
      b.onclick = function () { close(); fn(); }; sh.appendChild(b);
    }
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); }
    opt('ai', '\uD83E\uDD16', 'Chat with Olivia', 'Buy a plan, pay, get your login \u2014 step by step', openChat);
    opt('', '\uD83D\uDCAC', 'WhatsApp our team', 'Talk to a person', function () { openLink('whatsapp'); });
    bg.onclick = function (e) { if (e.target === bg) close(); };
    bg.appendChild(sh); document.body.appendChild(bg);
  }

  // -- chat panel --
  var ui = null;
  function openChat() {
    injectCss();
    st.phone = phoneNow(); load();
    if (ui) { ui.panel.hidden = false; st.open = true; return; }
    var panel = h('div', 'ffo-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat with Olivia');
    var top = h('div', 'ffo-top'); top.appendChild(h('div', 'av', '\uD83E\uDD16'));
    var t = h('div'); t.appendChild(h('b', null, 'Olivia')); t.appendChild(h('small', null, 'FluxFilm AI assistant')); top.appendChild(t);
    var x = h('button', 'ffo-x', '\u00D7'); x.setAttribute('aria-label', 'Close chat'); x.onclick = closeChat; top.appendChild(x);
    var list = h('div', 'ffo-list'); list.setAttribute('aria-live', 'polite');
    var foot = h('form', 'ffo-foot');
    var input = h('input', 'ffo-in'); input.placeholder = 'Type a message\u2026'; input.setAttribute('aria-label', 'Message'); input.autocomplete = 'off';
    var send = h('button', 'ffo-send', '\u27A4'); send.type = 'submit'; send.setAttribute('aria-label', 'Send');
    foot.appendChild(input); foot.appendChild(send);
    foot.onsubmit = function (e) { e.preventDefault(); var v = input.value.trim(); if (!v || st.busy) return; input.value = ''; talk({ text: v }, v); };
    panel.appendChild(top); panel.appendChild(list); panel.appendChild(foot);
    document.body.appendChild(panel);
    ui = { panel: panel, list: list, input: input };
    st.open = true;
    render();
    if (!st.convId || !st.messages.length) talk({ choice: 'start', lang: st.lang }, null);
    else if (st.pollAfter) schedulePoll(st.pollAfter);
  }
  function closeChat() { if (ui) ui.panel.hidden = true; st.open = false; }

  function copyBtn(value) {
    var b = h('button', 'ffo-copy', 'Copy'); b.type = 'button';
    b.onclick = function () { try { navigator.clipboard.writeText(value); b.textContent = 'Copied \u2713'; if (window.ffSound) window.ffSound('copy'); } catch (e) {} };
    return b;
  }
  function row(label, value) {
    var r = h('div', 'ffo-row'); r.appendChild(h('span', null, label));
    var c = h('code', null, value); r.appendChild(c); r.appendChild(copyBtn(value)); return r;
  }
  function drawCard(card) {
    var c = h('div', 'ffo-card');
    if (card.type === 'pay' || card.type === 'backup') {
      c.appendChild(h('div', 'ffo-amt', '\u20B9' + card.amount));
      var img = h('img'); img.src = card.qr; img.alt = 'UPI QR code'; img.width = 220; img.height = 220; c.appendChild(img);
      if (card.type === 'backup' && card.vpa) c.appendChild(row('UPI ID', card.vpa));
      if (card.upiLink && /Android|iPhone|iPad/i.test(navigator.userAgent)) { var a = h('a', 'ffo-upi', 'Pay with UPI app'); a.href = card.upiLink; c.appendChild(a); }
    } else if (card.type === 'access') {
      (card.logins || []).forEach(function (l) {
        if ((card.logins || []).length > 1) c.appendChild(h('b', null, 'Device ' + l.device));
        if (l.user) c.appendChild(row('Login', l.user));
        if (l.pass) c.appendChild(row('Password', l.pass));
        if (l.profileName || l.profileNumber) c.appendChild(row('Profile', l.profileName || ('Profile ' + l.profileNumber)));
        if (l.profilePin) c.appendChild(row('PIN', l.profilePin));
      });
      c.appendChild(h('div', 'ffo-note', 'Please do not change the password or profile. Your login is also in your email and in My plans.'));
    } else if (card.type === 'access-hidden') {
      c.appendChild(h('div', null, '\uD83D\uDD12 Login hidden for safety \u2014 see your email or My plans.'));
    }
    return c;
  }
  function render() {
    if (!ui) return;
    var list = ui.list; list.innerHTML = '';
    st.messages.forEach(function (m, i) {
      if (m.role === 'customer') { list.appendChild(h('div', 'ffo-m c', m.text)); return; }
      list.appendChild(h('div', 'ffo-m o', m.text));
      if (m.card) list.appendChild(drawCard(m.card));
      var isLast = i === st.messages.length - 1;
      if (m.buttons && m.buttons.length && isLast) {
        var wrap = h('div', 'ffo-btns');
        m.buttons.forEach(function (b) {
          var el = h('button', 'ffo-b', b.label); el.type = 'button'; el.disabled = st.busy;
          el.onclick = function () {
            if (b.link) return openLink(b.link);
            if (b.url) return openUrl(b.url);
            if (b.id.indexOf('lang:') === 0) { st.lang = b.id.slice(5); save(); }
            talk({ choice: b.id }, b.label);
          };
          wrap.appendChild(el);
        });
        list.appendChild(wrap);
      }
    });
    var lastO = st.messages.filter(function (m) { return m.role === 'olivia'; }).pop();
    ui.input.placeholder = lastO && lastO.input === 'email' ? 'Type the email here\u2026' : lastO && lastO.input === 'name' ? 'Type the name in your UPI app\u2026' : 'Type a message\u2026';
    ui.input.type = lastO && lastO.input === 'email' ? 'email' : 'text';
    if (st.busy) list.appendChild(h('div', 'ffo-typing', 'Olivia is typing\u2026'));
    list.scrollTop = list.scrollHeight;
  }
  function schedulePoll(sec) {
    clearTimeout(st.pollTimer);
    st.pollAfter = sec;
    st.pollTimer = setTimeout(function () { if (!st.busy) talk({ choice: 'poll' }, null, true); else schedulePoll(sec); }, Math.max(3, sec) * 1000);
  }
  function talk(input, echo, silent) {
    st.phone = phoneNow();
    if (!st.phone) { st.messages.push({ role: 'olivia', text: 'Please log in first to chat with Olivia.', buttons: [] }); render(); return; }
    if (echo) st.messages.push({ role: 'customer', text: echo });
    if (!silent) { st.busy = true; render(); }
    var body = Object.assign({ conversationId: st.convId, installedApp: installed() }, input);
    call('oliviaChat', [st.phone, body]).then(function (r) {
      st.busy = false;
      if (!r || !r.ok) {
        if (!silent) st.messages.push({ role: 'olivia', text: (r && r.message) || 'Sorry, Olivia is not available right now.', buttons: [{ id: 'whatsapp', label: '\uD83D\uDCAC WhatsApp our team', link: 'whatsapp' }] });
        if (r && r.whatsappLink) st.wa = r.whatsappLink;
      } else {
        st.convId = r.conversationId; if (r.lang) st.lang = r.lang;
        (r.messages || []).forEach(function (m) { st.messages.push(m); if (m.card && m.card.type === 'access' && window.ffSound) window.ffSound('delivered'); });
        st.pollAfter = 0; clearTimeout(st.pollTimer);
        if (r.poll && r.poll.afterSec) schedulePoll(r.poll.afterSec);
      }
      save(); render();
    }).catch(function () {
      st.busy = false;
      if (silent) { schedulePoll(15); return; }
      st.messages.push({ role: 'olivia', text: 'Network problem. Please check your internet and try again.', buttons: [] });
      render();
    });
  }

  window.ffOlivia = {
    open: function () {
      refresh();
      if (!st.enabled || phoneNow() !== st.checkedFor) return false;
      chooser();
      return true;
    },
    refresh: function () { st.checkedFor = ''; refresh(); },
    _state: st,
  };
  refresh();
  window.addEventListener('storage', function () { refresh(); });
  setInterval(refresh, 15000); // no request unless the phone changed or 5 minutes passed
})();
