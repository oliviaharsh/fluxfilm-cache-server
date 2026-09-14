/* New order IDs never reuse an existing one (go's imported orders use the same FF + 7 digits shape). Run: npm test */
const Module = require('module');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

let taken = new Set(); let asked = [];
const mockDb = { ENABLED: true, query: async (sql, p) => { if (/^SELECT 1 FROM orders WHERE order_id = \?/.test(sql)) { asked.push(p[0]); return taken.has(p[0]) || taken.has('*') ? [{ 1: 1 }] : []; } return []; } };
Module._load = (function (orig) { return function (req) { if (req === './db') return mockDb; return orig.apply(this, arguments); }; })(Module._load);
const order = require('../order');
const { genOrderId, freeOrderId } = order._internal;

(async () => {
  ok('ID shape unchanged: FF + 7 digits', /^FF\d{7}$/.test(genOrderId()));
  let id = await freeOrderId();
  ok('free ID is checked against the orders table', /^FF\d{7}$/.test(id) && asked.includes(id));

  // The first generated IDs are taken → it keeps looking.
  const realRandom = Math.random; const realNow = Date.now; Date.now = () => 1789400012345; let calls = 0;
  const seq = [0.11, 0.11, 0.42];
  Math.random = () => seq[Math.min(calls++, seq.length - 1)];
  const first = genOrderId(); calls = 0;
  taken = new Set([first]); asked = [];
  id = await freeOrderId();
  Math.random = realRandom; Date.now = realNow;
  ok('an ID that already exists (e.g. an imported go order) is skipped', id !== first && asked.length >= 2 && asked[0] === first, { first, id, asked });

  taken = new Set(['*']); asked = [];
  id = await freeOrderId();
  ok('if every short ID is taken it falls back to a longer FF + digits ID', /^FF\d{11}$/.test(id) && asked.length === 8, { id, n: asked.length });
  ok('longer fallback still matches how bank notes are read (FF + 6 or more digits)', /\bFF\d{6,}\b/.test('UPI/' + id + '/x'));

  const src = fs.readFileSync(path.join(__dirname, '..', 'order.js'), 'utf8');
  ok('createOrder uses the free-ID check', /const orderId = await freeOrderId\(\);/.test(src) && !/const orderId = genOrderId\(\);/.test(src));

  console.log('\n---------------------------------------');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('THREW', e); process.exitCode = 1; });
