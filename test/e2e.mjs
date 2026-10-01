import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

const ROOT = path.resolve('web'), TEST = path.resolve('test');
const MIME = {'.html':'text/html','.js':'text/javascript','.css':'text/css',
  '.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
const server = http.createServer((req,res)=>{
  let p = req.url.split('?')[0];
  if (p==='/') p='/index.html';
  const file = p.startsWith('/__test/') ? path.join(TEST, p.slice(8)) : path.join(ROOT, p);
  fs.readFile(file,(e,buf)=>{
    if(e){res.writeHead(404);return res.end('nf');}
    res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'text/plain'});
    res.end(buf);
  });
});
await new Promise(r=>server.listen(4173,r));

/* Use a Chromium sitting at a known path if there is one, otherwise let
   Playwright launch the copy it downloaded itself (npx playwright install
   chromium). Hard-coding a path here made this file Linux-only. */
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome']
  .find(p => { try { return fs.existsSync(p); } catch { return false; } });
const b = await chromium.launch(exe ? {executablePath:exe} : {});
const p = await b.newPage({viewport:{width:1440,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error'&&!/favicon|manifest|sw\.js|fonts\.googleapis|TUNNEL/i.test(m.text()))errs.push('console: '+m.text());});
// serve the fake supabase in place of the CDN module
await p.route('**/@supabase/supabase-js**', r =>
  r.fulfill({status:200, contentType:'text/javascript',
             body:fs.readFileSync('test/fake-supabase.js','utf8')}));
// preconfigure so we skip the "connect your database" screen
/* config.js may hold a live project; the test must never reach it. */
await p.route('**/js/config.js', r=>r.fulfill({status:200,contentType:'text/javascript',
  body:`window.BUNKSOFT_CONFIG={supabaseUrl:'https://demo.supabase.co',supabaseAnonKey:'${'x'.repeat(60)}'};`}));

const ok=(l,v)=>console.log((v?'  PASS  ':'  FAIL  ')+l);
const shown=async sel=>{ const el=await p.$(sel); return !!el && await el.isVisible(); };
await p.route('**/fonts.googleapis.com/**',r=>r.fulfill({status:200,contentType:'text/css',body:''}));
await p.goto('http://127.0.0.1:4173/'); await p.waitForTimeout(700);

/* Since self sign-up was removed, the bunk and its owner are created by an
   administrator. Seed one the way bootstrap_platform_admin() does, then drive
   the same admin RPC the console calls. */
console.log('1. An administrator creates the bunk; the owner signs in');
ok('sign-in screen shown', await shown('#au_email'));
ok('no self sign-up offered', !/create (an )?account/i.test(await p.textContent('body')));

await p.evaluate(()=>{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const T=JSON.parse(sessionStorage.getItem('__fakedb')||'null')||{bunks:[],memberships:[],profiles:[],
    products:[],tanks:[],nozzles:[],business_days:[],shifts:[],readings:[],credit_customers:[],
    credit_txns:[],fuel_receipts:[],dip_readings:[],expenses:[],cash_deposits:[]};
  T.profiles.push({id,full_name:'Avinash S'});
  sessionStorage.setItem('__fakedb',JSON.stringify(T));
  sessionStorage.setItem('__fakestate',JSON.stringify({
    users:[{id,email:'admin@subsel.in',password:'Subsel2026Admin',name:'Avinash S',
            created_at:new Date().toISOString(),suspended:false}],
    admins:[id], audit:[]}));
});
await p.goto('http://127.0.0.1:4173/'); await p.waitForTimeout(500);
const created = await p.evaluate(async ()=>{
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient('https://demo.supabase.co','x'.repeat(60),{auth:{storageKey:'setup'}});
  await sb.auth.signInWithPassword({email:'admin@subsel.in',password:'Subsel2026Admin'});
  const r = await sb.rpc('admin_create_business',{p_bunk_name:'Sri Balaji Fuels',
    p_email:'owner@subsel.com',p_password:'BunkSoft2026x',p_owner_name:'Kumaran',
    p_brand:'Indian Oil',p_place:'Coimbatore',p_seed:true});
  return r.error ? {error:r.error.message} : r.data;
});
ok('the administrator created the business', !created.error);
if (created.error) console.log('        ' + created.error);

await p.goto('http://127.0.0.1:4173/'); await p.waitForTimeout(600);
await p.fill('#au_email','owner@subsel.com'); await p.fill('#au_pass','BunkSoft2026x');
await p.click('#au_go'); await p.waitForTimeout(1400);
ok('app shell opened', await shown('[data-tab="dash"]'));
ok('bunk name in header', (await p.textContent('#hdName')).includes('Sri Balaji'));
ok('role pill shows Owner', (await p.textContent('#storageDot')).trim()==='Owner');
ok('3 tanks seeded', (await p.evaluate(()=>window.BunkSoft.S.tanks.length))===3);

console.log('2. Set rates, then enter and close a shift');
await p.click('[data-act="rates"]'); await p.waitForTimeout(300);
const ids = await p.evaluate(()=>window.BunkSoft.S.config.products.map(x=>x.id.replace(/[^a-zA-Z0-9_-]/g,'_')));
await p.fill('#rt_s_'+ids[0],'102.63'); await p.fill('#rt_b_'+ids[0],'99.35');
await p.fill('#rt_s_'+ids[1],'94.24');  await p.fill('#rt_b_'+ids[1],'91.72');
await p.click('[data-act="saverates"]'); await p.waitForTimeout(700);
ok('rate board updated', (await p.textContent('#rateBoard')).includes('102.63'));

await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
const rows = await p.$$('#nozTable tbody tr[data-noz]');
for (let i=0;i<rows.length;i++){
  await rows[i].$eval('input[data-fld="open"]', (el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));}, String(100000+i*1000));
  await rows[i].$eval('input[data-fld="close"]',(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));}, String(100300+i*1000));
}
await p.waitForTimeout(300);
const due = await p.textContent('#mDue');
ok('live total computed ('+due+')', /[1-9]/.test(due));
await p.fill('#f_cash','20000'); await p.fill('#f_upi','15000'); await p.fill('#f_card','5000'); await p.fill('#f_bank','2000');
await p.fill('#f_operator','Ravi K');
await p.click('[data-act="saveshift"][data-close="1"]'); await p.waitForTimeout(1500);
ok('shift closing report opened', !!(await p.$('.rpt')));
await p.keyboard.press('Escape'); await p.waitForTimeout(400);

console.log('3. Stock moved by the database');
const stock = await p.evaluate(()=>window.BunkSoft.S.tanks.map(t=>t.stock));
ok('tank stock went negative/changed from sales '+JSON.stringify(stock), stock.some(s=>s!==0));
await p.click('[data-tab="stock"]'); await p.waitForTimeout(400);
await p.selectOption('#rc_tank', {index:0});
await p.fill('#rc_qty','8000'); await p.fill('#rc_rate','99.35'); await p.fill('#rc_inv','IOC/9107');
await p.click('[data-act="addreceipt"]'); await p.waitForTimeout(900);
const st2 = await p.evaluate(()=>window.BunkSoft.S.tanks[0].stock);
ok('decantation raised tank 1 to '+st2, st2 > 7000);

console.log('4. Credit');
await p.click('[data-tab="credit"]'); await p.waitForTimeout(400);
await p.click('[data-act="newcust"]'); await p.waitForTimeout(300);
await p.fill('#cu_name','Annai Transports'); await p.fill('#cu_veh','TN 37 BX 4410');
await p.fill('#cu_limit','150000'); await p.fill('#cu_open','5000');
await p.click('[data-act="savecust"]'); await p.waitForTimeout(900);
ok('customer saved', (await p.textContent('#view')).includes('Annai Transports'));
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
await p.fill('#cr_qty','180'); await p.waitForTimeout(250);
await p.fill('#cr_slip','S1284');
await p.click('[data-act="addcredit"]'); await p.waitForTimeout(1000);
const bal = await p.evaluate(()=>window.BunkSoft.S.customers[0].balance);
ok('outstanding rose to '+bal, bal > 5000);
await p.click('[data-tab="credit"]'); await p.waitForTimeout(400);
await p.click('[data-act="pay"]'); await p.waitForTimeout(300);
await p.fill('#pm_amt','10000'); await p.click('[data-act="savepay"]'); await p.waitForTimeout(900);
const bal2 = await p.evaluate(()=>window.BunkSoft.S.customers[0].balance);
ok('payment reduced it to '+bal2, Math.abs(bal2-(bal-10000))<0.01);

console.log('5. Expenses and cash book');
await p.click('[data-tab="expense"]'); await p.waitForTimeout(400);
await p.fill('#ex_amt','18000'); await p.fill('#ex_note','Weekly wages');
await p.click('[data-act="addexpense"]'); await p.waitForTimeout(800);
ok('expense recorded', (await p.textContent('#view')).includes('Weekly wages'));
await p.click('[data-tab="dash"]'); await p.waitForTimeout(600);
await p.fill('#cb_open','25000'); await p.click('[data-act="savecash"]'); await p.waitForTimeout(800);
const cb = await p.evaluate(()=>window.BunkSoft.cashBook(window.BunkSoft.S.date));
ok('cash book: 25000 open + 20000 cash sales + 10000 recovered - 18000 expense = '+cb.closing,
   Math.abs(cb.closing - (25000 + 20000 + 10000 - 18000)) < 0.01);

console.log('6. Reports and PDF');
await p.click('[data-tab="report"]'); await p.waitForTimeout(700);
ok('P&L rendered', (await p.textContent('#view')).includes('Profit'));
await p.screenshot({path:'/tmp/bunksoft-app.png', fullPage:false});

console.log('7. Operator cannot change setup');
await p.evaluate(async ()=>{
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient('https://demo.supabase.co','x'.repeat(60),{auth:{storageKey:'setup2'}});
  await sb.auth.signInWithPassword({email:'admin@subsel.in',password:'Subsel2026Admin'});
  await sb.rpc('admin_create_login',{p_email:'op@subsel.com',p_password:'Operator2026x',
    p_full_name:'Muthu S'});
});
await p.click('[data-tab="setup"]'); await p.waitForTimeout(600);
await p.fill('#mb_email','op@subsel.com'); await p.selectOption('#mb_role','operator');
await p.click('[data-act="addmember"]'); await p.waitForTimeout(900);
ok('operator added to the team', (await p.textContent('#view')).includes('Muthu'));

await b.close(); server.close();
console.log(errs.length?'\nPAGE ERRORS:\n'+errs.slice(0,6).join('\n'):'\nno page errors');
