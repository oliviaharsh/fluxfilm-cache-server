/* FluxFilm - Olivia chat window (served at /olivia.js, loaded by index.html). Plain JS, no build step.
 *
 * window.ffOlivia.open() -> true when Olivia is on for this logged-in customer: shows "Chat with Olivia / WhatsApp us".
 *                          false -> the caller opens WhatsApp as before (index.html ffOpenHelp_).
 * Everything Olivia says and every button comes from the server (/api oliviaChat). This file only draws it.
 * A login card is kept in memory only - never saved in sessionStorage.
 *
 * Looks and feels like a WhatsApp chat: beige wallpaper, green outgoing bubbles with ticks, white incoming bubbles,
 * times, "typing..." dots before every reply (at least half a second), a soft pop when sending and a ting when
 * Olivia answers. Sounds follow the shop's own Sounds switch (Account -> Sounds, localStorage ff_sound).
 */
(function () {
  'use strict';
  if (window.ffOlivia) return;
  var API = '/api';
  var WA = 'https://wa.me/message/UWTAS2ZMVF4QJ1';
  var MIN_TYPING_MS = 500;
  var THEMES = { store: 'FluxFilm', whatsapp: 'WhatsApp' };
  function themeNow() { try { var v = localStorage.getItem('ff_olivia_theme'); return THEMES[v] ? v : 'store'; } catch (e) { return 'store'; } }
  var st = { theme: themeNow(), phone: '', enabled: false, checkedFor: '', wa: WA, convId: '', lang: '', messages: [], busy: false, typing: false, pollTimer: null, open: false };

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
    // credentials: the email-login session cookie (the server checks it matches the phone).
    return fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action, args: args }) })
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

  // -- sounds (WhatsApp-like: pop on send, ting on reply) --
  var actx = null;
  function soundOn() {
    try { if (window.ffSoundPrefs && window.ffSoundPrefs.get) return !!window.ffSoundPrefs.get('sound'); } catch (e) {}
    try { return localStorage.getItem('ff_sound') !== '0'; } catch (e) { return true; }
  }
  function audioCtx() {
    if (actx) return actx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { actx = new AC(); } catch (e) { actx = null; }
    return actx;
  }
  function blip(t, freq, dur, vol, to) {
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.03);
  }
  var SOUNDS = {
    send: function (t) { blip(t, 520, 0.09, 0.12, 900); },
    receive: function (t) { blip(t, 880, 0.12, 0.14); blip(t + 0.09, 1320, 0.16, 0.11); },
  };
  function sound(name) {
    try {
      if (!soundOn() || document.hidden || !SOUNDS[name] || !audioCtx()) return;
      var go = function () { SOUNDS[name](actx.currentTime + 0.01); };
      if (actx.state !== 'running' && actx.resume) actx.resume().then(go, function () {}); else go();
    } catch (e) {}
  }

  // -- styles --
  var css = '' +
    '.ffo-bg{position:fixed;inset:0;z-index:90;background:rgba(15,23,42,.35);display:flex;align-items:flex-end;justify-content:center;font-family:"Plus Jakarta Sans",system-ui,sans-serif}' +
    '.ffo-sheet{width:100%;max-width:440px;background:#fff;border-radius:22px 22px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -10px 40px rgba(15,23,42,.2)}' +
    '.ffo-sheet h3{margin:0 0 4px;font-size:18px;font-weight:900;color:#0f172a}.ffo-sheet p{margin:0 0 14px;color:#475569;font-size:14px;font-weight:600}' +
    '.ffo-opt{display:flex;gap:12px;align-items:center;width:100%;border:1.5px solid #e2e8f0;background:#fff;border-radius:16px;padding:14px;margin-bottom:10px;text-align:left;font:inherit;cursor:pointer;min-height:64px}' +
    '.ffo-opt b{display:block;font-size:16px;color:#0f172a}.ffo-opt div>span{display:block;font-size:13px;color:#64748b;font-weight:600}.ffo-opt i{font-style:normal;font-size:30px}' +
    '.ffo-opt.ai{border-color:#25d366;background:#f0fdf4}' +
    // WhatsApp-style chat
    '.ffo-panel{position:fixed;inset:0;bottom:auto;height:100%;height:100dvh;overscroll-behavior:contain;z-index:91;display:flex;flex-direction:column;font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background-color:#efeae2;' +
      'background-image:radial-gradient(rgba(0,0,0,.035) 1.2px,transparent 1.3px),radial-gradient(rgba(0,0,0,.025) 1px,transparent 1.1px);background-size:22px 22px,34px 34px;background-position:0 0,11px 17px}' +
    '@media(min-width:700px){.ffo-panel{inset:auto 20px 20px auto;width:400px;height:min(700px,calc(100dvh - 40px));border-radius:18px;box-shadow:0 20px 60px rgba(15,23,42,.3);overflow:hidden}}' +
    '.ffo-top{display:flex;align-items:center;gap:10px;padding:calc(8px + env(safe-area-inset-top)) 10px 8px;background:#008069;color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.15)}' +
    '.ffo-top .av{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#dcf8c6,#25d366);display:grid;place-items:center;font-size:23px;flex:none;overflow:hidden}' +
    '.ffo-top .av img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.ffo-ai{display:inline-block;vertical-align:2px;margin-left:6px;padding:1px 6px;border-radius:6px;font-size:10.5px;font-weight:800;letter-spacing:.06em;line-height:1.5;background:#d9fdd3;color:#005c4b}' +
    '.ffo-opt .av{width:48px;height:48px;border-radius:50%;overflow:hidden;flex:none;display:grid;place-items:center;font-size:28px;background:#dcf8c6}.ffo-opt .av img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.ffo-top b{display:block;font-size:17px;font-weight:600}.ffo-top small{display:block;font-size:12.5px;color:#d9fdd3;font-weight:500;min-height:16px}' +
    '.ffo-x{margin-left:auto;border:0;background:rgba(255,255,255,.14);color:#fff;width:40px;height:40px;border-radius:50%;font-size:24px;line-height:1;cursor:pointer}' +
    '.ffo-list{flex:1;overflow-y:auto;padding:10px 12px 14px;display:flex;flex-direction:column;gap:3px}' +
    '.ffo-day{align-self:center;background:#fff;color:#54656f;font-size:12px;font-weight:600;border-radius:8px;padding:5px 12px;margin:4px 0 8px;box-shadow:0 1px .5px rgba(11,20,26,.13);text-transform:uppercase}' +
    '.ffo-m{position:relative;max-width:84%;padding:6px 9px 18px;border-radius:8px;font-size:15.5px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;color:#111b21;box-shadow:0 1px .5px rgba(11,20,26,.13);margin-top:6px;min-width:84px}' +
    '.ffo-m.o{align-self:flex-start;background:#fff;border-top-left-radius:0}' +
    '.ffo-m.o::before{content:"";position:absolute;top:0;left:-8px;border-top:8px solid #fff;border-left:8px solid transparent}' +
    '.ffo-m.c{align-self:flex-end;background:#d9fdd3;border-top-right-radius:0}' +
    '.ffo-m.c::before{content:"";position:absolute;top:0;right:-8px;border-top:8px solid #d9fdd3;border-right:8px solid transparent}' +
    '.ffo-m.cont{margin-top:1px;border-radius:8px}.ffo-m.cont::before{display:none}' +
    '.ffo-meta{position:absolute;right:8px;bottom:3px;font-size:11px;color:#667781;white-space:nowrap;display:flex;gap:3px;align-items:center}' +
    '.ffo-tick{font-size:13px;letter-spacing:-4px;color:#8696a0;padding-right:4px}.ffo-tick.read{color:#53bdeb}' +
    '.ffo-typing{align-self:flex-start;position:relative;background:#fff;border-radius:8px;border-top-left-radius:0;padding:12px 14px;margin-top:6px;box-shadow:0 1px .5px rgba(11,20,26,.13);display:flex;gap:4px}' +
    '.ffo-typing::before{content:"";position:absolute;top:0;left:-8px;border-top:8px solid #fff;border-left:8px solid transparent}' +
    '.ffo-typing i{width:7px;height:7px;border-radius:50%;background:#8696a0;display:block;animation:ffoDot 1.2s infinite ease-in-out}' +
    '.ffo-typing i:nth-child(2){animation-delay:.15s}.ffo-typing i:nth-child(3){animation-delay:.3s}' +
    '@keyframes ffoDot{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-4px);opacity:1}}' +
    '@keyframes ffoIn{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}' +
    '.ffo-new{animation:ffoIn .18s ease-out both}' +
    '@media (prefers-reduced-motion: reduce){.ffo-typing i,.ffo-new{animation:none}}' +
    // WhatsApp Business style reply buttons: white boxes under the message
    '.ffo-btns{align-self:flex-start;display:flex;flex-direction:column;gap:3px;margin:3px 0 4px;width:84%;max-width:320px}' +
    '.ffo-b{border:0;background:#fff;color:#008069;border-radius:8px;padding:11px 12px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;min-height:44px;text-align:center;box-shadow:0 1px .5px rgba(11,20,26,.13)}' +
    '.ffo-b:active{background:#f0f2f5}.ffo-b:disabled{opacity:.5}' +
    '.ffo-card{align-self:flex-start;position:relative;background:#fff;border-radius:8px;padding:10px 12px;box-shadow:0 1px .5px rgba(11,20,26,.13);max-width:84%;margin-top:3px}' +
    '.ffo-card img{display:block;width:220px;max-width:100%;height:auto;margin:6px auto;border-radius:6px;border:1px solid #e9edef}' +
    '.ffo-amt{text-align:center;font-size:26px;font-weight:800;color:#111b21}' +
    '.ffo-upi{display:block;text-align:center;margin-top:8px;background:#00a884;color:#fff;border-radius:20px;padding:11px;font-weight:700;text-decoration:none}' +
    '.ffo-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #f0f2f5;font-size:14.5px}' +
    '.ffo-row span{color:#667781;font-weight:600;flex:none}.ffo-row code{font-family:ui-monospace,monospace;font-weight:700;color:#111b21;word-break:break-all;text-align:right}' +
    '.ffo-copy{border:0;background:#e7fce3;color:#008069;border-radius:10px;padding:6px 10px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;flex:none}' +
    '.ffo-foot{display:flex;gap:6px;align-items:center;padding:6px 8px calc(8px + env(safe-area-inset-bottom));background:transparent}' +
    '.ffo-in{flex:1;min-width:0;border:0;border-radius:24px;padding:13px 16px;font:inherit;font-size:16px;background:#fff;color:#111b21;box-shadow:0 1px .5px rgba(11,20,26,.13);outline:none}' +
    '.ffo-send{border:0;background:#00a884;color:#fff;border-radius:50%;width:48px;height:48px;cursor:pointer;flex:none;display:grid;place-items:center;box-shadow:0 1px 2px rgba(11,20,26,.2)}' +
    '.ffo-send svg{width:22px;height:22px;margin-left:3px}' +
    '.ffo-note{font-size:12.5px;color:#92400e;background:#fffbeb;border-radius:8px;padding:8px 10px;margin-top:8px;font-weight:600}' +
    // The panel is display:flex, which would beat the [hidden] attribute: without this the close button did nothing.
    '.ffo-more{margin-left:auto;font-size:22px}.ffo-more+.ffo-x{margin-left:4px}' +
    '.ffo-top{position:relative}.ffo-menu{position:absolute;right:52px;top:calc(52px + env(safe-area-inset-top));background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(11,20,26,.25);padding:6px 0;z-index:5;min-width:180px}' +
    '.ffo-menu button{display:block;width:100%;border:0;background:none;text-align:left;padding:12px 16px;font:inherit;font-size:15px;color:#111b21;cursor:pointer}.ffo-menu button:hover{background:#f0f2f5}' +
    '.ffo-viewbar{display:flex;align-items:center;gap:10px;margin:2px 0 8px}.ffo-viewbar b{font-size:16px;color:#111b21}' +
    '.ffo-back{border:0;background:#fff;color:#008069;border-radius:18px;padding:8px 12px;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 1px .5px rgba(11,20,26,.13)}' +
    '.ffo-hist{display:flex;flex-direction:column;gap:3px;width:100%;border:0;background:#fff;border-radius:10px;padding:11px 12px;margin-top:6px;text-align:left;font:inherit;cursor:pointer;box-shadow:0 1px .5px rgba(11,20,26,.13)}' +
    '.ffo-hist-top{display:flex;justify-content:space-between;align-items:center;gap:8px}.ffo-hist-top b{font-size:14.5px;color:#111b21}' +
    '.ffo-hist-prev{font-size:14px;color:#667781;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}' +
    '.ffo-chip{font-size:11.5px;font-weight:700;border-radius:10px;padding:2px 8px;background:#fff4e5;color:#9a5b00}.ffo-chip.done{background:#e7fce3;color:#00745f}' +
    '.ffo-empty{align-self:center;text-align:center;color:#54656f;background:#fff;border-radius:10px;padding:14px 16px;margin-top:20px;max-width:280px;font-size:14px}' +
    '.ffo-continue{align-self:center;margin:14px 0 6px;width:auto;padding:11px 18px}' +
    '.ffo-m b{font-weight:700}' +
    '.ffo-who{display:flex;align-items:center;gap:10px;border:0;background:none;color:inherit;font:inherit;text-align:left;padding:2px 6px 2px 0;border-radius:24px;cursor:pointer;min-width:0}.ffo-who:active{background:rgba(255,255,255,.12)}' +
    '.ffo-who:focus-visible,.ffo-pact:focus-visible,.ffo-pchip:focus-visible,.ffo-pwa:focus-visible{outline:2px solid #53bdeb;outline-offset:2px}' +
    '.ffo-plist{background:#f0f2f5;gap:10px}' +
    '.ffo-prof{background:#fff;border-radius:12px;padding:20px 16px 14px;display:flex;flex-direction:column;align-items:center;text-align:center;box-shadow:0 1px .5px rgba(11,20,26,.13)}' +
    '.ffo-pav{width:132px;height:132px;border-radius:50%;overflow:hidden;display:grid;place-items:center;font-size:64px;background:linear-gradient(135deg,#dcf8c6,#25d366);margin-bottom:12px}.ffo-pav img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.ffo-pname{font-size:22px;font-weight:600;color:#111b21}.ffo-prole{font-size:15px;color:#667781;margin-top:2px}.ffo-ponline{font-size:13px;color:#00a884;margin-top:4px;font-weight:600}' +
    '.ffo-pacts{display:flex;gap:10px;margin-top:16px;width:100%;justify-content:center}' +
    '.ffo-pact{flex:1;max-width:104px;border:1px solid #e9edef;background:#fff;border-radius:12px;padding:10px 4px;font:inherit;color:#008069;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px}.ffo-pact i{font-style:normal;font-size:22px}.ffo-pact span{font-size:13px;font-weight:600}.ffo-pact:active{background:#f0f2f5}' +
    '.ffo-psec{background:#fff;border-radius:12px;padding:12px 16px;box-shadow:0 1px .5px rgba(11,20,26,.13)}' +
    '.ffo-plabel{font-size:13.5px;color:#008069;font-weight:600;margin-bottom:6px}.ffo-pabout{font-size:15.5px;line-height:1.45;color:#111b21}' +
    '.ffo-pline{display:flex;gap:14px;align-items:flex-start;padding:10px 0;border-top:1px solid #f0f2f5}.ffo-pline:first-child{border-top:0;padding-top:2px}' +
    '.ffo-pline i{font-style:normal;font-size:20px;width:26px;text-align:center;flex:none}.ffo-pline b{display:block;font-size:15.5px;font-weight:600;color:#111b21}.ffo-pline span{display:block;font-size:14px;color:#667781;line-height:1.4}' +
    '.ffo-pchips{display:flex;gap:8px;flex-wrap:wrap}.ffo-pchip{border:1px solid #d1d7db;background:#fff;color:#111b21;border-radius:18px;padding:8px 14px;font:inherit;font-size:14.5px;cursor:pointer}.ffo-pchip.on{background:#d9fdd3;border-color:#00a884;color:#005c4b;font-weight:600}' +
    '.ffo-pwa{border:0;background:#fff;color:#008069;border-radius:12px;padding:14px;font:inherit;font-size:15.5px;font-weight:600;cursor:pointer;box-shadow:0 1px .5px rgba(11,20,26,.13);margin-bottom:8px}' +
    // FluxFilm store style (default): the shop's white cards, slate text and green buttons. WhatsApp style = no class.
    '.ffo-panel.t-store{background:#f1f5f9;background-image:linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%)}' +
    '.t-store .ffo-top{background:#fff;color:#0f172a;box-shadow:0 1px 0 rgba(15,23,42,.08)}.t-store .ffo-top b{font-weight:800}.t-store .ffo-top small{color:#16a34a;font-weight:700}' +
    '.t-store .ffo-top .av{background:linear-gradient(135deg,#dcfce7,#22c55e);box-shadow:0 0 0 2px #fff,0 0 0 3.5px #86efac}' +
    '.t-store .ffo-x{background:#f1f5f9;color:#334155}.t-store .ffo-who:active{background:#f1f5f9}.t-store .ffo-ai{background:#dcfce7;color:#15803d}' +
    '.t-store .ffo-day{background:#e2e8f0;color:#475569;box-shadow:none;border-radius:999px;font-weight:700;text-transform:none;letter-spacing:.01em}' +
    '.t-store .ffo-m{border-radius:18px;padding:9px 13px 21px;line-height:1.5;color:#0f172a;box-shadow:0 2px 8px rgba(15,23,42,.06)}.t-store .ffo-m::before{display:none}' +
    '.t-store .ffo-m.o{background:#fff;border:1px solid rgba(15,23,42,.06);border-top-left-radius:6px}' +
    '.t-store .ffo-m.c{background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;border-top-right-radius:6px;box-shadow:0 4px 12px rgba(34,197,94,.25)}' +
    '.t-store .ffo-m.cont{border-radius:18px}.t-store .ffo-m b{font-weight:800}.t-store .ffo-meta{color:#94a3b8}' +
    '.t-store .ffo-m.c .ffo-meta,.t-store .ffo-m.c .ffo-tick,.t-store .ffo-m.c .ffo-tick.read{color:rgba(255,255,255,.9)}' +
    '.t-store .ffo-typing{border-radius:18px;border-top-left-radius:6px;border:1px solid rgba(15,23,42,.06);box-shadow:0 2px 8px rgba(15,23,42,.06)}.t-store .ffo-typing::before{display:none}.t-store .ffo-typing i{background:#94a3b8}' +
    '.t-store .ffo-btns{gap:8px;margin:8px 0 6px}' +
    '.t-store .ffo-b{border:1.5px solid #e2e8f0;border-radius:14px;color:#0f172a;font-weight:700;box-shadow:0 1px 2px rgba(15,23,42,.04)}.t-store .ffo-b:active{background:#f0fdf4;border-color:#86efac}' +
    '.t-store .ffo-card{border-radius:18px;border:1px solid rgba(15,23,42,.06);box-shadow:0 2px 8px rgba(15,23,42,.06)}.t-store .ffo-amt{font-weight:800}' +
    '.t-store .ffo-upi{background:linear-gradient(135deg,#16a34a,#22c55e);border-radius:14px;font-weight:800}.t-store .ffo-copy{background:#f0fdf4;color:#15803d}' +
    '.t-store .ffo-foot{background:#fff;border-top:1px solid #e2e8f0;padding-top:8px}' +
    '.t-store .ffo-in{background:#f8fafc;border:1.5px solid #e2e8f0;box-shadow:none;font-weight:500}.t-store .ffo-in:focus{border-color:#22c55e;background:#fff}' +
    '.t-store .ffo-send{background:linear-gradient(135deg,#16a34a,#22c55e);box-shadow:0 6px 16px rgba(34,197,94,.35)}' +
    '.t-store .ffo-menu{border-radius:16px;border:1px solid rgba(15,23,42,.08)}.t-store .ffo-menu button{color:#0f172a;font-weight:600}' +
    '.t-store .ffo-back{color:#15803d;border:1px solid #e2e8f0;box-shadow:none;border-radius:999px}.t-store .ffo-viewbar b{font-weight:800;color:#0f172a}' +
    '.t-store .ffo-hist,.t-store .ffo-empty{border-radius:18px;border:1px solid rgba(15,23,42,.06);box-shadow:0 2px 8px rgba(15,23,42,.05)}.t-store .ffo-chip.done{background:#dcfce7;color:#15803d}' +
    '.t-store .ffo-plist{background:transparent}' +
    '.t-store .ffo-prof,.t-store .ffo-psec,.t-store .ffo-pwa{border-radius:22px;border:1px solid rgba(15,23,42,.06);box-shadow:0 2px 10px rgba(15,23,42,.05)}' +
    '.t-store .ffo-pname{font-weight:800}.t-store .ffo-ponline{color:#16a34a}.t-store .ffo-plabel{color:#15803d;font-weight:800}' +
    '.t-store .ffo-pact{border-radius:16px;color:#15803d;font-weight:700}.t-store .ffo-pchip{font-weight:600}.t-store .ffo-pchip.on{background:#dcfce7;border-color:#22c55e;color:#15803d}.t-store .ffo-pwa{color:#15803d;font-weight:800}' +
    // Chat style picker (profile)
    '.ffo-styles{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '.ffo-style{border:2px solid #e2e8f0;background:#fff;border-radius:16px;padding:8px;font:inherit;cursor:pointer;text-align:left;display:flex;flex-direction:column;gap:6px}' +
    '.ffo-style.on{border-color:#22c55e;box-shadow:0 0 0 3px #dcfce7}.ffo-style>b{font-size:14px;color:#0f172a;display:flex;justify-content:space-between;align-items:center}.ffo-style>b i{font-style:normal;color:#16a34a}' +
    '.ffo-mini{border-radius:10px;height:66px;padding:0 0 6px;display:flex;flex-direction:column;gap:4px;overflow:hidden}' +
    '.ffo-mini s{display:block;height:12px;flex:none}.ffo-mini u{display:block;height:12px;border-radius:7px;width:58%;margin:0 7px}.ffo-mini u+u{align-self:flex-end;width:48%}' +
    '.ffo-mini.store{background:#f1f5f9}.ffo-mini.store s{background:#fff;border-bottom:1px solid #e2e8f0}.ffo-mini.store u{background:#fff;border:1px solid #e2e8f0}.ffo-mini.store u+u{background:linear-gradient(135deg,#16a34a,#22c55e);border:0}' +
    '.ffo-mini.wa{background:#efeae2}.ffo-mini.wa s{background:#008069}.ffo-mini.wa u{background:#fff;border-radius:4px}.ffo-mini.wa u+u{background:#d9fdd3}' +
    // Full photo
    '.ffo-pav{cursor:zoom-in;border:0;padding:0}' +
    '.ffo-photo{position:fixed;inset:0;z-index:95;background:#0b141a;display:flex;flex-direction:column;font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,sans-serif;color:#fff}' +
    '.ffo-photo-top{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 12px 10px}.ffo-photo-top b{font-size:17px;font-weight:700;flex:1}' +
    '.ffo-photo-top button{border:0;background:rgba(255,255,255,.12);color:#fff;width:42px;height:42px;border-radius:50%;font-size:24px;line-height:1;cursor:pointer}' +
    '.ffo-photo-img{flex:1;min-height:0;display:grid;place-items:center;padding:12px}.ffo-photo-img img{max-width:100%;max-height:100%;width:auto;height:auto;border-radius:12px;display:block}' +
    '.ffo-photo-cap{text-align:center;font-size:13px;color:#aebac1;padding:6px 16px calc(18px + env(safe-area-inset-bottom))}' +
    '.ffo-photo[hidden]{display:none!important}' +
    '.ffo-menu[hidden],.ffo-foot[hidden]{display:none!important}' +
    '.ffo-panel[hidden],.ffo-bg[hidden]{display:none!important}';
  function injectCss() {
    if (document.getElementById('ffo-css')) return;
    var el = document.createElement('style'); el.id = 'ffo-css'; el.textContent = css; document.head.appendChild(el);
  }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function openLink(kind, btn) {
    if (kind === 'buysite') { closeChat(); if (typeof window.ffGoBuy === 'function') { try { window.ffGoBuy((btn && btn.service) || ''); } catch (e) {} } return; }
    if (kind === 'myplans') { closeChat(); if (typeof window.ffGoMyPlans === 'function') { try { window.ffGoMyPlans(); } catch (e) {} } return; }
    var url = kind === 'helper' ? (typeof NETFLIX_HOUSEHOLD_LINK !== 'undefined' ? NETFLIX_HOUSEHOLD_LINK : '') : st.wa; // eslint-disable-line no-undef
    if (!url) url = st.wa;
    try { var w = window.open(url, '_blank'); if (w) w.opener = null; else location.href = url; } catch (e) { location.href = url; }
  }
  function openUrl(url) {
    // Only WhatsApp group / chat links come from the server (olivia.js checks them too).
    if (!/^https:\/\/(chat\.whatsapp\.com|wa\.me|api\.whatsapp\.com)\//i.test(String(url))) return;
    try { var w = window.open(url, '_blank'); if (w) w.opener = null; else location.href = url; } catch (e) { location.href = url; }
  }
  // Olivia's photo (AI-generated, 256 px, ~12 KB). If it cannot load, the robot emoji stays.
  var AVATAR = '/olivia-avatar.jpg?v=1';
  var PHOTO = '/olivia-photo.jpg?v=1';
  function avatarEl(size) {
    var box = h('div', 'av' + (size === 'big' ? ' big' : ''), '\uD83E\uDD16');
    var img = h('img'); img.alt = 'Olivia'; img.width = 84; img.height = 84; img.decoding = 'async';
    img.onload = function () { box.textContent = ''; box.appendChild(img); };
    img.src = AVATAR;
    return box;
  }
  // She looks like a real person, so customers are always told she is an AI assistant.
  function aiTag() { var t = h('span', 'ffo-ai', 'AI'); t.title = 'Olivia is an AI assistant'; return t; }
  function timeText(at) {
    var d = new Date(at || Date.now());
    var hh = d.getHours(), mm = d.getMinutes();
    return ((hh % 12) || 12) + ':' + (mm < 10 ? '0' : '') + mm + ' ' + (hh < 12 ? 'am' : 'pm');
  }

  // -- "How can we help?" chooser --
  function chooser() {
    injectCss();
    if (document.querySelector('.ffo-bg')) return;
    var bg = h('div', 'ffo-bg'); bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-label', 'Help');
    var sh = h('div', 'ffo-sheet');
    sh.appendChild(h('h3', null, 'How can we help? \uD83D\uDE0A'));
    sh.appendChild(h('p', null, 'Chat with Olivia here, or message our team on WhatsApp.'));
    function opt(cls, icon, title, sub, fn, tag) {
      var b = h('button', 'ffo-opt ' + cls); b.appendChild(typeof icon === 'string' ? h('i', null, icon) : icon);
      var name = h('b', null, title); if (tag) name.appendChild(aiTag());
      var d = h('div'); d.appendChild(name); d.appendChild(h('span', null, sub)); b.appendChild(d);
      b.onclick = function () { close(); fn(); }; sh.appendChild(b);
    }
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); }
    opt('ai', avatarEl('big'), 'Chat with Olivia', 'Our AI assistant: buy a plan, pay, get your login \u2014 step by step', openChat, true);
    opt('', '\uD83D\uDCAC', 'WhatsApp our team', 'Talk to a person', function () { openLink('whatsapp'); });
    bg.onclick = function (e) { if (e.target === bg) close(); };
    bg.appendChild(sh); document.body.appendChild(bg);
  }

  // -- chat panel --
  var ui = null;
  function openChat() {
    injectCss();
    st.phone = phoneNow(); load();
    audioCtx(); // opened by a tap: the browser now allows the reply sounds
    if (ui) { ui.panel.hidden = false; st.open = true; render(); return; }
    var panel = h('div', 'ffo-panel' + (st.theme === 'store' ? ' t-store' : '')); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat with Olivia');
    var top = h('div', 'ffo-top');
    var who = h('button', 'ffo-who'); who.type = 'button'; who.setAttribute('aria-label', 'Open Olivia\'s profile');
    who.appendChild(avatarEl());
    var name = h('b', null, 'Olivia'); name.appendChild(aiTag());
    var t = h('div'); t.appendChild(name); var sub = h('small', null, 'online'); t.appendChild(sub); who.appendChild(t);
    who.onclick = function (e) { e.stopPropagation(); menu.hidden = true; openProfile(); };
    top.appendChild(who);
    var more = h('button', 'ffo-x ffo-more', '\u22EE'); more.setAttribute('aria-label', 'Chat menu'); more.onclick = function (e) { e.stopPropagation(); toggleMenu(); }; top.appendChild(more);
    var x = h('button', 'ffo-x', '\u00D7'); x.setAttribute('aria-label', 'Close chat'); x.onclick = closeChat; top.appendChild(x);
    var menu = h('div', 'ffo-menu'); menu.hidden = true;
    var m1 = h('button', null, '\uD83D\uDDC2\uFE0F Past chats'); m1.type = 'button'; m1.onclick = function () { menu.hidden = true; openHistory(); };
    var m2 = h('button', null, '\u270F\uFE0F New chat'); m2.type = 'button'; m2.onclick = function () { menu.hidden = true; newChat(); };
    var m0 = h('button', null, '\uD83D\uDC64 Olivia\'s profile'); m0.type = 'button'; m0.onclick = function () { menu.hidden = true; openProfile(); };
    menu.appendChild(m0); menu.appendChild(m1); menu.appendChild(m2); top.appendChild(menu);
    var list = h('div', 'ffo-list'); list.setAttribute('aria-live', 'polite');
    var foot = h('form', 'ffo-foot');
    var input = h('input', 'ffo-in'); input.placeholder = 'Message'; input.setAttribute('aria-label', 'Message'); input.autocomplete = 'off';
    var send = h('button', 'ffo-send'); send.type = 'submit'; send.setAttribute('aria-label', 'Send');
    send.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.9 21.1 23 12 1.9 2.9 1.9 10l15 2-15 2z"/></svg>';
    foot.appendChild(input); foot.appendChild(send);
    foot.onsubmit = function (e) { e.preventDefault(); var v = input.value.trim(); if (!v || st.busy) return; input.value = ''; talk({ text: v }, v); };
    panel.appendChild(top); panel.appendChild(list); panel.appendChild(foot);
    panel.addEventListener('click', function () { menu.hidden = true; });
    document.body.appendChild(panel);
    ui = { panel: panel, list: list, input: input, sub: sub, menu: menu, foot: foot };
    input.addEventListener('focus', function () { setTimeout(fitToKeyboard, 60); setTimeout(fitToKeyboard, 350); });
    input.addEventListener('blur', function () { setTimeout(fitToKeyboard, 350); });
    st.open = true;
    render();
    if (!st.convId || !st.messages.length) talk({ choice: 'start', lang: st.lang }, null);
    else if (st.pollAfter) schedulePoll(st.pollAfter);
  }
  function closeChat() { if (ui) ui.panel.hidden = true; st.open = false; }
  function toggleMenu() { if (ui) ui.menu.hidden = !ui.menu.hidden; }
  function newChat() {
    clearTimeout(st.pollTimer); st.pollAfter = 0;
    st.view = 'chat'; st.convId = ''; st.messages = []; st.busy = false; st.typing = false;
    save(); render();
    talk({ choice: 'start', lang: st.lang }, null);
  }
  function dateText(at) {
    var d = new Date(at || Date.now());
    if (isNaN(d.getTime())) return '';
    var today = new Date(); var y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today, ' + timeText(d);
    if (d.toDateString() === y.toDateString()) return 'Yesterday, ' + timeText(d);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + timeText(d);
  }
  /** "Past chats": the customer's own earlier chats with Olivia (newest first). */
  function openHistory() {
    st.view = 'history'; st.history = null; render();
    call('oliviaHistory', [phoneNow()]).then(function (r) { st.history = (r && r.ok && r.chats) || []; if (st.view === 'history') render(); })
      .catch(function () { st.history = []; if (st.view === 'history') render(); });
  }
  function openPast(id) {
    st.view = 'past'; st.past = null; render();
    call('oliviaTranscript', [phoneNow(), id]).then(function (r) { st.past = r && r.ok ? r : { messages: [], error: true }; if (st.view === 'past') render(); })
      .catch(function () { st.past = { messages: [], error: true }; if (st.view === 'past') render(); });
  }
  function continuePast() {
    if (!st.past || !st.past.id) return;
    clearTimeout(st.pollTimer); st.pollAfter = 0;
    st.convId = st.past.id;
    st.messages = (st.past.messages || []).map(function (m) { return { role: m.role, text: m.text, at: m.at, read: true }; });
    st.view = 'chat'; save(); render();
  }
  /** WhatsApp-style contact info: who Olivia is, what she can do, and that she is an AI. */
  function openProfile() { st.view = 'profile'; render(); }
  function renderProfile(list) {
    list.appendChild(viewBar('Profile', function () { st.view = 'chat'; render(); }));
    var head = h('div', 'ffo-prof');
    var big = avatarEl(); big.className = 'av ffo-pav'; big.setAttribute('role', 'button'); big.tabIndex = 0; big.setAttribute('aria-label', 'See Olivia\'s photo');
    big.onclick = openPhoto; big.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPhoto(); } };
    head.appendChild(big);
    var nm = h('div', 'ffo-pname', 'Olivia'); nm.appendChild(aiTag()); head.appendChild(nm);
    head.appendChild(h('div', 'ffo-prole', 'FluxFilm store assistant'));
    head.appendChild(h('div', 'ffo-ponline', '\u25CF online'));
    var acts = h('div', 'ffo-pacts');
    function act(icon, label, fn) {
      var b = h('button', 'ffo-pact'); b.type = 'button'; b.appendChild(h('i', null, icon)); b.appendChild(h('span', null, label)); b.onclick = fn; acts.appendChild(b);
    }
    act('\uD83D\uDCAC', 'Chat', function () { st.view = 'chat'; render(); });
    act('\uD83D\uDDC2\uFE0F', 'Past chats', openHistory);
    act('\u270F\uFE0F', 'New chat', newChat);
    head.appendChild(acts);
    list.appendChild(head);

    var about = h('div', 'ffo-psec');
    about.appendChild(h('div', 'ffo-plabel', 'About'));
    about.appendChild(h('div', 'ffo-pabout', 'Hi! I am Olivia, FluxFilm\'s AI assistant \uD83D\uDE0A I help you buy a plan, pay, renew and find your login \u2014 step by step, any time of the day.'));
    list.appendChild(about);

    var info = h('div', 'ffo-psec');
    function line(icon, title, text) {
      var r = h('div', 'ffo-pline'); r.appendChild(h('i', null, icon));
      var d = h('div'); d.appendChild(h('b', null, title)); d.appendChild(h('span', null, text)); r.appendChild(d); info.appendChild(r);
    }
    line('\uD83D\uDED2', 'What I can do', 'Buy a plan \u00B7 Pay by UPI \u00B7 Renew \u00B7 Coupons \u00B7 Find your login');
    line('\u26A1', 'Replies in seconds', 'Any time, day or night');
    line('\uD83D\uDD12', 'Safe and honest', 'Prices, payments and logins come straight from the FluxFilm shop. I never make them up.');
    line('\uD83E\uDD16', 'I am an AI', 'Not a person. For anything tricky, our team is on WhatsApp.');
    list.appendChild(info);

    var langs = h('div', 'ffo-psec');
    langs.appendChild(h('div', 'ffo-plabel', 'Chat language'));
    var chips = h('div', 'ffo-pchips');
    [['en', 'English'], ['hinglish', 'Hinglish'], ['hi', '\u0939\u093F\u0902\u0926\u0940']].forEach(function (l) {
      var c = h('button', 'ffo-pchip' + (st.lang === l[0] ? ' on' : ''), l[1]); c.type = 'button';
      c.onclick = function () { st.lang = l[0]; save(); st.view = 'chat'; render(); talk({ choice: 'lang:' + l[0] }, l[1]); };
      chips.appendChild(c);
    });
    langs.appendChild(chips);
    list.appendChild(langs);

    var look = h('div', 'ffo-psec');
    look.appendChild(h('div', 'ffo-plabel', 'Chat style'));
    var grid = h('div', 'ffo-styles');
    ['store', 'whatsapp'].forEach(function (k) {
      var b = h('button', 'ffo-style' + (st.theme === k ? ' on' : '')); b.type = 'button'; b.setAttribute('aria-pressed', st.theme === k ? 'true' : 'false');
      var mini = h('span', 'ffo-mini ' + (k === 'store' ? 'store' : 'wa')); mini.appendChild(h('s')); mini.appendChild(h('u')); mini.appendChild(h('u'));
      b.appendChild(mini);
      var lbl = h('b', null, THEMES[k]); if (st.theme === k) lbl.appendChild(h('i', null, '\u2713')); b.appendChild(lbl);
      b.onclick = function () { setTheme(k); };
      grid.appendChild(b);
    });
    look.appendChild(grid);
    list.appendChild(look);

    var wa = h('button', 'ffo-pwa', '\uD83D\uDCAC WhatsApp our team'); wa.type = 'button'; wa.onclick = function () { openLink('whatsapp'); };
    list.appendChild(wa);
  }
  function setTheme(k) {
    st.theme = THEMES[k] ? k : 'store';
    try { localStorage.setItem('ff_olivia_theme', st.theme); } catch (e) {}
    if (ui) ui.panel.className = 'ffo-panel' + (st.theme === 'store' ? ' t-store' : '');
    render();
  }
  /** Olivia's photo, full size (tap anywhere, the close button or Esc to go back). */
  var photoEl = null;
  function openPhoto() {
    if (!photoEl) {
      photoEl = h('div', 'ffo-photo'); photoEl.setAttribute('role', 'dialog'); photoEl.setAttribute('aria-label', 'Olivia\'s photo');
      var bar = h('div', 'ffo-photo-top');
      var nm = h('b', null, 'Olivia'); nm.appendChild(aiTag()); bar.appendChild(nm);
      var x = h('button', null, '\u00D7'); x.type = 'button'; x.setAttribute('aria-label', 'Close photo'); bar.appendChild(x);
      var box = h('div', 'ffo-photo-img');
      var img = h('img'); img.alt = 'Olivia, FluxFilm AI assistant'; img.src = AVATAR;
      var full = new Image(); full.onload = function () { img.src = full.src; }; full.src = PHOTO;
      box.appendChild(img);
      photoEl.appendChild(bar); photoEl.appendChild(box);
      photoEl.appendChild(h('div', 'ffo-photo-cap', 'AI-generated photo \u00B7 Olivia is FluxFilm\'s AI assistant'));
      photoEl.onclick = closePhoto;
      document.body.appendChild(photoEl);
    }
    photoEl.hidden = false;
  }
  function closePhoto() { if (photoEl) photoEl.hidden = true; }
  function viewBar(title, onBack) {
    var bar = h('div', 'ffo-viewbar');
    var back = h('button', 'ffo-back', '\u2190 Back'); back.type = 'button'; back.onclick = onBack;
    bar.appendChild(back); bar.appendChild(h('b', null, title));
    return bar;
  }
  function renderHistory(list) {
    list.appendChild(viewBar('Past chats', function () { st.view = 'chat'; render(); }));
    if (!st.history) { list.appendChild(h('div', 'ffo-day', 'Loading\u2026')); return; }
    if (!st.history.length) { list.appendChild(h('div', 'ffo-empty', 'No past chats yet. Your chats with Olivia will show up here.')); return; }
    st.history.forEach(function (c) {
      var item = h('button', 'ffo-hist'); item.type = 'button';
      var row1 = h('span', 'ffo-hist-top');
      row1.appendChild(h('b', null, dateText(c.updatedAt)));
      row1.appendChild(h('span', 'ffo-chip' + (c.status === 'DONE' ? ' done' : ''), c.status === 'DONE' ? '\u2713 Done' : (c.id === st.convId ? 'Current' : 'Open')));
      item.appendChild(row1);
      item.appendChild(h('span', 'ffo-hist-prev', c.preview || (c.turns + ' messages')));
      item.onclick = function () { openPast(c.id); };
      list.appendChild(item);
    });
  }
  function renderPast(list) {
    list.appendChild(viewBar('Past chat', function () { openHistory(); }));
    if (!st.past) { list.appendChild(h('div', 'ffo-day', 'Loading\u2026')); return; }
    if (st.past.error) { list.appendChild(h('div', 'ffo-empty', 'This chat could not be opened. Please try again.')); return; }
    var lastDay = '';
    st.past.messages.forEach(function (m, i) {
      var day = new Date(m.at).toDateString();
      if (day !== lastDay) { list.appendChild(h('div', 'ffo-day', dateText(m.at).split(',')[0])); lastDay = day; }
      list.appendChild(bubble(Object.assign({ read: true }, m), st.past.messages[i - 1]));
    });
    var go = h('button', 'ffo-b ffo-continue', '\uD83D\uDCAC Continue this chat'); go.type = 'button'; go.onclick = continuePast;
    list.appendChild(go);
  }
  // Phone keyboards shrink only the *visual* viewport: size the chat to it, so the header stays on top, the typing bar
  // sits right above the keyboard and the last messages stay visible (before: the page scrolled and hid them).
  function fitToKeyboard() {
    if (!ui || !st.open) return;
    var vv = window.visualViewport;
    if (!vv || window.innerWidth >= 700) { ui.panel.style.height = ''; ui.panel.style.top = ''; return; }
    ui.panel.style.top = vv.offsetTop + 'px';
    ui.panel.style.height = vv.height + 'px';
    ui.list.scrollTop = ui.list.scrollHeight;
  }
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitToKeyboard); window.visualViewport.addEventListener('scroll', fitToKeyboard); }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (photoEl && !photoEl.hidden) return closePhoto();
    if (st.open) closeChat();
  });

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
  /** WhatsApp formatting: *bold* becomes bold. Built from text nodes, so nothing in a message can become HTML. */
  function richText(el, text) {
    String(text || '').split(/(\*[^*\n]{1,120}\*)/).forEach(function (part) {
      if (/^\*[^*\n]+\*$/.test(part)) el.appendChild(h('b', null, part.slice(1, -1)));
      else if (part) el.appendChild(document.createTextNode(part));
    });
  }
  function bubble(m, prev) {
    var mine = m.role === 'customer';
    var cont = prev && prev.role === m.role;
    var b = h('div', 'ffo-m ' + (mine ? 'c' : 'o') + (cont ? ' cont' : '') + (m.fresh ? ' ffo-new' : ''), mine ? m.text : null);
    if (!mine) richText(b, m.text);
    var meta = h('span', 'ffo-meta', timeText(m.at));
    if (mine) meta.appendChild(h('span', 'ffo-tick' + (m.read ? ' read' : ''), m.read ? '\u2713\u2713' : '\u2713'));
    b.appendChild(meta);
    return b;
  }
  function render() {
    if (!ui) return;
    var list = ui.list; list.innerHTML = '';
    ui.foot.hidden = st.view === 'history' || st.view === 'past' || st.view === 'profile';
    list.className = 'ffo-list' + (st.view === 'profile' ? ' ffo-plist' : '');
    if (st.view === 'profile') { renderProfile(list); list.scrollTop = 0; return; }
    if (st.view === 'history') { renderHistory(list); list.scrollTop = 0; return; }
    if (st.view === 'past') { renderPast(list); list.scrollTop = list.scrollHeight; return; }
    list.appendChild(h('div', 'ffo-day', 'Today'));
    st.messages.forEach(function (m, i) {
      list.appendChild(bubble(m, st.messages[i - 1]));
      m.fresh = false;
      if (m.role === 'customer') return;
      if (m.card) list.appendChild(drawCard(m.card));
      var isLast = i === st.messages.length - 1;
      if (m.buttons && m.buttons.length && isLast && !st.typing) {
        var wrap = h('div', 'ffo-btns');
        m.buttons.forEach(function (b) {
          var el = h('button', 'ffo-b', b.label); el.type = 'button'; el.disabled = st.busy;
          el.onclick = function () {
            if (b.link) return openLink(b.link, b);
            if (b.url) return openUrl(b.url);
            if (b.id.indexOf('lang:') === 0) { st.lang = b.id.slice(5); save(); }
            talk({ choice: b.id }, b.label);
          };
          wrap.appendChild(el);
        });
        list.appendChild(wrap);
      }
    });
    if (st.typing) { var ty = h('div', 'ffo-typing'); ty.setAttribute('aria-label', 'Olivia is typing'); ty.appendChild(h('i')); ty.appendChild(h('i')); ty.appendChild(h('i')); list.appendChild(ty); }
    if (ui.sub) ui.sub.textContent = st.typing ? 'typing\u2026' : 'online';
    var lastO = st.messages.filter(function (m) { return m.role === 'olivia'; }).pop();
    ui.input.placeholder = lastO && lastO.input === 'email' ? 'Type the email here\u2026' : lastO && lastO.input === 'name' ? 'Type the name in your UPI app\u2026' : lastO && lastO.input === 'coupon' ? 'Type the coupon code\u2026' : 'Message';
    ui.input.type = lastO && lastO.input === 'email' ? 'email' : 'text';
    list.scrollTop = list.scrollHeight;
  }
  function schedulePoll(sec) {
    clearTimeout(st.pollTimer);
    st.pollAfter = sec;
    st.pollTimer = setTimeout(function () { if (!st.busy) talk({ choice: 'poll' }, null, true); else schedulePoll(sec); }, Math.max(3, sec) * 1000);
  }
  var wait = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };
  /** Shows Olivia's replies one by one, each after "typing..." dots (at least half a second, a little longer for long messages). */
  function reveal(list, startedAt) {
    var chain = Promise.resolve();
    list.forEach(function (m, i) {
      chain = chain.then(function () {
        st.typing = true; render();
        var need = Math.min(1400, Math.max(MIN_TYPING_MS, 250 + String(m.text || '').length * 6));
        var spent = i === 0 ? Date.now() - startedAt : 0; // the first reply already waited for the server
        return wait(Math.max(0, need - spent));
      }).then(function () {
        st.typing = false;
        m.at = Date.now(); m.fresh = true;
        st.messages.push(m);
        sound('receive');
        if (m.card && m.card.type === 'access' && window.ffSound) window.ffSound('delivered');
        if (/^COUPON_APPLIED/.test(m.intent || '') && window.ffSound) window.ffSound('coupon');
        render();
      });
    });
    return chain;
  }
  function talk(input, echo, silent) {
    st.phone = phoneNow();
    if (!st.phone) { st.messages.push({ role: 'olivia', text: 'Please log in first to chat with Olivia.', buttons: [], at: Date.now() }); render(); return; }
    var mine = null;
    if (echo) { mine = { role: 'customer', text: echo, at: Date.now(), fresh: true }; st.messages.push(mine); sound('send'); }
    var startedAt = Date.now();
    if (!silent) { st.busy = true; st.typing = true; render(); }
    var body = Object.assign({ conversationId: st.convId, installedApp: installed() }, input);
    call('oliviaChat', [st.phone, body]).then(function (r) {
      if (mine) mine.read = true;
      if (!r || !r.ok) {
        st.busy = false; st.typing = false;
        if (!silent) st.messages.push({ role: 'olivia', text: (r && r.message) || 'Sorry, Olivia is not available right now.', buttons: [{ id: 'whatsapp', label: '\uD83D\uDCAC WhatsApp our team', link: 'whatsapp' }], at: Date.now() });
        if (r && r.whatsappLink) st.wa = r.whatsappLink;
        save(); render();
        return;
      }
      st.convId = r.conversationId; if (r.lang) st.lang = r.lang;
      st.pollAfter = 0; clearTimeout(st.pollTimer);
      var incoming = r.messages || [];
      if (silent && incoming.length) st.busy = true;
      return reveal(incoming, silent ? Date.now() : startedAt).then(function () {
        st.busy = false; st.typing = false;
        if (r.poll && r.poll.afterSec) schedulePoll(r.poll.afterSec);
        save(); render();
      });
    }).catch(function () {
      st.busy = false; st.typing = false;
      if (silent) { schedulePoll(15); return; }
      st.messages.push({ role: 'olivia', text: 'Network problem. Please check your internet and try again.', buttons: [], at: Date.now() });
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
