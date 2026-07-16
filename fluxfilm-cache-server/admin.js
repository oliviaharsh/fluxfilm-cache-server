/**
 * FluxFilm - Admin panel v2 (read-only + charts + expiring).
 * GET /panel serves the dashboard; /admin/api/* return JSON. Key-protected.
 */

const TABLES = {
  orders:        { cols: 'order_id, created_at_sheet, service, plan, phone, name, email, final_amount, discount, status, fulfillment_status, order_type, txn_ref', order: 'created_at_sheet DESC', phone: 'phone_norm', like: ['order_id'] },
  subscriptions: { cols: 'sub_id, order_id, phone, service, plan, start_date, expiry_date, status, login_id, password, profile_name, profile_pin, inventory_ref', order: 'expiry_date DESC', phone: 'phone_norm', like: ['sub_id'] },
  customers:     { cols: 'phone, name, email, member_since', order: 'created_at DESC', phone: 'phone_norm', like: ['name', 'email'] },
  coupons:       { cols: 'code, description, type, value, active, show_in_profile, per_user_limit, expiry', order: 'code ASC', phone: null, like: ['code', 'description'] },
  wallet:        { cols: 'phone, coins_balance, coins_lifetime, last_event, last_earned_at', order: 'coins_balance DESC', phone: 'phone_norm', like: [] },
  coupon_usage:  { cols: 'ts, coupon_code, phone, discount, order_id, action', order: 'ts DESC', phone: 'phone_norm', like: ['coupon_code', 'order_id'] },
  plans:         { cols: 'service, plan, duration_days, price, early_renew_discount, is_active', order: 'service ASC', phone: null, like: ['service', 'plan'] },
  inventory_accounts: { cols: 'service, account_id, login_id, password, is_active, plan', order: 'service ASC', phone: null, like: ['account_id', 'login_id', 'service'] },
  inventory_profiles: { cols: 'service, account_id, profile_name, profile_number, status, current_sub_id', order: 'account_id ASC', phone: null, like: ['account_id', 'profile_name', 'current_sub_id'] },
  inventory_capacity: { cols: 'service, account_id, max_total, max_tv, is_active', order: 'account_id ASC', phone: null, like: ['account_id', 'service'] },
  bank_credits: { cols: 'received_at, amount, upi_ref, order_ids, consumed_order_id', order: 'received_at DESC', phone: null, like: ['upi_ref', 'order_ids', 'consumed_order_id'] },
};
const norm = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? d.slice(-10) : ''; };

function mountAdmin(app, deps) {
  const { db, ADMIN_KEY } = deps;
  const auth = (req, res) => {
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) { res.status(403).json({ ok: false, message: 'Unauthorized' }); return false; }
    return true;
  };

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
        customers: +cust.n || 0, orders: +ord.n || 0, paidOrders: +ord.paid || 0, revenue: +ord.rev || 0,
        subs: +sub.n || 0, activeSubs: +sub.active || 0, expiring7d: +sub.expiring || 0,
        coupons: +cpn.n || 0, coinsOutstanding: +wal.coins || 0,
      } });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  app.get('/admin/api/charts', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const [rev, svc, status] = await Promise.all([
        db.query("SELECT DATE(created_at_sheet) d, COALESCE(SUM(final_amount),0) rev, COUNT(*) n FROM orders WHERE status='PAID' AND created_at_sheet >= (CURDATE() - INTERVAL 29 DAY) GROUP BY DATE(created_at_sheet) ORDER BY d", []),
        db.query("SELECT service, COUNT(*) n, COALESCE(SUM(final_amount),0) rev FROM orders WHERE status='PAID' GROUP BY service ORDER BY n DESC LIMIT 8", []),
        db.query('SELECT status, COUNT(*) n FROM orders GROUP BY status ORDER BY n DESC', []),
      ]);
      res.json({ ok: true, revenueByDay: rev, serviceBreakdown: svc, statusBreakdown: status });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  app.get('/admin/api/expiring', async (req, res) => {
    if (!auth(req, res)) return;
    const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 7));
    try {
      const rows = await db.query(
        `SELECT sub_id, phone, email, service, plan, expiry_date FROM subscriptions
         WHERE status='ACTIVE' AND expiry_date IS NOT NULL
           AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL ? DAY
         ORDER BY expiry_date ASC LIMIT 300`, [days]);
      res.json({ ok: true, days, rows });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

  app.get('/admin/api/table', async (req, res) => {
    if (!auth(req, res)) return;
    const name = String(req.query.name || ''); const cfg = TABLES[name];
    if (!cfg) return res.status(400).json({ ok: false, message: 'Unknown table' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const q = String(req.query.q || '').trim();
    let where = ''; const params = [];
    if (q) {
      const clauses = [];
      if (cfg.phone && /\d/.test(q)) { clauses.push(cfg.phone + ' = ?'); params.push(norm(q)); }
      for (const c of cfg.like) { clauses.push(c + ' LIKE ?'); params.push('%' + q + '%'); }
      if (clauses.length) where = 'WHERE ' + clauses.join(' OR ');
    }
    try {
      const rows = await db.query('SELECT ' + cfg.cols + ' FROM `' + name + '` ' + where + ' ORDER BY ' + cfg.order + ' LIMIT ? OFFSET ?', [...params, limit, offset]);
      const totalRow = await db.query('SELECT COUNT(*) n FROM `' + name + '` ' + where, params);
      const columns = rows.length ? Object.keys(rows[0]) : cfg.cols.split(',').map((x) => x.trim());
      res.json({ ok: true, table: name, columns, rows, total: +(totalRow[0] || {}).n || 0, limit, offset });
    } catch (e) { res.status(500).json({ ok: false, message: String(e && e.message || e) }); }
  });

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

  app.get('/panel', (_req, res) => res.type('html').send(PAGE));
}

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>FluxFilm Admin</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
:root{--brand:#16a34a;--brand2:#22c55e;--ink:#0f172a;--mut:#64748b;--line:#e8edf3;--bg:#f6f8fb}
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:linear-gradient(100deg,#0f172a,#1e293b);color:#fff;padding:14px 22px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
header b{font-size:1.15rem;letter-spacing:.2px}
.wrap{max-width:1180px;margin:0 auto;padding:18px}
.nav{display:flex;gap:6px;margin:2px 0 18px;flex-wrap:wrap}
.nav a{padding:9px 16px;border-radius:12px;background:#fff;border:1px solid var(--line);color:#334155;cursor:pointer;font-weight:600;font-size:.9rem}
.nav a.on{background:var(--brand);color:#fff;border-color:var(--brand);box-shadow:0 4px 14px rgba(22,163,74,.28)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 2px 10px rgba(15,23,42,.04)}
.kpi .n{font-size:1.7rem;font-weight:800;line-height:1.1}.kpi .l{color:var(--mut);font-size:.78rem;margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
.kpi .ic{float:right;font-size:1.3rem;opacity:.9}
.grid2{display:grid;grid-template-columns:1.6fr 1fr;gap:16px}@media(max-width:820px){.grid2{grid-template-columns:1fr}}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 2px 10px rgba(15,23,42,.04);margin-bottom:16px}
.card h3{margin:0 0 12px;font-size:1rem}
.tblwrap{overflow:auto;border:1px solid var(--line);border-radius:16px;background:#fff}
table{border-collapse:collapse;width:100%;font-size:.83rem}
th,td{padding:9px 12px;border-bottom:1px solid #f1f5f9;text-align:left;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
th{background:#f8fafc;color:var(--mut);position:sticky;top:0;font-weight:600}
tr:hover td{background:#f9fbfd}
input,button{font:inherit}input{padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:#fff}
button{font-weight:700;background:var(--brand);color:#fff;border:0;padding:10px 16px;border-radius:12px;cursor:pointer}
button.alt{background:#334155}button.wa{background:#25d366;padding:6px 12px;font-size:.8rem;border-radius:9px}
.bar{display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap}
.muted{color:var(--mut)}
.pill{padding:3px 9px;border-radius:999px;font-size:.72rem;font-weight:700;display:inline-block}
.PAID,.ACTIVE,.FULFILLED{background:#dcfce7;color:#166534}.CREATED,.PENDING{background:#fef9c3;color:#854d0e}
.CANCELLED,.EXPIRED,.FAILED,.MANUALPENDING{background:#fee2e2;color:#991b1b}
.days{font-weight:800;padding:3px 9px;border-radius:999px;background:#fee2e2;color:#991b1b}
.days.ok{background:#fef9c3;color:#854d0e}
.login{max-width:360px;margin:12vh auto;background:#fff;padding:30px;border-radius:18px;box-shadow:0 12px 50px rgba(15,23,42,.12);text-align:center}
canvas{max-height:260px}
</style></head><body><div id="app"></div>
<script>
var $=function(s){return document.querySelector(s)};
var KEY=localStorage.getItem('ff_admin_key')||'';
var VIEW='dashboard',TAB='orders',OFFSET=0,Q='',charts={};
var TBLS=['orders','subscriptions','customers','coupons','wallet','coupon_usage','plans','inventory_accounts','inventory_profiles','inventory_capacity','bank_credits'];
function api(path,params){var u=new URL(location.origin+path);u.searchParams.set('key',KEY);params=params||{};Object.keys(params).forEach(function(k){u.searchParams.set(k,params[k])});return fetch(u).then(function(r){return r.json()})}
function money(n){return '₹'+Number(n||0).toLocaleString('en-IN')}
function pill(v){return v?'<span class="pill '+String(v).toUpperCase().replace(/[^A-Z]/g,'')+'">'+v+'</span>':''}
function fmt(k,v){if(v==null||v==='')return '<span class="muted">—</span>';if(/amount|balance|lifetime|price|value|discount/.test(k))return money(v);if(/status|action/.test(k))return pill(v);if((/date|_at|expiry|ts|since/.test(k))&&String(v).length>10)return String(v).slice(0,16).replace('T',' ');return String(v)}
function waLink(phone,text){var p=String(phone||'').replace(/\\D/g,'');if(p.length===10)p='91'+p;return 'https://wa.me/'+p+'?text='+encodeURIComponent(text)}

function login(){$('#app').innerHTML='<div class="login"><h2>🔐 FluxFilm Admin</h2><p class="muted">Enter the admin key.</p><input id="k" type="password" placeholder="admin key" style="width:100%;margin:12px 0"/><button onclick="doLogin()" style="width:100%">Enter</button><div id="err" style="color:#dc2626;margin-top:8px"></div></div>'}
function doLogin(){KEY=$('#k').value.trim();api('/admin/api/summary').then(function(r){if(r.ok){localStorage.setItem('ff_admin_key',KEY);shell();route()}else{$('#err').textContent='Wrong key'}})}
function logout(){localStorage.removeItem('ff_admin_key');KEY='';login()}
function nav(v){VIEW=v;route()}

function shell(){$('#app').innerHTML='<header><b>🎬 FluxFilm Admin</b><button class="alt" onclick="logout()">Log out</button></header>'+
 '<div class="wrap"><div class="nav">'+
 [['dashboard','📊 Dashboard'],['data','📄 Data'],['expiring','⏳ Expiring'],['customer','👤 Customer 360']]
 .map(function(x){return '<a id="nav-'+x[0]+'" onclick="nav(\\''+x[0]+'\\')">'+x[1]+'</a>'}).join('')+
 '</div><div id="view"></div></div>'}

function route(){TBLS.forEach(function(){});['dashboard','data','expiring','customer'].forEach(function(v){var e=$('#nav-'+v);if(e)e.className=(v===VIEW?'on':'')});
 if(VIEW==='dashboard')dashboard();else if(VIEW==='data')dataView();else if(VIEW==='expiring')expiring();else customer()}

function dashboard(){
 $('#view').innerHTML='<div id="kpis" class="kpis"></div><div class="grid2"><div class="card"><h3>💰 Revenue — last 30 days</h3><canvas id="cRev"></canvas></div><div class="card"><h3>📈 Orders by status</h3><canvas id="cStatus"></canvas></div></div><div class="card"><h3>🎥 Top services (paid orders)</h3><canvas id="cSvc"></canvas></div>';
 api('/admin/api/summary').then(function(r){if(!r.ok)return;var k=r.kpis;$('#kpis').innerHTML=[
   ['👥','Customers',k.customers],['🧾','Orders',k.orders],['💰','Paid revenue',money(k.revenue)],
   ['🎬','Active subs',k.activeSubs],['⏳','Expiring ≤7d',k.expiring7d],['🪙','Coins out',k.coinsOutstanding]
 ].map(function(c){return '<div class="kpi"><span class="ic">'+c[0]+'</span><div class="n">'+c[2]+'</div><div class="l">'+c[1]+'</div></div>'}).join('')});
 api('/admin/api/charts').then(function(r){if(!r.ok)return;
   Object.keys(charts).forEach(function(k){try{charts[k].destroy()}catch(e){}});
   var rev=r.revenueByDay||[];
   charts.rev=new Chart($('#cRev'),{type:'line',data:{labels:rev.map(function(x){return String(x.d).slice(5,10)}),datasets:[{label:'₹ revenue',data:rev.map(function(x){return +x.rev}),borderColor:'#16a34a',backgroundColor:'rgba(22,163,74,.12)',fill:true,tension:.35}]},options:{plugins:{legend:{display:false}},maintainAspectRatio:false}});
   var st=r.statusBreakdown||[];
   charts.status=new Chart($('#cStatus'),{type:'doughnut',data:{labels:st.map(function(x){return x.status||'?'}),datasets:[{data:st.map(function(x){return +x.n}),backgroundColor:['#16a34a','#f59e0b','#ef4444','#6366f1','#64748b']}]},options:{maintainAspectRatio:false}});
   var sv=r.serviceBreakdown||[];
   charts.svc=new Chart($('#cSvc'),{type:'bar',data:{labels:sv.map(function(x){return x.service||'?'}),datasets:[{label:'orders',data:sv.map(function(x){return +x.n}),backgroundColor:'#22c55e'}]},options:{plugins:{legend:{display:false}},maintainAspectRatio:false}});
 })}

function dataView(){
 $('#view').innerHTML='<div class="nav">'+TBLS.map(function(t){return '<a id="t-'+t+'" onclick="go(\\''+t+'\\')">'+t+'</a>'}).join('')+'</div>'+
  '<div class="bar"><input id="q" placeholder="Search phone / id / name…" style="flex:1;min-width:200px" onkeydown="if(event.key===\\'Enter\\')search()"/><button onclick="search()">Search</button></div><div id="tbl"></div>';
 loadTable()}
function go(t){TAB=t;OFFSET=0;Q='';loadTable()}
function search(){Q=$('#q').value.trim();OFFSET=0;loadTable()}
function page(d){OFFSET=Math.max(0,OFFSET+d*50);loadTable()}
function loadTable(){TBLS.forEach(function(t){var e=$('#t-'+t);if(e)e.className=(t===TAB?'on':'')});
 api('/admin/api/table',{name:TAB,limit:50,offset:OFFSET,q:Q}).then(function(r){
  if(!r.ok){$('#tbl').innerHTML='<p class="muted">'+(r.message||'error')+'</p>';return}
  var th=r.columns.map(function(c){return '<th>'+c+'</th>'}).join('');
  var rows=r.rows.map(function(row){return '<tr>'+r.columns.map(function(c){return '<td>'+fmt(c,row[c])+'</td>'}).join('')+'</tr>'}).join('');
  var pg='<div class="bar" style="margin-top:12px"><span class="muted">'+r.total+' rows</span>'+(OFFSET>0?'<button class="alt" onclick="page(-1)">‹ Prev</button>':'')+(OFFSET+50<r.total?'<button class="alt" onclick="page(1)">Next ›</button>':'')+'</div>';
  $('#tbl').innerHTML='<div class="tblwrap"><table><thead><tr>'+th+'</tr></thead><tbody>'+(rows||'<tr><td class="muted">No rows</td></tr>')+'</tbody></table></div>'+pg})}

function expiring(){
 $('#view').innerHTML='<div class="card"><h3>⏳ Subscriptions expiring soon</h3><div class="bar"><span class="muted">Window:</span><button class="alt" onclick="loadExp(7)">7 days</button><button class="alt" onclick="loadExp(15)">15 days</button><button class="alt" onclick="loadExp(30)">30 days</button></div><div id="exp"></div></div>';
 loadExp(7)}
function loadExp(days){api('/admin/api/expiring',{days:days}).then(function(r){
  if(!r.ok){$('#exp').innerHTML='<p class="muted">'+(r.message||'error')+'</p>';return}
  if(!r.rows.length){$('#exp').innerHTML='<p class="muted">🎉 Nothing expiring in the next '+days+' days.</p>';return}
  var now=Date.now();
  var rows=r.rows.map(function(s){
    var exp=new Date(String(s.expiry_date).replace(' ','T'));var dl=Math.ceil((exp.getTime()-now)/86400000);
    var msg='Hi! Your FluxFilm '+s.service+' ('+s.plan+') expires in '+dl+' day(s). Renew now to keep it active 🙏';
    return '<tr><td><span class="days'+(dl>3?' ok':'')+'">'+dl+'d</span></td><td>'+(s.service||'')+'</td><td>'+(s.plan||'')+'</td><td>'+String(s.expiry_date).slice(0,10)+'</td><td>'+(s.phone||'')+'</td><td class="muted">'+(s.email||'')+'</td><td><a href="'+waLink(s.phone,msg)+'" target="_blank"><button class="wa">💬 WhatsApp</button></a></td></tr>'}).join('');
  $('#exp').innerHTML='<div class="tblwrap"><table><thead><tr><th>Left</th><th>Service</th><th>Plan</th><th>Expiry</th><th>Phone</th><th>Email</th><th>Reach out</th></tr></thead><tbody>'+rows+'</tbody></table></div>'})}

function customer(){
 $('#view').innerHTML='<div class="bar"><input id="cp" placeholder="Customer phone number…" style="flex:1;min-width:200px" onkeydown="if(event.key===\\'Enter\\')lookup()"/><button onclick="lookup()">Look up</button></div><div id="c360"></div>'}
function lookup(){var p=$('#cp').value.trim();if(!p)return;api('/admin/api/customer',{phone:p}).then(function(r){
  if(!r.ok){$('#c360').innerHTML='<p class="muted">'+(r.message||'error')+'</p>';return}
  var pr=r.profile||{};
  function box(t,h){return '<div class="card"><h3>'+t+'</h3>'+h+'</div>'}
  function tbl(arr,cols){return arr&&arr.length?'<div class="tblwrap"><table><thead><tr>'+cols.map(function(c){return '<th>'+c+'</th>'}).join('')+'</tr></thead><tbody>'+arr.map(function(o){return '<tr>'+cols.map(function(c){return '<td>'+fmt(c,o[c])+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>':'<p class="muted">none</p>'}
  $('#c360').innerHTML=box('👤 '+(pr.name||'Unknown')+' — '+r.phone,'<div class="muted">'+(pr.email||'')+' · member since '+fmt('since',pr.member_since)+'</div>')+
    box('🎬 Subscriptions ('+r.subs.length+')',tbl(r.subs,['sub_id','service','plan','expiry_date','status','login_id','password']))+
    box('🧾 Orders ('+r.orders.length+')',tbl(r.orders,['order_id','created_at_sheet','service','plan','final_amount','status']))+
    box('🪙 Wallet',r.wallet?('Balance: <b>'+money(r.wallet.coins_balance)+'</b> · Lifetime: '+money(r.wallet.coins_lifetime)):'<p class="muted">no wallet</p>')})}

if(KEY){api('/admin/api/summary').then(function(r){if(r.ok){shell();route()}else login()})}else login();
</script></body></html>`;

module.exports = { mountAdmin };
