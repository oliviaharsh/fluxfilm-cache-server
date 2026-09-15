/**
 * FluxFilm avatar creator — our own cartoon avatars, drawn as SVG from a tiny config.
 *
 * Shared by the server (avatars.js: strict checks + GET /avatar/<code>.svg) and the browser (loaded as
 * /avatar-maker.js only when the customer opens "✨ Create your avatar"). No outside requests, no fonts.
 *
 * Config  = { face:'oval', skin:'s3', hair:'bun', ... }  (every value comes from the OPTIONS lists below)
 * Code    = '1' + one base-36 character per key, in KEYS order  → e.g. '10320001000000100'
 * The saved picture link is /avatar/<code>.svg, so every place that shows a profile picture keeps working.
 * The SVG is only ever built here from whitelisted option ids — never from text the customer typed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FFAvatar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1';
  var OPTIONS = {
    face: ['oval', 'round', 'square', 'heart', 'long'],
    skin: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
    hair: ['short', 'fade', 'curly', 'sidepart', 'spiky', 'long', 'braid', 'bun', 'ponytail', 'turban', 'hijab', 'bald'],
    hairColor: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'],
    eyes: ['dots', 'round', 'happy', 'sleepy', 'lashes'],
    brows: ['natural', 'thick', 'arched', 'raised', 'angry'],
    mood: ['smile', 'grin', 'wink', 'smirk', 'shocked', 'calm', 'tongue'],
    beard: ['none', 'stubble', 'moustache', 'goatee', 'full'],
    glasses: ['none', 'round', 'square', 'sunglasses', 'cateye'],
    jewel: ['none', 'bindi', 'studs', 'hoops', 'bindistuds', 'nosering'],
    top: ['tee', 'hoodie', 'kurta', 'collar'],
    topColor: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    logo: ['off', 'on'],
    bg: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'],
    prop: ['none', 'popcorn', 'remote', 'headphones'],
  };
  var KEYS = Object.keys(OPTIONS);
  var DEFAULT = { face: 'oval', skin: 's3', hair: 'short', hairColor: 'c1', eyes: 'dots', brows: 'natural', mood: 'smile', beard: 'none', glasses: 'none', jewel: 'none', top: 'tee', topColor: 't1', logo: 'on', bg: 'b1', prop: 'none' };
  var MAX_JSON = 600;

  var SKIN = { s1: '#fde7d6', s2: '#f6d1b1', s3: '#edb98a', s4: '#d99e6a', s5: '#c68642', s6: '#a5693f', s7: '#8d5524', s8: '#5c3a1e' };
  var HAIR = { c1: '#1c1b22', c2: '#3b2417', c3: '#6b4226', c4: '#8d3b1f', c5: '#d6b370', c6: '#a3a3a3', c7: '#3b82f6', c8: '#ec4899' };
  var WRAP = { c1: '#7f1d1d', c2: '#f59e0b', c3: '#1e3a8a', c4: '#db2777', c5: '#f1f5f9', c6: '#15803d', c7: '#111827', c8: '#6d28d9' };
  var TOP = { t1: '#22c55e', t2: '#0f172a', t3: '#ffffff', t4: '#ef4444', t5: '#3b82f6', t6: '#f59e0b', t7: '#a855f7', t8: '#f472b6' };
  var BG = { b1: '#dcfce7', b2: '#fef3c7', b3: '#e0f2fe', b4: '#fce7f3', b5: '#ede9fe', b6: '#1e293b', b7: '#fee2e2', b8: '#16a34a' };
  // Friendly names for the picker (screen readers + labels).
  var LABELS = {
    face: { oval: 'Oval', round: 'Round', square: 'Square', heart: 'Heart', long: 'Long' },
    hair: { short: 'Short', fade: 'Fade', curly: 'Curly', sidepart: 'Side part', spiky: 'Spiky', long: 'Long', braid: 'Braid', bun: 'Bun', ponytail: 'Ponytail', turban: 'Turban', hijab: 'Hijab', bald: 'Bald' },
    eyes: { dots: 'Dots', round: 'Round', happy: 'Happy', sleepy: 'Sleepy', lashes: 'Lashes' },
    brows: { natural: 'Natural', thick: 'Thick', arched: 'Arched', raised: 'Raised', angry: 'Serious' },
    mood: { smile: 'Smile', grin: 'Big grin', wink: 'Wink', smirk: 'Smirk', shocked: 'Shocked', calm: 'Calm', tongue: 'Silly' },
    beard: { none: 'None', stubble: 'Stubble', moustache: 'Moustache', goatee: 'Goatee', full: 'Full beard' },
    glasses: { none: 'None', round: 'Round', square: 'Square', sunglasses: 'Sunglasses', cateye: 'Cat-eye' },
    jewel: { none: 'None', bindi: 'Bindi', studs: 'Studs', hoops: 'Hoops', bindistuds: 'Bindi + studs', nosering: 'Nose ring' },
    top: { tee: 'T-shirt', hoodie: 'Hoodie', kurta: 'Kurta', collar: 'Shirt' },
    logo: { off: 'No logo', on: 'Logo' },
    prop: { none: 'None', popcorn: 'Popcorn', remote: 'Remote', headphones: 'Headset' },
  };
  var COLORS = { skin: SKIN, hairColor: HAIR, topColor: TOP, bg: BG };

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /** Strict check. Returns { ok:true, config } (all keys filled) or { ok:false, message }. */
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Avatar settings missing.' };
    var json;
    try { json = JSON.stringify(input); } catch (_) { return { ok: false, message: 'Avatar settings are not valid.' }; }
    if (!json || json.length > MAX_JSON) return { ok: false, message: 'Avatar settings are too big.' };
    var out = {};
    for (var k in input) {
      if (!has(input, k)) continue;
      if (k === 'v') { if (String(input.v) !== VERSION) return { ok: false, message: 'Avatar version not supported.' }; continue; }
      if (!has(OPTIONS, k)) return { ok: false, message: 'Unknown avatar setting: ' + String(k).slice(0, 20) };
      if (typeof input[k] !== 'string' || OPTIONS[k].indexOf(input[k]) < 0) return { ok: false, message: 'Unknown choice for ' + k + '.' };
      out[k] = input[k];
    }
    KEYS.forEach(function (key) { if (!has(out, key)) out[key] = DEFAULT[key]; });
    return { ok: true, config: out };
  }

  function encode(cfg) {
    var c = validate(cfg);
    if (!c.ok) return '';
    return VERSION + KEYS.map(function (k) { return OPTIONS[k].indexOf(c.config[k]).toString(36); }).join('');
  }
  /** Code → config, or null if the code is not exactly right. */
  function decode(code) {
    var v = String(code == null ? '' : code);
    if (v.length !== KEYS.length + 1 || v.charAt(0) !== VERSION || !/^[0-9a-z]+$/.test(v)) return null;
    var out = {};
    for (var i = 0; i < KEYS.length; i++) {
      var n = parseInt(v.charAt(i + 1), 36);
      if (!(n >= 0 && n < OPTIONS[KEYS[i]].length)) return null;
      out[KEYS[i]] = OPTIONS[KEYS[i]][n];
    }
    return out;
  }
  function url(cfg) { var c = encode(cfg); return c ? '/avatar/' + c + '.svg' : ''; }
  /** '/avatar/<code>.svg' → config or null. */
  function fromUrl(u) { var m = /^\/avatar\/([0-9a-z]{16})\.svg$/.exec(String(u || '')); return m ? decode(m[1]) : null; }

  function random(rng) {
    var r = typeof rng === 'function' ? rng : Math.random;
    var out = {};
    KEYS.forEach(function (k) { out[k] = OPTIONS[k][Math.floor(r() * OPTIONS[k].length) % OPTIONS[k].length]; });
    // Keep randoms friendly: mostly no beard / glasses / props.
    if (r() < 0.6) out.beard = 'none';
    if (r() < 0.5) out.glasses = 'none';
    if (r() < 0.4) out.prop = 'none';
    if (out.bg === 'b6' && r() < 0.5) out.bg = 'b1';
    return out;
  }

  // ---------------- drawing ----------------
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var f = function (sh) { var x = (n >> sh) & 255; x = Math.round(amt < 0 ? x * (1 + amt) : x + (255 - x) * amt); return (x < 16 ? '0' : '') + x.toString(16); };
    return '#' + f(16) + f(8) + f(0);
  }
  function el(tag, attrs, inner) {
    var s = '<' + tag;
    for (var k in attrs) if (has(attrs, k)) s += ' ' + k + '="' + attrs[k] + '"';
    return s + (inner == null ? '/>' : '>' + inner + '</' + tag + '>');
  }
  var P = function (d, fill, extra) { var a = { d: d, fill: fill }; for (var k in extra) if (has(extra, k)) a[k] = extra[k]; return el('path', a); };
  var ST = function (d, color, w) { return el('path', { d: d, fill: 'none', stroke: color, 'stroke-width': w || 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); };
  var MIRROR = 'matrix(-1 0 0 1 200 0)';
  var both = function (s) { return s + el('g', { transform: MIRROR }, s); };

  var HALF = { oval: 34, round: 38, square: 36, heart: 35, long: 31 };
  function faceShape(face, fill) {
    if (face === 'round') return el('ellipse', { cx: 100, cy: 94, rx: 38, ry: 39, fill: fill });
    if (face === 'square') return el('rect', { x: 64, y: 54, width: 72, height: 82, rx: 24, fill: fill });
    if (face === 'heart') return P('M65,82C65,50 135,50 135,82C135,112 116,135 100,137C84,135 65,112 65,82Z', fill);
    if (face === 'long') return el('ellipse', { cx: 100, cy: 92, rx: 31, ry: 45, fill: fill });
    return el('ellipse', { cx: 100, cy: 93, rx: 34, ry: 42, fill: fill });
  }

  function body(cfg) {
    var c = TOP[cfg.topColor], d = shade(c, -0.18), light = cfg.topColor === 't3' || cfg.topColor === 't6';
    var s = P('M34,200C34,162 66,146 100,146C134,146 166,162 166,200Z', c);
    if (cfg.top === 'tee') s += P('M84,147Q100,164 116,147', shade(SKIN[cfg.skin], -0.1));
    if (cfg.top === 'hoodie') s += P('M70,152Q100,176 130,152Q124,146 100,144Q76,146 70,152Z', d) + ST('M92,164L90,184M108,164L110,184', light ? '#64748b' : '#f8fafc', 2.5);
    if (cfg.top === 'kurta') s += P('M88,147L100,160L112,147Z', shade(SKIN[cfg.skin], -0.1)) + ST('M100,160L100,196', d, 2.5) + el('circle', { cx: 100, cy: 170, r: 2, fill: d }) + el('circle', { cx: 100, cy: 182, r: 2, fill: d }) + ST('M86,146Q100,152 114,146', d, 4);
    if (cfg.top === 'collar') s += P('M86,146L100,166L114,146Z', shade(SKIN[cfg.skin], -0.1)) + P('M84,145L100,166L90,172L78,150Z', '#f8fafc') + P('M116,145L100,166L110,172L122,150Z', '#f8fafc');
    if (cfg.logo === 'on') s += el('rect', { x: 118, y: 168, width: 18, height: 18, rx: 5, fill: cfg.topColor === 't1' ? '#0f172a' : '#22c55e' }) + P('M123,172h9v3h-6v2.5h5v3h-5v4.5h-3z', '#fff');
    return s;
  }

  function hairBack(cfg) {
    var h = cfg.hair, c = HAIR[cfg.hairColor], w = WRAP[cfg.hairColor];
    if (h === 'long') return P('M58,92C52,36 148,36 142,92L150,156Q100,170 50,156Z', c);
    if (h === 'braid') return P('M62,90C58,44 142,44 138,90L140,112Q100,120 60,112Z', c);
    if (h === 'ponytail') return P('M130,70C160,74 164,120 150,150C146,126 140,104 128,92Z', c);
    if (h === 'hijab') return P('M54,98C50,30 150,30 146,98L152,150Q148,172 100,176Q52,172 48,150Z', w) + P('M62,150Q100,168 138,150L146,176Q100,192 54,176Z', shade(w, -0.15));
    return '';
  }

  function hairFront(cfg) {
    var h = cfg.hair, c = HAIR[cfg.hairColor], d = shade(c, -0.25), w = WRAP[cfg.hairColor];
    switch (h) {
      case 'short': return P('M63,88C58,40 142,40 137,88C132,68 116,60 100,62C84,60 68,68 63,88Z', c);
      case 'fade': return P('M66,80C64,48 136,48 134,80C126,66 74,66 66,80Z', c) + P('M66,80C64,72 66,66 68,62L70,78Z', d, { opacity: '.5' }) + el('g', { transform: MIRROR }, P('M66,80C64,72 66,66 68,62L70,78Z', d, { opacity: '.5' }));
      case 'curly': {
        var pts = [[66, 82], [64, 68], [72, 56], [84, 48], [100, 45], [116, 48], [128, 56], [136, 68], [134, 82], [80, 60], [100, 56], [120, 60]];
        return pts.map(function (p) { return el('circle', { cx: p[0], cy: p[1], r: 11, fill: c }); }).join('') + el('circle', { cx: 92, cy: 52, r: 4, fill: d, opacity: '.35' }) + el('circle', { cx: 118, cy: 64, r: 4, fill: d, opacity: '.35' });
      }
      case 'sidepart': return P('M62,90C56,40 144,38 138,86C124,62 100,56 78,70C72,76 66,82 62,90Z', c) + ST('M84,54Q96,58 104,66', d, 2);
      case 'spiky': return P('M64,86L60,58L74,62L76,42L90,54L100,36L110,54L124,42L126,62L140,58L136,86C128,70 72,70 64,86Z', c);
      case 'long': return P('M62,96C58,46 142,46 138,96C132,66 112,58 92,62C76,66 66,78 62,96Z', c);
      case 'braid': {
        var b = P('M62,92C56,44 144,42 138,90C124,64 100,58 80,70C70,76 64,84 62,92Z', c);
        for (var i = 0; i < 5; i++) b += el('ellipse', { cx: 134 + i * 2, cy: 118 + i * 14, rx: 8 - i * 0.6, ry: 9, fill: i % 2 ? d : c });
        return b + el('circle', { cx: 144, cy: 190, r: 4, fill: '#f59e0b' });
      }
      case 'bun': return el('circle', { cx: 100, cy: 42, r: 17, fill: c }) + ST('M88,40Q100,34 112,40', d, 2) + P('M64,88C58,44 142,44 136,88C130,66 114,60 100,62C86,60 70,66 64,88Z', c);
      case 'ponytail': return P('M64,88C58,44 142,44 136,88C130,66 114,60 100,62C86,60 70,66 64,88Z', c) + el('circle', { cx: 132, cy: 70, r: 5, fill: '#ef4444' });
      case 'turban': {
        var tw = shade(w, -0.2);
        return P('M58,88C50,28 150,28 142,88C134,70 66,70 58,88Z', w) + ST('M64,74Q100,48 136,70M62,62Q100,36 132,52', tw, 3) + ST('M100,40Q86,60 90,78', tw, 3) + el('circle', { cx: 100, cy: 60, r: 5, fill: cfg.hairColor === 'c2' ? '#dc2626' : '#fbbf24' });
      }
      case 'hijab': return P('M60,92C58,46 142,46 140,92C134,62 66,62 60,92Z', w) + P('M60,92C58,46 142,46 140,92C134,62 66,62 60,92Z', '#000', { opacity: '.06' });
      default: return P('M78,62Q86,56 94,58', '#fff', { opacity: '.25' });
    }
  }

  function eyes(cfg) {
    var ink = '#1f2937', e = cfg.eyes, wink = cfg.mood === 'wink', shocked = cfg.mood === 'shocked';
    var one;
    if (e === 'round' || shocked) one = el('ellipse', { cx: 86, cy: 91, rx: shocked ? 8 : 7, ry: shocked ? 8 : 6, fill: '#fff' }) + el('circle', { cx: 86, cy: 91, r: 3.6, fill: ink });
    else if (e === 'happy') one = ST('M80,92Q86,85 92,92', ink, 3);
    else if (e === 'sleepy') one = ST('M79,90L93,90', ink, 3) + ST('M80,90Q86,95 92,90', ink, 2);
    else one = el('circle', { cx: 86, cy: 91, r: 4.2, fill: ink }) + el('circle', { cx: 87.4, cy: 89.6, r: 1.3, fill: '#fff' }) + (e === 'lashes' ? ST('M80,87L77,84M83,85L82,81', ink, 2) : '');
    var left = one, right = el('g', { transform: MIRROR }, one);
    if (wink) right = ST('M108,91Q114,86 120,91', ink, 3);
    return left + right;
  }

  function brows(cfg) {
    var c = cfg.hair === 'bald' || cfg.hair === 'hijab' || cfg.hair === 'turban' ? shade(HAIR[cfg.hairColor === 'c6' ? 'c6' : 'c2'], 0) : HAIR[cfg.hairColor];
    if (cfg.hairColor === 'c7' || cfg.hairColor === 'c8') c = '#3b2417';
    var b = cfg.brows, one;
    if (b === 'thick') one = ST('M79,80Q86,75 93,78', c, 5);
    else if (b === 'arched') one = ST('M79,81Q85,72 93,78', c, 3);
    else if (b === 'raised') one = ST('M79,76Q86,70 93,74', c, 3);
    else if (b === 'angry') one = ST('M79,76L93,81', c, 3.5);
    else one = ST('M79,80Q86,76 93,79', c, 3);
    if (cfg.mood === 'shocked' && b !== 'angry') one = el('g', { transform: 'translate(0 -4)' }, one);
    return both(one);
  }

  function mouth(cfg) {
    var m = cfg.mood, lip = '#7f1d1d';
    if (m === 'grin' || m === 'tongue') return P('M85,112Q100,132 115,112Z', lip) + P('M88,113L112,113L110,117L90,117Z', '#fff') + (m === 'tongue' ? el('ellipse', { cx: 104, cy: 124, rx: 6, ry: 5, fill: '#f472b6' }) : '');
    if (m === 'wink') return ST('M88,115Q102,125 114,111', lip, 3);
    if (m === 'smirk') return ST('M91,118Q104,121 113,112', lip, 3);
    if (m === 'shocked') return el('ellipse', { cx: 100, cy: 119, rx: 6, ry: 8, fill: lip });
    if (m === 'calm') return ST('M92,117L108,117', lip, 3);
    return ST('M88,114Q100,125 112,114', lip, 3);
  }

  function beard(cfg) {
    var b = cfg.beard, c = cfg.hairColor === 'c7' || cfg.hairColor === 'c8' ? HAIR.c2 : HAIR[cfg.hairColor];
    var must = P('M86,110Q100,103 114,110Q107,114 100,111Q93,114 86,110Z', c);
    if (b === 'stubble') return P('M67,104Q70,138 100,140Q130,138 133,104Q124,124 100,126Q76,124 67,104Z', c, { opacity: '.28' });
    if (b === 'moustache') return must;
    if (b === 'goatee') return must + P('M91,124Q100,142 109,124Q100,129 91,124Z', c);
    if (b === 'full') return P('M66,98Q66,146 100,146Q134,146 134,98Q128,122 112,124Q100,120 88,124Q72,122 66,98Z', c) + must;
    return '';
  }

  function glasses(cfg) {
    var g = cfg.glasses, k = '#111827';
    if (g === 'round') return both(el('circle', { cx: 86, cy: 91, r: 10.5, fill: '#fff', 'fill-opacity': '.15', stroke: k, 'stroke-width': 2.5 })) + ST('M96,90Q100,87 104,90', k, 2.5);
    if (g === 'square') return both(el('rect', { x: 74, y: 82, width: 23, height: 17, rx: 4, fill: '#fff', 'fill-opacity': '.15', stroke: k, 'stroke-width': 2.5 })) + ST('M97,89L103,89', k, 2.5);
    if (g === 'sunglasses') return both(P('M72,84H98V92Q98,102 86,102Q72,102 72,92Z', k) + ST('M76,88L82,88', '#fff', 1.5)) + ST('M98,87L102,87', k, 3);
    if (g === 'cateye') return both(P('M72,84Q84,80 97,86Q97,100 86,100Q74,100 72,84Z', 'none', { stroke: '#be185d', 'stroke-width': 2.5 })) + ST('M97,88L103,88', '#be185d', 2.5);
    return '';
  }

  function jewels(cfg, half) {
    var j = cfg.jewel, gold = '#f59e0b', out = '';
    var ear = cfg.hair !== 'hijab' && cfg.hair !== 'long';
    if (j === 'bindi' || j === 'bindistuds') out += el('circle', { cx: 100, cy: 81, r: 2.8, fill: '#dc2626' });
    if ((j === 'studs' || j === 'bindistuds') && ear) out += el('circle', { cx: 100 - half - 1, cy: 104, r: 2.8, fill: gold }) + el('circle', { cx: 100 + half + 1, cy: 104, r: 2.8, fill: gold });
    if (j === 'hoops' && cfg.hair !== 'hijab') out += el('circle', { cx: 100 - half - 1, cy: 110, r: 6, fill: 'none', stroke: gold, 'stroke-width': 2.2 }) + el('circle', { cx: 100 + half + 1, cy: 110, r: 6, fill: 'none', stroke: gold, 'stroke-width': 2.2 });
    if (j === 'nosering') out += el('circle', { cx: 106, cy: 106, r: 3.2, fill: 'none', stroke: gold, 'stroke-width': 1.6 });
    return out;
  }

  function prop(cfg) {
    var p = cfg.prop;
    if (p === 'popcorn') {
      var s = '';
      [[24, 150], [32, 144], [42, 146], [50, 150], [30, 154], [44, 155], [37, 150]].forEach(function (q) { s += el('circle', { cx: q[0], cy: q[1], r: 6.5, fill: '#fef9c3', stroke: '#facc15', 'stroke-width': 1 }); });
      return s + P('M16,156H58L52,198H22Z', '#fff') + P('M22,156H29L31,198H25ZM36,156H43L42,198H36ZM50,156H57L51,198H46Z', '#ef4444');
    }
    if (p === 'remote') return el('g', { transform: 'rotate(-18 160 172)' }, el('rect', { x: 150, y: 146, width: 22, height: 54, rx: 9, fill: '#334155' }) + el('circle', { cx: 161, cy: 156, r: 4, fill: '#ef4444' }) + el('circle', { cx: 156, cy: 170, r: 2.5, fill: '#cbd5e1' }) + el('circle', { cx: 166, cy: 170, r: 2.5, fill: '#cbd5e1' }) + el('rect', { x: 155, y: 178, width: 12, height: 4, rx: 2, fill: '#22c55e' }));
    return '';
  }

  function headphones(cfg, half) {
    if (cfg.prop !== 'headphones') return '';
    var x = 100 - half - 7;
    return ST('M' + (x + 4) + ',94C' + (x - 2) + ',26 ' + (200 - x + 2) + ',26 ' + (200 - x - 4) + ',94', '#0f172a', 6) +
      both(el('rect', { x: x - 4, y: 82, width: 15, height: 28, rx: 7, fill: '#22c55e', stroke: '#0f172a', 'stroke-width': 2.5 }));
  }

  /** The SVG markup. opts.viewBox crops (e.g. '44 30 112 112' for head thumbnails); opts.size sets width/height. */
  function svg(input, opts) {
    var v = validate(input || {});
    var cfg = v.ok ? v.config : DEFAULT;
    var o = opts || {};
    var skin = SKIN[cfg.skin], skinD = shade(skin, -0.12), half = HALF[cfg.face];
    var covered = cfg.hair === 'hijab';
    var back = el('rect', { width: 200, height: 200, fill: BG[cfg.bg] }) +
      (cfg.bg === 'b6' ? el('circle', { cx: 166, cy: 30, r: 2, fill: '#fde68a' }) + el('circle', { cx: 30, cy: 52, r: 1.6, fill: '#fde68a' }) + el('circle', { cx: 172, cy: 76, r: 1.2, fill: '#fff' }) : '');
    var parts = [
      hairBack(cfg),
      el('rect', { x: 88, y: 118, width: 24, height: 34, rx: 8, fill: skinD }),
      body(cfg),
      covered ? '' : both(el('ellipse', { cx: 100 - half, cy: 96, rx: 6, ry: 10, fill: skinD })),
      faceShape(cfg.face, skin),
      beard(cfg),
      mouth(cfg),
      ST('M100,95Q96,104 101,106', skinD, 2.5),
      cfg.mood === 'smile' || cfg.mood === 'grin' || cfg.mood === 'wink' ? both(el('circle', { cx: 79, cy: 107, r: 6, fill: '#f472b6', opacity: '.22' })) : '',
      eyes(cfg),
      brows(cfg),
      hairFront(cfg),
      jewels(cfg, half),
      glasses(cfg),
      headphones(cfg, half),
      prop(cfg),
    ];
    var a = { xmlns: 'http://www.w3.org/2000/svg', viewBox: o.viewBox && /^[0-9 .-]{7,30}$/.test(o.viewBox) ? o.viewBox : '0 0 200 200' };
    if (o.size) { a.width = +o.size || 200; a.height = +o.size || 200; }
    a.role = 'img';
    return el('svg', a, '<title>Avatar</title>' + back + el('g', { transform: 'translate(-10 -4) scale(1.1)' }, parts.join('')));
  }

  return { VERSION: VERSION, OPTIONS: OPTIONS, KEYS: KEYS, DEFAULT: DEFAULT, LABELS: LABELS, COLORS: COLORS, WRAP: WRAP, MAX_JSON: MAX_JSON, validate: validate, encode: encode, decode: decode, url: url, fromUrl: fromUrl, random: random, svg: svg };
});
