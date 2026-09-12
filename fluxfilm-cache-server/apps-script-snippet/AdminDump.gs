/*************** FluxFilm — Admin Tab Dump (for MySQL sync) ***************
 * Read-only. Returns every row of a tab as objects (header -> value),
 * so the Node sync can mirror it into MySQL.
 *
 * SETUP (one time):
 *  1) In the Apps Script editor, create a new file and paste this in.
 *  2) In HostingerBridge.gs, inside the ACTIONS = { ... } object, add:
 *         adminDumpTab: adminDumpTab,
 *  3) Deploy > Manage deployments > edit > Deploy (new version).
 *
 * Only these tabs are allowed (safety allow-list):
 *   CUSTOMERS, ORDERS, SUBSCRIPTIONS
 * Add more names to ALLOW below when you migrate more tables.
 ************************************************************************/

function adminDumpTab(tabName) {
  try {
    var ALLOW = { CUSTOMERS: 1, ORDERS: 1, SUBSCRIPTIONS: 1, PLANS: 1, COUPONS: 1, COUPON_USAGE: 1, WALLET: 1, INVENTORY_ACCOUNTS: 1, INVENTORY_PROFILES: 1, INVENTORY_CAPACITY: 1, TRENDING: 1 };
    var name = String(tabName || '').trim().toUpperCase();
    if (!ALLOW[name]) return { ok: false, message: 'Tab not allowed: ' + name };

    var sh = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sh) return { ok: false, message: 'Missing sheet: ' + name };

    var last = sh.getLastRow();
    if (last < 2) return { ok: true, result: { tab: name, headers: [], rows: [] } };

    var values = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
    var headers = values[0].map(function (h) { return String(h || '').trim(); });
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      if (r.join('').trim() === '') continue; // skip blank rows
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        var key = headers[c] || ('Col' + (c + 1));
        obj[key] = r[c];
      }
      rows.push(obj);
    }
    return { ok: true, result: { tab: name, headers: headers, rows: rows, count: rows.length } };
  } catch (e) {
    return { ok: false, message: 'adminDumpTab error: ' + (e && e.message ? e.message : e) };
  }
}
