/**
 * FluxFilm - Admin panel (read-only v1).
 * Serves a dashboard at GET /panel and JSON at /admin/api/*.
 * Reads MySQL. Protected by the admin key (same as CACHE_CLEAR_KEY).
 */

// Whitelisted tables + their searchable columns and default sort.
const TABLES = {
  orders:        { cols: 'order_id, created_at_sheet, service, plan, phone, name, email, final_amount, discount, status, fulfillment_status, order_type, txn_ref', order: 'created_at_sheet DESC', phone: 'phone_norm', like: ['order_id'] },
  subscriptions: { cols: 'sub_id, order_id, phone, service, plan, start_date, expiry_date, status, login_id, password, profile_name, profile_pin, inventory_ref', order: 'expiry_date DESC', phone: 'phone_norm', like: ['sub_id'] },
  customers:     { cols: 'phone, name, email, member_since', order: 'created_at DESC', phone: 'phone_norm', like: ['name', 'email'] },
  coupons:       { cols: 'code, description, type, value, active, show_in_profile, per_user_limit, expiry', order: 'code ASC', phone: null, like: ['code', 'description'] },
  wallet:        { cols: 'phone, coins_balance, coins_lifetime, last_event, last_earned_at', order: 'coins_balance DESC', phone: 'phone_norm', like: [] },
  coupon_usage:  { cols: 'ts, coupon_code, phone, discount, order_id, action', order: 'ts DESC', phone: 'phone_norm', like: ['coupon_code', 'order_id'] },
  plans:         { cols: 'service, plan, duration_days, price, early_renew_discount, is_active', order: 'service ASC', phone: null, like: ['service', 'plan'] },
};

const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };

function mountAdmin(app, deps) {
  const { db, ADMIN_KEY } = deps;
  const auth = (req, res) => {
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) { res.status(403).json({ ok: false, message: 'Unauthorized' }); return false; }
    return true;
  };

  // ---- KPI summary ----
  app.get('/admin/api/summary', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const one = async (sql, p) => { const r = await db.query(sql, p || []); return r[0] || {}; };
      const [cust, ord, sub, cpn, wal] = await Promise.all([
        one('SELECT COUNT(*) n FROM customers'),
        one("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status='PAID' THEN final_amount END),0) rev, SUM(status='PAID') paid FROM orders"),
        one("SELECT COUNT(*) n, SUM(status='ACTIVE') active, SUM(status='ACTIVE' AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL 7 DAY) expiring FROM subscriptions"),
        one('SELECT COUNT(*) n FROM coupons'),
        one('SELECT COALESCE(SUM(coins_balance),0) coins FROM wallet'),
      ]);
      res.json({ ok: true, kpis: {
        customers: +cust.n || 0,
        orders: +ord.n || 0, paidOrders: +ord.paid || 0, revenue: +ord.rev || 0,
        subs: +sub.n || 0, activeSubs: +sub.active || 0, expiring7d: +sub.expiring || 0,
        coupons: +cpn.n || 0, coinsOutstanding: +wal.coins || 0,
      } });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  // ---- Table browser ----
  app.get('/admin/api/table', async (req, res) => {
    if (!auth(req, res)) return;
    const name = String(req.query.name || '');
    const cfg = TABLES[name];
    if (!cfg) return res.status(400).json({ ok: false, message: 'Unknown table' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const q = String(req.query.q || '').trim();

    let where = ''; const params = [];
    if (q) {
      const clauses = [];
      if (cfg.phone && /\d/.test(q)) { clauses.push(`${cfg.phone} = ?`); params.push(norm(q)); }
      for (const c of cfg.like) { clauses.push(`${c} LIKE ?`); params.push('%' + q + '%'); }
      if (clauses.length) where = 'WHERE ' + clauses.join(' OR ');
    }
    try {
      const rows = await db.query(`SELECT ${cfg.cols} FROM \`${name}\` ${where} ORDER BY ${cfg.order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
      const totalRow = await db.query(`SELECT COUNT(*) n FROM \`${name}\` ${where}`, params);
      const columns = rows.length ? Object.keys(rows[0]) : cfg.cols.split(',').map((x) => x.trim());
      res.json({ ok: true, table: name, columns, rows, total: +(totalRow[0] || {}).n || 0, limit, offset });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  // ---- Customer 360 ----
  app.get('/admin/api/customer', async (req, res) => {
    if (!auth(req, res)) return;
    const ph = norm(req.query.phone);
    if (!ph) return res.status(400).json({ ok: false, message: 'phone required' });
    try {
      const [profile, orders, subs, wallet] = await Promise.all([
        db.query('SELECT phone, name, email, member_since FROM customers WHERE phone_norm = ? LIMIT 1', [ph]),
        db.query('SELECT order_id, created_at_sheet, service, plan, final_amount, status, fulfillment_status FROM orders WHERE phone_norm = ? ORDER BY created_at_sheet DESC LIMIT 50', [ph]),
        db.query('SELECT sub_id, service, plan, expiry_date, status, login_id, password FROM subscriptions WHERE phone_norm = ? ORDER BY expiry_date DESC', [ph]),
        db.query('SELECT coins_balance, coins_lifetime, last_event FROM wallet WHERE phone_norm = ? LIMIT 1', [ph]),
      ]);
      res.json({ ok: true, phone: ph, profile: profile[0] || null, orders, subs, wallet: wallet[0] || null });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  // ---- The dashboard page ----
  app.get('/panel', (_req, res) => res.type('html').send(PAGE));
}

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>FluxFilm Admin</title>
<style>
:root{--bg:#0f172a;--card:#fff;--mut:#64748b;--brand:#16a34a;--line:#e2e8f0}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f1f5f9;color:#0f172a}
header{background:#0f172a;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
header b{font-size:1.1rem}
.wrap{max-width:1100px;margin:0 auto;padding:16px}
.login{max-width:360px;margin:12vh auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 8px 40px rgba(15,23,42,.1);text-align:center}
input,select{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:10px}
button{font:inherit;font-weight:700;background:var(--brand);color:#fff;border:0;padding:9px 16px;border-radius:10px;cursor:pointer}
button.alt{background:#334155}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px}
.kpi .n{font-size:1.5rem;font-weight:800}.kpi .l{color:var(--mut);font-size:.8rem}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}
.tabs a{padding:7px 12px;border-radius:999px;background:#e2e8f0;color:#334155;cursor:pointer;font-size:.85rem;font-weight:600;text-decoration:none}
.tabs a.on{background:var(--brand);color:#fff}
.bar{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:.82rem}
th,td{padding:8px 10px;border-bottom:1px solid #eef2f7;text-align:left;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
th{background:#f8fafc;color:var(--mut);position:sticky;top:0}
tr:hover td{background:#f8fafc}
.muted{color:var(--mut);font-size:.85rem}
.pill{padding:2px 8px;border-radius:999px;font-size:.72rem;font-weight:700}
.PAID,.ACTIVE,.FULFILLED{background:#dcfce7;color:#166534}.CREATED,.PENDING,.EXPIRING{background:#fef9c3;color:#854d0e}
.CANCELLED,.EXPIRED,.FAILED{background:#fee2e2;color:#991b1b}
</style></head><body>
<div id="app"></div>
<script>
const $=s=>document.querySelector(s);
let KEY=localStorage.getItem('ff_admin_key')||'';
let TAB='orders', OFFSET=0, Q='';
const TABLES=['orders','subscriptions','customers','coupons','wallet','coupon_usage','plans'];
const api=(path,params={})=>{const u=new URL(location.origin+path);u.searchParams.set('key',KEY);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));return fetch(u).then(r=>r.json());};
const money=n=>'₹'+Number(n||0).toLocaleString('en-IN');
const pill=v=>v?'<span class="pill '+String(v).toUpperCase().replace(/[^A-Z]/g,'')+'">'+v+'</span>':'';
const fmt=(k,v)=>{if(v==null||v==='')return '<span class="muted">—</span>';if(/amount|balance|lifetime|price|value|discount/.test(k))return money(v);if(/status/.test(k))return pill(v);if(/date|_at|expiry|ts|since/.test(k)&&String(v).length>10)return String(v).slice(0,16).replace('T',' ');return String(v);};

function login(){ $('#app').innerHTML='<div class="login"><h2>🔐 FluxFilm Admin</h2><p class="muted">Enter the admin key.</p><input id="k" type="password" placeholder="admin key" style="width:100%;margin:10px 0"/><button onclick="doLogin()" style="width:100%">Enter</button><div id="err" style="color:#dc2626;margin-top:8px"></div></div>'; }
function doLogin(){ KEY=$('#k').value.trim(); api('/admin/api/summary').then(r=>{ if(r.ok){localStorage.setItem('ff_admin_key',KEY);shell();load();} else {$('#err').textContent='Wrong key';} }); }
function logout(){ localStorage.removeItem('ff_admin_key'); KEY=''; login(); }

function shell(){ $('#app').innerHTML=
 '<header><b>🎬 FluxFilm Admin</b><button class="alt" onclick="logout()">Log out</button></header>'+
 '<div class="wrap"><div id="kpis" class="kpis"></div>'+
 '<div class="tabs">'+TABLES.map(t=>'<a onclick="go(\\''+t+'\\')" id="tab-'+t+'">'+t+'</a>').join('')+'</div>'+
 '<div class="bar"><input id="q" placeholder="Search phone / id / name…" style="flex:1;min-width:180px"/><button onclick="search()">Search</button>'+
 '<button class="alt" onclick="cust()">Customer 360</button></div>'+
 '<div id="content"></div></div>';
}
function go(t){TAB=t;OFFSET=0;Q='';$('#q').value='';load();}
function search(){Q=$('#q').value.trim();OFFSET=0;load();}

function load(){
 TABLES.forEach(t=>{const el=$('#tab-'+t);if(el)el.className=(t===TAB?'on':'');});
 api('/admin/api/summary').then(r=>{ if(!r.ok)return; const k=r.kpis; $('#kpis').innerHTML=[
   ['Customers',k.customers],['Orders',k.orders],['Paid revenue',money(k.revenue)],
   ['Active subs',k.activeSubs],['Expiring ≤7d',k.expiring7d],['Coins out',k.coinsOutstanding]
 ].map(([l,n])=>'<div class="kpi"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>').join(''); });
 api('/admin/api/table',{name:TAB,limit:50,offset:OFFSET,q:Q}).then(r=>{
   if(!r.ok){$('#content').innerHTML='<p class="muted">'+(r.message||'error')+'</p>';return;}
   const th=r.columns.map(c=>'<th>'+c+'</th>').join('');
   const rows=r.rows.map(row=>'<tr>'+r.columns.map(c=>'<td>'+fmt(c,row[c])+'</td>').join('')+'</tr>').join('');
   const pg='<div class="bar"><span class="muted">'+(r.total)+' rows</span>'+
     (OFFSET>0?'<button class="alt" onclick="page(-1)">‹ Prev</button>':'')+
     (OFFSET+50<r.total?'<button class="alt" onclick="page(1)">Next ›</button>':'')+'</div>';
   $('#content').innerHTML='<div class="card"><table><thead><tr>'+th+'</tr></thead><tbody>'+(rows||'<tr><td class="muted">No rows</td></tr>')+'</tbody></table></div>'+pg;
 });
}
function page(d){OFFSET=Math.max(0,OFFSET+d*50);load();}
function cust(){ const p=prompt('Customer phone number:'); if(!p)return;
 api('/admin/api/customer',{phone:p}).then(r=>{
   if(!r.ok){alert(r.message||'error');return;}
   const pr=r.profile||{}; const box=(title,html)=>'<div class="card" style="margin:10px 0;padding:12px"><b>'+title+'</b>'+html+'</div>';
   const tbl=(arr,cols)=>arr&&arr.length?'<table><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+arr.map(o=>'<tr>'+cols.map(c=>'<td>'+fmt(c,o[c])+'</td>').join('')+'</tr>').join('')+'</tbody></table>':'<p class="muted">none</p>';
   $('#content').innerHTML=box('👤 '+(pr.name||'Unknown')+' — '+r.phone, '<div class="muted">'+(pr.email||'')+' · member since '+fmt('since',pr.member_since)+'</div>')
     +box('🎬 Subscriptions', tbl(r.subs,['sub_id','service','plan','expiry_date','status','login_id','password']))
     +box('🧾 Orders', tbl(r.orders,['order_id','created_at_sheet','service','plan','final_amount','status']))
     +box('🪙 Wallet', r.wallet?('Balance: '+money(r.wallet.coins_balance)+' · Lifetime: '+money(r.wallet.coins_lifetime)):'<p class="muted">no wallet</p>');
 });
}

if(KEY){ api('/admin/api/summary').then(r=>{ if(r.ok){shell();load();} else login(); }); } else login();
</script></body></html>`;

module.exports = { mountAdmin };
