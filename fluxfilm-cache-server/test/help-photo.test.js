/* Help in the top-right header + Account row, and customers' own profile photos (photos.js). Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---------------- fake MySQL ----------------
const T = { customers: {}, photos: {} };
let photosTable = false;
const noTable = () => { const e = new Error("Table 'u.customer_photos' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; e.errno = 1146; return e; };
const mockDb = {
  ENABLED: true,
  query: async (sql, p) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT raw_json(, profile_pic_url)? FROM customers WHERE phone_norm = \?/.test(sql)) { const c = T.customers[p[0]]; return c ? [{ raw_json: JSON.stringify(c.raw), profile_pic_url: c.url }] : []; }
    if (/^UPDATE customers SET profile_pic_url = \?/.test(sql)) { const c = T.customers[p[2]]; c.url = p[0]; c.raw = JSON.parse(p[1]); return { affectedRows: 1 }; }
    if (/customer_photos/.test(sql) && !photosTable) throw noTable();
    if (/^INSERT INTO customer_photos/.test(sql)) { T.photos[p[0]] = { photo_id: p[1], mime: p[2], data: p[3] }; return { affectedRows: 1 }; }
    if (/^DELETE FROM customer_photos WHERE phone_norm = \?/.test(sql)) { delete T.photos[p[0]]; return { affectedRows: 1 }; }
    if (/^SELECT mime, data FROM customer_photos WHERE photo_id = \?/.test(sql)) { const r = Object.values(T.photos).find((x) => x.photo_id === p[0]); return r ? [{ mime: r.mime, data: r.data }] : []; }
    throw new Error('unexpected SQL ' + sql);
  },
};
const mockReads = { getCustomerProfile: async (ph) => { const c = T.customers[String(ph).slice(-10)]; return c ? { ok: true, name: c.raw.Name, profilePicUrl: c.url } : { ok: false }; } };
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; if (req === './reads') return mockReads; return orig.apply(this, arguments); }; })(Module._load);
const photos = require('../photos');
const account = require('../account');

// Tiny real-looking files (only the first bytes matter to the checks).
const jpeg = (extra) => Buffer.concat([Buffer.from([0xff, 0xd8]), extra || Buffer.alloc(0),
  Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x01, 0x02]), Buffer.from([0xff, 0xda, 0x00, 0x03, 0x00, 0x11, 0x22, 0xff, 0xd9])]);
const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x0c]), Buffer.from('Exif\0\0GPS!', 'latin1')]);
const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x07]), Buffer.from('JFIF\0', 'latin1')]);
const du = (mime, buf) => 'data:' + mime + ';base64,' + buf.toString('base64');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([10, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1')]);

(async () => {
  section('storefront: Help button');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parsed = true;
  for (const s of scripts) { try { new Function(s); } catch (e) { parsed = false; console.log('   parse error:', e.message); } }
  ok('every storefront <script> parses', parsed && scripts.length > 0);
  ok('one Help action (ffOpenHelp_) — the only thing to change to swap what Help opens', (html.match(/function ffOpenHelp_\(\)/g) || []).length === 1 && /function ffOpenHelp_\(\) \{\s*API\.openWhatsApp\(\);\s*\}/.test(html));
  ok('one reusable HelpButton, rendered by the header on every screen (no phone/desktop switch)', /function HelpButton\(\)/.test(html) && /onClick: ffOpenHelp_,/.test(html) && /React\.createElement\(HelpButton, null\)\)\);\s*\}/.test(html) && !/showHelpMobile|ff-help-deskonly/.test(html));
  ok('Help is not in the bottom menu any more', !/key: 'help'/.test((html.match(/const navItems = \[[\s\S]*?\}\];/) || [''])[0]));
  ok('header respects the notch; Help is a 44 px tap target pushed to the right', /\.ff-topbar \{[^}]*padding-top: env\(safe-area-inset-top\)/.test(html) && /\.ff-help \{[^}]*min-height: 44px; min-width: 44px; margin-left: auto;/.test(html));
  ok('"New version ready" bar sits under the header (does not cover Help)', /\.ff-upd \{[^}]*top: calc\(66px \+ env\(safe-area-inset-top\)\)/.test(html));
  ok('Account menu has a "Help & support" row using the same action', /k: 'help',\s*icon: '💬',[\s\S]{0,80}title: 'Help & support'/.test(html) && /r\.k === 'help' \? ffOpenHelp_\(\)/.test(html));

  section('storefront: own photo');
  ok('picker offers "📷 Upload your photo" (gallery/camera file input)', /'📷 Upload your photo'/.test(html) && /type: "file",\s*accept: "image\/\*",/.test(html));
  ok('Save uses the photo when one was chosen, else the avatar', /onClick: pendingPhoto \? savePhoto : saveAvatar/.test(html) && /disabled: avatarSaving \|\| !pendingAvatar && !pendingPhoto/.test(html));
  ok('Remove photo shown only for an uploaded photo', /hasOwnPhoto && !pendingPhoto && React\.createElement\("button", \{\s*className: "ff-photo-rm"/.test(html) && /const hasOwnPhoto = \/\^\\\/profile-photo\\\/\/\.test/.test(html));
  ok('API wrappers call setProfilePhoto / removeProfilePhoto', /apiCall_\('setProfilePhoto', \[phone, dataUrl\]/.test(html) && /apiCall_\('removeProfilePhoto', \[phone, avatarUrl\]/.test(html));

  // Run the browser resize helper with fakes for the error paths (no canvas in Node).
  const start = html.indexOf('const FF_PHOTO_MAX_B64_');
  const end = html.indexOf('function AccountScreen({');
  const FakeImage = function () { const self = this; Object.defineProperty(this, 'src', { set() { setTimeout(() => self.onerror && self.onerror(), 0); } }); };
  const helper = new Function('URL', 'Image', 'document', html.slice(start, end) + '; return ffSquarePhoto_;')({ createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }, FakeImage, {});
  const errOf = (f) => helper(f).then(() => '', (e) => e.message);
  ok('SVG refused before reading it', /JPG or PNG/.test(await errOf({ type: 'image/svg+xml', name: 'a.svg', size: 10 })));
  ok('HEIC the browser cannot open → friendly "HEIC" message', /HEIC/.test(await errOf({ type: 'image/heic', name: 'IMG_1.HEIC', size: 1000 })));
  ok('other unreadable file → "couldn\'t open"', /couldn't open/.test(await errOf({ type: 'image/jpeg', name: 'a.jpg', size: 1000 })));
  ok('non-image refused', /JPG or PNG/.test(await errOf({ type: 'application/pdf', name: 'a.pdf', size: 10 })));

  section('server wiring');
  ok('actions routed to MySQL storefront', /setProfilePhoto: \(a\) => photosMod\.setProfilePhoto\(a\[0\], a\[1\]\)/.test(server) && /'updateCustomerProfilePic', 'setProfilePhoto', 'removeProfilePhoto',/.test(server));
  ok('rate limited per IP and per phone', /LIMITS = \{[\s\S]*setProfilePhoto: security\.rateLimiter\(10, TEN_MIN\)/.test(server) && /PHONE_LIMITS = \{[\s\S]*setProfilePhoto: security\.rateLimiter\(6, 60 \* 60e3\)/.test(server) && /'removeProfilePhoto', 'submitRestockRequest'\]/.test(server));
  ok('/profile-photo/:id mounted before the storefront catch-all, nosniff + long cache', server.indexOf("app.get('/profile-photo/:id'") > 0 && server.indexOf("app.get('/profile-photo/:id'") < server.indexOf("app.get('*'") && /X-Content-Type-Options', 'nosniff'/.test(server));
  ok('schema-v20 creates customer_photos', /CREATE TABLE IF NOT EXISTS customer_photos[\s\S]*photo_id\s+CHAR\(24\)[\s\S]*MEDIUMBLOB[\s\S]*UNIQUE KEY/.test(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-v20.sql'), 'utf8')));

  section('photos.js checks');
  const P = photos._internal.parseDataUrl;
  ok('JPEG / PNG / WebP accepted', P(du('image/jpeg', jpeg())).ok && P(du('image/png', png)).ok && P(du('image/webp', webp)).ok);
  ok('SVG / GIF refused', !P(du('image/svg+xml', Buffer.from('<svg onload=alert(1)></svg>'))).ok && !P(du('image/gif', Buffer.from('GIF89a......'))).ok);
  ok('type must match the file\'s first bytes', !P(du('image/png', jpeg())).ok && !P(du('image/jpeg', Buffer.from('<html><script>x</script></html>'))).ok);
  ok('too big refused (decoded > 80 KB)', /too big/.test(P(du('image/jpeg', Buffer.concat([jpeg(), Buffer.alloc(81 * 1024)]))).message));
  ok('not a data URL / empty refused', !P('https://evil.example/x.jpg').ok && !P('').ok && !P(null).ok);
  const stripped = P(du('image/jpeg', jpeg(Buffer.concat([app0, app1])))).buf;
  ok('JPEG EXIF (APP1) stripped, JFIF kept, image data intact', stripped.indexOf(Buffer.from('Exif')) === -1 && stripped.indexOf(Buffer.from('JFIF')) > 0 && stripped.slice(-2).equals(Buffer.from([0xff, 0xd9])));

  section('photos.js flow (fake DB)');
  T.customers['9876543210'] = { url: 'https://api.dicebear.com/9.x/thumbs/svg?seed=movie', raw: { Name: 'Asha', ProfilePicUrl: 'https://api.dicebear.com/9.x/thumbs/svg?seed=movie' } };
  let r = await photos.setProfilePhoto('+91 98765 43210', du('image/jpeg', jpeg()));
  ok('before schema-v20: friendly "coming soon", avatar untouched', r.ok === false && r.notReady === true && /coming soon/.test(r.message) && /dicebear/.test(T.customers['9876543210'].url), r);
  ok('before schema-v20: picking an avatar still works', (await account.updateCustomerProfilePic('9876543210', 'https://api.dicebear.com/9.x/bottts/svg?seed=robot1')).ok === true);
  ok('before schema-v20: photo route answers 404 (null), no crash', (await photos.image('a'.repeat(24))) === null);
  photosTable = true;
  ok('unknown phone refused', (await photos.setProfilePhoto('9000000000', du('image/jpeg', jpeg()))).message === 'Customer not found');
  ok('bad picture refused before touching the DB', (await photos.setProfilePhoto('9876543210', du('image/svg+xml', Buffer.from('<svg/>')))).ok === false && !T.photos['9876543210']);
  r = await photos.setProfilePhoto('9876543210', du('image/jpeg', jpeg(app1)));
  const url1 = r.profilePicUrl;
  ok('saved: URL is /profile-photo/<random 24 hex>?v=… and never contains the phone', r.ok && /^\/profile-photo\/[a-f0-9]{24}\?v=[a-z0-9]+$/.test(url1) && url1.indexOf('9876543210') === -1 && url1.indexOf('43210') === -1, r);
  ok('customers.profile_pic_url and raw_json ProfilePicUrl kept in sync', T.customers['9876543210'].url === url1 && T.customers['9876543210'].raw.ProfilePicUrl === url1 && r.profile.profilePicUrl === url1);
  const img = await photos.image(url1.split('/')[2].split('?')[0]);
  ok('served back as JPEG without EXIF', img && img.type === 'image/jpeg' && img.buf.indexOf(Buffer.from('Exif')) === -1);
  ok('photo route refuses ids that are not 24 hex (no SQL for junk)', (await photos.image('9876543210')) === null && (await photos.image('../../etc')) === null);
  r = await photos.setProfilePhoto('9876543210', du('image/png', png));
  ok('new upload → new id, old link stops working', r.ok && r.profilePicUrl.split('?')[0] !== url1.split('?')[0] && (await photos.image(url1.split('/')[2].split('?')[0])) === null);
  r = await photos.removeProfilePhoto('9876543210', 'javascript:alert(1)');
  ok('remove photo → back to the letter; row deleted; junk fallback ignored', r.ok && r.profilePicUrl === '' && T.customers['9876543210'].url === '' && !T.photos['9876543210'], r);
  await photos.setProfilePhoto('9876543210', du('image/jpeg', jpeg()));
  await account.updateCustomerProfilePic('9876543210', 'https://api.dicebear.com/9.x/fun-emoji/svg?seed=wow');
  ok('picking an avatar afterwards deletes the uploaded photo', !T.photos['9876543210'] && /fun-emoji/.test(T.customers['9876543210'].url));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('crashed:', e); process.exit(1); });
