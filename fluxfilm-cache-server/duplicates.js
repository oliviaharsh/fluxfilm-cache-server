/**
 * FluxFilm — 🧑‍🤝‍🧑 one person, two FluxFilm accounts.
 *
 * Found on 27 Sep 2026 while checking Yash: 16 customers have two rows with the same email and two different
 * numbers, 20 have two rows with the same name. No two rows share a number, so the number is always what splits
 * them. It costs money twice over:
 *
 *   · the customer signs in on the number with no plan, sees an empty My plans, and BUYS AGAIN instead of
 *     renewing. That is what Yash did, and it had to be unpicked by hand.
 *   · and on 29 Sep it stopped ten people being found in the WhatsApp group: a name two customer rows share
 *     cannot be matched to either of them, so they stayed on the chase list.
 *
 * 🔒 This LINKS; it does not merge. Nothing is moved, nothing is deleted, no order and no subscription is
 * touched, and unlinking puts it back exactly as it was. A merge would have to rewrite money rows to be worth
 * anything, and rewriting money rows on the strength of a shared email address is not a trade worth making.
 * If a real merge is ever wanted it should be its own decision, with its own screen and its own undo.
 *
 *   GET  /admin/api/duplicates          the candidate pairs, what each side holds, and what is already linked
 *   POST /admin/api/duplicates/link     mark these accounts as one person (or unlink)
 *
 * ⚠️ Nothing here joins customer_links to customers or subscriptions in SQL. The tables are in two different
 * collations and MariaDB refuses the comparison — the failure that silently emptied the ▶️ Today count on
 * 27 Sep. Every side is read on its own and matched on the 10-digit phone in JavaScript.
 */
const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => { const d = s(v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };
const low = (v) => s(v).toLowerCase();

/** A name reduced for comparison. Exactly the rule groupmembers.js uses, so the two screens agree about who is who. */
const nameKey = (v) => s(v)
  .replace(/^~\s*/, '')
  .replace(/^FF\s*[-–]\s*/i, '')
  .replace(/^\([^)]{1,12}\)\s*/, '')
  .replace(/^(?:YT|OTT|NF|PR|JH)\s+/i, '')
  .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = (v) => { const m = s(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : ''; };
const sqlNow = (at) => new Date((at == null ? Date.now() : at) + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

const noTable = (e) => /customer_links/i.test(String(e && e.message)) && /doesn't exist|Unknown table/i.test(String(e && e.message));

/** Every link, as a Map of duplicate phone -> primary phone. Empty (not an error) before schema-v33 is run. */
async function links(query) {
  try {
    const rows = await query('SELECT phone_norm, primary_phone, linked_at, note FROM customer_links', []);
    return { ok: true, map: new Map(rows.map((r) => [norm(r.phone_norm), norm(r.primary_phone)])), rows };
  } catch (e) {
    if (noTable(e)) return { ok: false, needsSchema: true, map: new Map(), rows: [] };
    throw e;
  }
}

/**
 * Follow a chain to the account that should be treated as the real one. A -> B -> C gives C for all three.
 * Guarded against a loop somebody could make by linking two accounts to each other.
 */
function primaryOf(map, phone) {
  let p = norm(phone); let hops = 0;
  while (map.has(p) && hops++ < 8) { const next = map.get(p); if (!next || next === p) break; p = next; }
  return p;
}

/** What one account holds. Counted per table, never joined across them. */
async function activity(query) {
  const subs = new Map(); const ords = new Map();
  try {
    for (const r of await query(
      "SELECT phone_norm, COUNT(*) AS c, SUM(CASE WHEN UPPER(COALESCE(status,'')) = 'ACTIVE' AND expiry_date > NOW() THEN 1 ELSE 0 END) AS a, MAX(expiry_date) AS e FROM subscriptions GROUP BY phone_norm", [])) {
      subs.set(norm(r.phone_norm), { subs: Number(r.c) || 0, active: Number(r.a) || 0, lastExpiry: s(r.e) });
    }
  } catch (e) { console.log('[duplicates] subscription counts unavailable:', e.message); }
  try {
    for (const r of await query('SELECT phone_norm, COUNT(*) AS c, MAX(created_at_sheet) AS last FROM orders GROUP BY phone_norm', [])) {
      ords.set(norm(r.phone_norm), { orders: Number(r.c) || 0, lastOrder: s(r.last) });
    }
  } catch (e) { console.log('[duplicates] order counts unavailable:', e.message); }
  return { subs, ords };
}

/**
 * The candidate groups: customer rows that look like the same person.
 *
 * Two reasons only, both exact — the same email, or the same name. No fuzzy matching, for the reason the group
 * screen already learned the hard way: a name is not a key, and a near miss resolved by a guess is worse than
 * no answer. These are CANDIDATES; the owner decides, one at a time, and can unlink.
 */
async function overview(query, now) {
  const at = now == null ? Date.now() : now;
  const lk = await links(query);
  const custs = await query('SELECT phone_norm, name, email, customer_id, member_since FROM customers', []);
  const act = await activity(query);

  const rows = custs.map((c) => {
    const ph = norm(c.phone_norm);
    const a = act.subs.get(ph) || { subs: 0, active: 0, lastExpiry: '' };
    const o = act.ords.get(ph) || { orders: 0, lastOrder: '' };
    return {
      phone: ph, name: s(c.name), email: low(c.email), customerId: s(c.customer_id),
      subs: a.subs, active: a.active, lastExpiry: s(a.lastExpiry), lastExpiryLabel: prettyDate(a.lastExpiry),
      orders: o.orders, lastOrder: s(o.lastOrder), lastOrderLabel: prettyDate(o.lastOrder),
      linkedTo: lk.map.get(ph) || '',
    };
  }).filter((x) => x.phone);

  const group = (keyOf, why) => {
    const m = new Map();
    for (const r of rows) { const k = keyOf(r); if (!k) continue; const list = m.get(k) || []; list.push(r); m.set(k, list); }
    return [...m.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: why + ':' + k, why, shown: k, people: v }));
  };
  // Same email first: it is the stronger signal, and a name group whose people already share an email adds nothing.
  const byEmail = group((r) => r.email, 'email');
  const seen = new Set();
  for (const g of byEmail) for (const p of g.people) seen.add(p.phone);
  const byName = group((r) => nameKey(r.name), 'name').filter((g) => !g.people.every((p) => seen.has(p.phone)));

  const groups = byEmail.concat(byName).map((g) => {
    const people = g.people.slice().sort((a, b) => (b.active - a.active) || (b.subs - a.subs) || (b.orders - a.orders));
    const done = people.every((p) => primaryOf(lk.map, p.phone) === primaryOf(lk.map, people[0].phone));
    return {
      key: g.key, why: g.why, shown: g.shown, people,
      linked: done,
      // The one to suggest keeping: most active plans, then most subscriptions, then most orders.
      suggested: people[0].phone,
      bothActive: people.filter((p) => p.active > 0).length > 1,
    };
  });
  // Unresolved first, and inside that the ones where both sides have a live plan — those are the ones that cost money.
  groups.sort((a, b) => (a.linked - b.linked) || (b.bothActive - a.bothActive) || a.shown.localeCompare(b.shown));

  return {
    ok: true,
    needsSchema: !!lk.needsSchema,
    groups,
    totals: {
      groups: groups.length,
      open: groups.filter((g) => !g.linked).length,
      linked: groups.filter((g) => g.linked).length,
      bothActive: groups.filter((g) => !g.linked && g.bothActive).length,
      people: groups.reduce((t, g) => t + g.people.length, 0),
    },
  };
}

function mount(app, deps) {
  const { auth } = deps;
  const db = deps.db || require('./db');
  const query = (sql, p) => db.query(sql, p || []);
  const audit = deps.audit || { record: () => {} };
  const now = deps.now || (() => Date.now());
  const fail = (res, e) => {
    if (noTable(e)) return res.json({ ok: false, needsSchema: true, message: 'Run db/schema-v33.sql in phpMyAdmin first — it makes the one table this screen needs.' });
    return res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  };

  app.get('/admin/api/duplicates', async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await overview(query, now())); } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/duplicates/link', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const primary = norm(b.primary);
    const others = [...new Set((Array.isArray(b.phones) ? b.phones : []).map(norm).filter(Boolean))].filter((p) => p !== primary);
    const undo = s(b.action) === 'unlink';
    try {
      if (undo) {
        const list = [...new Set((Array.isArray(b.phones) ? b.phones : []).map(norm).filter(Boolean))];
        if (!list.length) return res.status(400).json({ ok: false, message: 'Which accounts?' });
        for (const p of list) await query('DELETE FROM customer_links WHERE phone_norm = ? LIMIT 1', [p]);
        audit.record(req, { action: 'customer.unlink', entity: 'customer', id: list.join(','), summary: '🧑‍🤝‍🧑 ' + list.length + ' account(s) no longer treated as the same person' });
        return res.json(await overview(query, now()));
      }
      if (!primary) return res.status(400).json({ ok: false, message: 'Pick which account to keep as the real one.' });
      if (!others.length) return res.status(400).json({ ok: false, message: 'Nothing to link to it.' });
      // Linking the account somebody else already points at would make a chain; refuse it rather than guess.
      const existing = (await links(query)).map;
      if (existing.has(primary)) return res.status(409).json({ ok: false, message: 'That account is already linked to another one. Unlink it first.' });
      const stamp = sqlNow(now());
      for (const p of others) {
        await query(
          'INSERT INTO customer_links (phone_norm, primary_phone, linked_at, linked_by, note) VALUES (?, ?, ?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE primary_phone = VALUES(primary_phone), linked_at = VALUES(linked_at), note = VALUES(note)',
          [p, primary, stamp, 'admin', s(b.note).slice(0, 200)]);
      }
      audit.record(req, {
        action: 'customer.link', entity: 'customer', id: primary,
        summary: '🧑‍🤝‍🧑 ' + others.length + ' account(s) marked as the same person as ' + primary,
        details: { primary, others },
      });
      res.json(await overview(query, now()));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, links, primaryOf, _internal: { overview, activity, nameKey, prettyDate, sqlNow } };
