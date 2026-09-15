/* ✨ Avatar creator: strict config checks, codes, deterministic SVG, save (avatars.js), storefront wiring. Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---------------- fake MySQL ----------------
const T = { customers: {}, forgotten: [], writes: 0 };
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT raw_json FROM customers WHERE phone_norm = \?/.test(sql)) { const c = T.customers[p[0]]; return c ? [{ raw_json: JSON.stringify(c.raw) }] : []; }
    if (/^UPDATE customers SET profile_pic_url = \?, updated_at = NOW\(\), raw_json = \? WHERE phone_norm = \?/.test(sql)) { T.writes++; const c = T.customers[p[2]]; c.url = p[0]; c.raw = JSON.parse(p[1]); return { affectedRows: 1 }; }
    if (/^DELETE FROM customer_photos WHERE phone_norm = \?/.test(sql)) { T.forgotten.push(p[0]); return { affectedRows: 1 }; }
    if (/^SELECT phone, name, email, profile_pic_url, member_since, raw_json FROM customers/.test(sql)) { const c = T.customers[p[0]]; return c ? [{ phone: p[0], name: c.raw.Name, email: '', profile_pic_url: c.url, member_since: null, raw_json: JSON.stringify(c.raw) }] : []; }
    throw new Error('unexpected SQL ' + sql);
  },
};
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const A = require('../avatarmaker');
const avatars = require('../avatars');
const reads = require('../reads');
const feedcomments = require('../feedcomments');

(async () => {
  section('config validation (strict)');
  ok('default config passes and fills every key', A.validate({}).ok && Object.keys(A.validate({}).config).length === A.KEYS.length);
  ok('a normal config passes', A.validate({ v: 1, hair: 'turban', hairColor: 'c2', beard: 'full', mood: 'wink' }).ok);
  ok('unknown key rejected', !A.validate({ hair: 'bun', onload: 'x' }).ok);
  ok('__proto__ / constructor keys rejected', !A.validate(JSON.parse('{"__proto__":{"x":1}}')).ok && !A.validate({ constructor: 'oval' }).ok);
  ok('unknown value rejected', !A.validate({ hair: 'mohawk' }).ok);
  ok('SVG/script text as a value rejected', !A.validate({ bg: '<script>alert(1)</script>' }).ok && !A.validate({ skin: '#fff" onload="x' }).ok);
  ok('non-string value rejected', !A.validate({ logo: true }).ok && !A.validate({ face: ['oval'] }).ok && !A.validate({ skin: 3 }).ok);
  ok('arrays / null / strings rejected', !A.validate([]).ok && !A.validate(null).ok && !A.validate('hair=bun').ok);
  ok('wrong version rejected', !A.validate({ v: 2 }).ok);
  ok('oversize JSON rejected', !A.validate({ hair: 'bun', v: '1' + ' '.repeat(700) }).ok);
  const big = {}; A.KEYS.forEach((k) => { big[k] = A.OPTIONS[k][A.OPTIONS[k].length - 1]; });
  ok('the biggest real config fits the size limit', JSON.stringify(big).length <= A.MAX_JSON && A.validate(big).ok);

  section('codes');
  let roundTrip = true;
  A.KEYS.forEach((k) => A.OPTIONS[k].forEach((o) => { const c = Object.assign({}, A.DEFAULT, { [k]: o }); const d = A.decode(A.encode(c)); if (!d || JSON.stringify(d) !== JSON.stringify(c)) roundTrip = false; }));
  ok('every option survives encode → decode', roundTrip);
  ok('every option list fits one base-36 character', A.KEYS.every((k) => A.OPTIONS[k].length <= 36));
  ok('code is 16 characters, url is /avatar/<code>.svg', A.encode(A.DEFAULT).length === 16 && /^\/avatar\/1[0-9a-z]{15}\.svg$/.test(A.url(A.DEFAULT)));
  ok('bad codes decode to null', [null, '', '2020000000000100', '102000000000010', '10200000000001000', '1z20000000000100', '1020000000000100.svg', '1O20000000000100'].every((c) => A.decode(c) === null));
  ok('fromUrl only accepts the exact link', !!A.fromUrl('/avatar/1020000000000100.svg') && !A.fromUrl('/avatar/1020000000000100.svg?x=1') && !A.fromUrl('https://x/avatar/1020000000000100.svg'));
  let rs = 1; const rng = () => { rs = (rs * 9301 + 49297) % 233280; return rs / 233280; };
  let randOk = true; for (let i = 0; i < 300; i++) if (!A.validate(A.random(rng)).ok) randOk = false;
  ok('🎲 random always gives a valid config', randOk);

  section('SVG output (deterministic snapshot)');
  const cfgs = {
    def: [A.DEFAULT, '1020000000000100', '9413e6317672f777'],
    turban: [{ hair: 'turban', hairColor: 'c2', beard: 'full', skin: 's6', mood: 'grin', top: 'kurta', topColor: 't6', bg: 'b2' }, '1059100140025110', '13105bcfbfece227'],
    hijab: [{ hair: 'hijab', hairColor: 'c3', skin: 's4', mood: 'wink', glasses: 'cateye', bg: 'b4', prop: 'popcorn' }, '103a200204000131', 'c3a24e96245573d7'],
    braid: [{ hair: 'braid', skin: 's5', jewel: 'bindistuds', eyes: 'lashes', brows: 'arched', face: 'heart', top: 'collar', topColor: 't7', prop: 'headphones' }, '1346042000436103', 'b2934cf06f553b5c'],
  };
  for (const k of Object.keys(cfgs)) {
    const [c, code, hash] = cfgs[k];
    const svg = A.svg(c);
    ok(k + ': code ' + code, A.encode(c) === code, A.encode(c));
    ok(k + ': SVG snapshot unchanged', crypto.createHash('sha256').update(svg).digest('hex').slice(0, 16) === hash, crypto.createHash('sha256').update(svg).digest('hex').slice(0, 16));
    ok(k + ': same config → same SVG', A.svg(c) === svg && A.svg(A.decode(code)) === svg);
  }
  let clean = true, small = true;
  rs = 7; for (let i = 0; i < 300; i++) { const s = A.svg(A.random(rng)); if (/<script|\son[a-z]+=|href|url\(|<foreignObject|<image|javascript:/i.test(s)) clean = false; if (s.length > 6000) small = false; }
  ok('SVG never has scripts, event handlers, links or outside pictures', clean);
  ok('SVG stays small (< 6 KB)', small);
  ok('an invalid config draws the default avatar (never echoes input)', A.svg({ bg: '"><script>' }) === A.svg(A.DEFAULT));
  ok('thumbnail crop only accepts numbers', A.svg(A.DEFAULT, { viewBox: '0 0 1 1" onload="x' }).indexOf('onload') < 0 && /viewBox="34 22 132 132"/.test(A.svg(A.DEFAULT, { viewBox: '34 22 132 132' })));
  ok('drawing code stays light (< 25 KB, no requires)', fs.statSync(path.join(__dirname, '..', 'avatarmaker.js')).size < 25000 && !/require\(/.test(fs.readFileSync(path.join(__dirname, '..', 'avatarmaker.js'), 'utf8')));

  section('GET /avatar/<code>.svg (avatars.render)');
  ok('valid code renders', avatars.render('1059100140025110.svg') === A.svg(cfgs.turban[0]));
  ok('bad files → null', ['1059100140025110', '1059100140025110.png', '../server.js', '1z59100140025110.svg', 'x.svg', ''].every((f) => avatars.render(f) === null));
  ok('route: immutable cache, nosniff, locked-down CSP, image/svg+xml', /app\.get\('\/avatar\/:file'[\s\S]{0,420}max-age=31536000, immutable[\s\S]{0,120}nosniff[\s\S]{0,120}default-src 'none'[\s\S]{0,80}image\/svg\+xml/.test(server));
  ok('route + /avatar-maker.js registered before the storefront catch-all', server.indexOf("app.get('/avatar/:file'") > 0 && server.indexOf("app.get('/avatar-maker.js'") > 0 && server.indexOf("app.get('/avatar-maker.js'") < server.indexOf("app.get('*'"));

  section('save (setAvatar)');
  T.customers['9876543210'] = { url: '/profile-photo/aaaaaaaaaaaaaaaaaaaaaaaa?v=1', raw: { Name: 'Yahya K', ProfilePicUrl: '/profile-photo/aaaaaaaaaaaaaaaaaaaaaaaa?v=1' } };
  let r = await avatars.setAvatar('+91 98765 43210', { v: 1, hair: 'turban', hairColor: 'c2', mood: 'grin' });
  const cu = T.customers['9876543210'];
  ok('save ok, returns the link + config', r.ok && r.profilePicUrl === A.url({ hair: 'turban', hairColor: 'c2', mood: 'grin' }) && r.avatarConfig.hair === 'turban', r);
  ok('typed column and raw_json stay in sync', cu.url === r.profilePicUrl && cu.raw.ProfilePicUrl === r.profilePicUrl && cu.raw.AvatarConfig.hair === 'turban' && !('v' in cu.raw.AvatarConfig));
  ok('other raw_json fields kept', cu.raw.Name === 'Yahya K' && !!cu.raw.UpdatedAt);
  ok('uploaded photo removed (same as picking any avatar)', T.forgotten.indexOf('9876543210') >= 0);
  ok('profile comes back with avatarConfig + avatarUrl', r.profile && r.profile.avatarConfig && r.profile.avatarConfig.hair === 'turban' && r.profile.avatarUrl === r.profilePicUrl);
  const before = T.writes;
  r = await avatars.setAvatar('9876543210', { hair: 'bun', style: 'position:fixed' });
  ok('bad key → error, nothing written', !r.ok && T.writes === before);
  r = await avatars.setAvatar('9876543210', { hair: 'bun', bg: 'x'.repeat(800) });
  ok('oversize → error, nothing written', !r.ok && T.writes === before);
  r = await avatars.setAvatar('9876543210', '<svg onload=alert(1)>');
  ok('raw SVG from the client → error, nothing written', !r.ok && T.writes === before);
  ok('no phone / unknown customer → error', !(await avatars.setAvatar('', {})).ok && !(await avatars.setAvatar('9000000000', {})).ok && T.writes === before);

  section('profile read + other places');
  cu.url = '/profile-photo/bbbbbbbbbbbbbbbbbbbbbbbb?v=2'; // customer switched to a photo later
  const prof = await reads.getCustomerProfile('9876543210');
  ok('saved avatar still offered after switching to a photo', prof.profilePicUrl.indexOf('/profile-photo/') === 0 && prof.avatarUrl === A.url(cu.raw.AvatarConfig));
  cu.raw.AvatarConfig = { hair: 'evil' };
  ok('a tampered raw_json config is ignored', (await reads.getCustomerProfile('9876543210')).avatarConfig === null && (await reads.getCustomerProfile('9876543210')).avatarUrl === '');
  ok('feed comments accept the creator avatar link', feedcomments.safeAvatar('/avatar/1059100140025110.svg') === '/avatar/1059100140025110.svg' && feedcomments.safeAvatar('/avatar/1059100140025110.svg?x') === '');
  ok('server: setAvatar action, DB storefront list, per-IP + per-phone limits', /setAvatar: \(a\) => avatarsMod\.setAvatar\(a\[0\], a\[1\]\)/.test(server) && /DB_STOREFRONT_ACTIONS = new Set\(\[[^\]]*'setAvatar'/.test(server) && /PROFILE_WRITES = new Set\(\[[^\]]*'setAvatar'/.test(server) && /PHONE_LIMITS = \{[\s\S]*?setAvatar: security\.rateLimiter/.test(server));

  section('storefront');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parsed = true;
  for (const s of scripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every storefront <script> parses', parsed && scripts.length > 0);
  ok('drawing code is NOT loaded with the page (only when the creator opens)', !/<script[^>]+avatar-maker/.test(html) && /s\.src = '\/avatar-maker\.js\?v=1'/.test(html));
  ok('API.setAvatar sends [phone, config] (no SVG)', /setAvatar\(phone, config, onSuccess, onFailure\) \{\s*apiCall_\('setAvatar', \[phone, config\]/.test(html));
  ok('Account → Profile has "✨ Create your avatar" and the picker has the creator card', /'✨ Edit your avatar' : '✨ Create your avatar'/.test(html) && /className: "ff-avc-new"/.test(html));
  ok('creator: big preview, tabs, 🎲 Random, Undo, Save', /className: "ff-avc-big"/.test(html) && /className: "ff-avc-tabs"/.test(html) && /"🎲 Random"/.test(html) && /"aria-label": "Undo"/.test(html) && /'✅ Save avatar'/.test(html));
  ok('only the big SVG is redrawn, once per frame', /frame\.current = requestAnimationFrame\(\(\) => \{\s*if \(bigRef\.current\) bigRef\.current\.innerHTML = A\.svg\(cfg\);/.test(html) && /function AvcThumb\(\{/.test(html));
  ok('big tap targets (≥ 44 px icons, 76 px options, 48 px swatches)', /\.ff-avc-ib \{[^}]*min-height: 44px/.test(html) && /\.ff-avc-op \{[^}]*width: 76px/.test(html) && /\.ff-avc-sw \{[^}]*height: 48px/.test(html));
  const moodSrc = (html.match(/function ffAvatarMood_\(url, mood\) \{[\s\S]*?\n\}/) || [''])[0];
  const mood = new Function(moodSrc + '; return ffAvatarMood_;')();
  ok('wink on My plans changes only the expression', A.decode(mood('/avatar/1059100140025110.svg', 'wink').slice(8, 24)).mood === 'wink' && JSON.stringify(Object.assign({}, A.decode(mood('/avatar/1059100140025110.svg', 'wink').slice(8, 24)), { mood: 'grin' })) === JSON.stringify(A.decode('1059100140025110')));
  ok('photos / other avatars / no mood are left alone', mood('/profile-photo/abc', 'wink') === '/profile-photo/abc' && mood('/avatar/1059100140025110.svg', '') === '/avatar/1059100140025110.svg' && mood('', 'wink') === '');
  ok('My plans uses the wink for 3 days after a plan starts', /src: ffAvatarMood_\(profile\.profilePicUrl, actionable\.some\(s => s\.startDate && Date\.now\(\) - new Date\(s\.startDate\)\.getTime\(\) < 3 \* 86400e3\) \? 'wink' : ''\)/.test(html));
  ok('own avatar stays in the picture picker list', /const pickList = myAvatarUrl \? \[myAvatarUrl\]\.concat\(AVATARS\) : AVATARS;/.test(html) && /pickList\.map\(\(url, i\)/.test(html));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
