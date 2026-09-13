/**
 * FluxFilm - one physical account per login.
 *
 * INVENTORY_ACCOUNTS can list the same real login several times: once per
 * duration it is sold for (Zee5 `Z5-01` ×4), and sometimes under DIFFERENT
 * AccountIDs (JioHotstar `JH-3M-02`, `JH-6M-02`, `JH-1Y-02` are one login).
 * Capacity and occupancy belong to the login, not to the row — otherwise a login
 * listed under three IDs could be sold three times over. The Apps Script counted
 * per LoginId for the same reason.
 *
 * Used by the whole-account and OTP allocators (fulfill.js) and by stock.js, so
 * the badge and the allocation always agree.
 */

/** Normalise a login the same way MySQL `LOWER(TRIM(x))` does (TRIM strips spaces only). */
function loginKey(v) {
  return String(v == null ? '' : v).replace(/^ +| +$/g, '').toLowerCase();
}

/**
 * rows:   [{ account_id, key }]  — key = normalised login ('' when unknown)
 * caps:   inventory_capacity rows for the same service
 * usedOf: (accountId) => occupied devices recorded against that AccountID
 *
 * A group's capacity is the LOWEST positive MaxTotal set on any of its IDs
 * (1 when none is set), it is inactive if any of its capacity rows says FALSE,
 * and its usage is the sum over every ID sharing the login.
 */
function buildLoginGroups(rows, caps, usedOf) {
  const groups = new Map();
  const groupOfId = new Map();
  const groupFor = (key) => {
    if (!groups.has(key)) groups.set(key, { key, ids: new Set(), explicit: [], inactive: false });
    return groups.get(key);
  };
  for (const r of rows || []) {
    const id = String(r.account_id == null ? '' : r.account_id).trim();
    if (!id) continue;
    const g = groupFor(r.key ? 'L:' + r.key : 'id:' + id); // rows without a login never merge
    g.ids.add(id);
    if (!groupOfId.has(id)) groupOfId.set(id, g);
  }
  for (const c of caps || []) {
    const id = String(c.account_id == null ? '' : c.account_id).trim();
    if (!id) continue;
    let g = groupOfId.get(id);
    if (!g) { g = groupFor('id:' + id); g.ids.add(id); groupOfId.set(id, g); }
    const max = parseFloat(c.max_total);
    if (max > 0) g.explicit.push(max);
    if (String(c.is_active == null ? '' : c.is_active).toUpperCase() === 'FALSE') g.inactive = true;
  }
  for (const g of groups.values()) {
    g.maxTotal = g.explicit.length ? Math.min(...g.explicit) : 1;
    g.isActive = !g.inactive;
    g.used = 0;
    for (const id of g.ids) g.used += Number(usedOf(id)) || 0;
  }
  return {
    forId(id) {
      const k = String(id);
      return groupOfId.get(k) || { key: 'id:' + k, ids: new Set([k]), maxTotal: 1, isActive: true, used: Number(usedOf(k)) || 0 };
    },
    all: () => [...groups.values()],
  };
}

module.exports = { loginKey, buildLoginGroups };
