/* ============================================================================
   BunkSoft — a database that has not had supabase/fixes.sql run on it
   Subsel Tech Solutions Pvt Ltd

   This is the situation that took the live site down on 13 October: the web
   app shipped expecting shifts.rates_at_close and readings.rollover_add, the
   migration had not been applied, and every shift save failed with
   "Could not find the 'rates_at_close' column of 'shifts' in the schema
   cache" — a message that means nothing to anyone standing at a forecourt.

   The app must now work on such a database: the shift saves, the money is
   right, and the owner is told plainly what to run. The features that depend
   on the migration are the ones switched off, and nothing else.

     node test/nomigration-e2e.mjs
   ========================================================================== */
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
await new Promise(r=>server.listen(4178,r));
const BASE='http://127.0.0.1:4178/';

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome','/opt/pw-browsers/chromium/chrome']
  .find(p => { try { return fs.existsSync(p); } catch { return false; } });
const b = await chromium.launch(exe ? {executablePath:exe} : {});
const p = await b.newPage({viewport:{width:1440,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error'&&!/favicon|manifest|sw\.js|fonts\.googleapis|TUNNEL|schema cache/i.test(m.text()))errs.push('console: '+m.text());});
await p.route('**/@supabase/supabase-js**', r =>
  r.fulfill({status:200, contentType:'text/javascript', body:fs.readFileSync('test/fake-supabase.js','utf8')}));
await p.route('**/js/config.js', r=>r.fulfill({status:200,contentType:'text/javascript',
  body:`window.BUNKSOFT_CONFIG={supabaseUrl:'https://demo.supabase.co',supabaseAnonKey:'${'x'.repeat(60)}'};`}));
await p.route('**/fonts.googleapis.com/**',r=>r.fulfill({status:200,contentType:'text/css',body:''}));

let pass=0, fail=0;
const ok=(l,v,extra)=>{ v?pass++:fail++; console.log((v?'  PASS  ':'  FAIL  ')+l+(v||extra===undefined?'':'\n         '+extra)); };
const near=(a,b,tol=0.5)=>Math.abs(Number(a)-Number(b))<tol;
const toastText = () => p.evaluate(()=>[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | '));

/* ---- a database WITHOUT the migration, and a bunk on it ---- */
await p.goto(BASE); await p.waitForTimeout(500);
await p.evaluate(()=>{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  sessionStorage.setItem('__nomigration','1');          // fixes.sql never run
  sessionStorage.setItem('__fakedb',JSON.stringify({bunks:[],memberships:[],
    profiles:[{id,full_name:'Avinash S'}],products:[],tanks:[],nozzles:[],business_days:[],
    shifts:[],readings:[],credit_customers:[],credit_txns:[],fuel_receipts:[],
    dip_readings:[],expenses:[],cash_deposits:[]}));
  sessionStorage.setItem('__fakestate',JSON.stringify({
    users:[{id,email:'admin@subsel.in',password:'Subsel2026Admin',name:'Avinash S',
            created_at:new Date().toISOString(),suspended:false}], admins:[id], audit:[]}));
});
await p.goto(BASE); await p.waitForTimeout(400);
const made = await p.evaluate(async ()=>{
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient('https://demo.supabase.co','x'.repeat(60),{auth:{storageKey:'setup'}});
  await sb.auth.signInWithPassword({email:'admin@subsel.in',password:'Subsel2026Admin'});
  const r = await sb.rpc('admin_create_business',{p_bunk_name:'Sri Balaji Fuels',
    p_email:'owner@subsel.com',p_password:'BunkSoft2026x',p_owner_name:'Kumaran',
    p_brand:'Indian Oil',p_place:'Coimbatore',p_seed:true});
  return r.error ? {error:r.error.message} : r.data;
});
if (made.error) { console.log('could not seed: '+made.error); process.exit(1); }

await p.goto(BASE); await p.waitForTimeout(500);
await p.fill('#au_email','owner@subsel.com'); await p.fill('#au_pass','BunkSoft2026x');
await p.click('#au_go'); await p.waitForTimeout(1500);

console.log('1. The app opens and says what is missing');
ok('the bunk opened despite the missing migration', await p.evaluate(()=>!!window.BunkSoft?.S?.config));
const banner = await p.textContent('#view');
ok('the owner is told the database is behind', /one update behind/i.test(banner), banner.slice(0,140));
ok('and is told exactly what to run', /fixes\.sql/i.test(banner));
ok('the app knows the migration is absent', (await p.evaluate(()=>window.BunkSoft.repo.migrationReady()))===false);

console.log('\n2. A shift still saves, with the right money');
await p.click('[data-act="rates"]'); await p.waitForTimeout(300);
const ids = await p.evaluate(()=>window.BunkSoft.S.config.products.map(x=>x.id.replace(/[^a-zA-Z0-9_-]/g,'_')));
for (const id of ids){ await p.fill('#rt_s_'+id,'100'); await p.fill('#rt_b_'+id,'90'); }
await p.click('[data-act="saverates"]'); await p.waitForTimeout(700);

/* Put fuel in the tanks first — a reading on a tank the book shows as empty is
   refused now, migration or no migration. */
await p.click('[data-tab="stock"]'); await p.waitForTimeout(500);
for (let i=0;i<3;i++){
  await p.selectOption('#rc_tank',{index:i});
  await p.fill('#rc_qty','4000'); await p.fill('#rc_rate','90');
  await p.click('[data-act="addreceipt"]'); await p.waitForTimeout(800);
}

await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
const rows = await p.$$('#nozTable tbody tr[data-noz]');
for (let i=0;i<rows.length;i++){
  await rows[i].$eval('input[data-fld="open"]',(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));},String(1000+i*100));
  await rows[i].$eval('input[data-fld="close"]',(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));},String(1100+i*100));
}
await p.fill('#f_cash','50000');
await p.click('[data-act="saveshift"]'); await p.waitForTimeout(1600);
const t = await toastText();
ok('the save succeeded', /shift saved/i.test(t), 'toast: '+t);
ok('no schema-cache error reached the operator', !/schema cache/i.test(t), t);
const saved = await p.evaluate(()=>{
  const d=window.BunkSoft.S.days[window.BunkSoft.S.date];
  const sh=Object.values(d.shifts).find(s=>s.id);
  return {id:!!sh, qty:window.BunkSoft.dayTotals(window.BunkSoft.S.date).qty,
          fuel:window.BunkSoft.dayTotals(window.BunkSoft.S.date).fuel};
});
ok('the shift row exists in the database', saved.id);
ok('litres are right ('+saved.qty+' L for '+rows.length+' nozzles × 100 L)', near(saved.qty, rows.length*100));
ok('and the value is right (₹'+saved.fuel+')', near(saved.fuel, rows.length*100*100));

console.log('\n3. Readings survived too, so stock moved');
const stock = await p.evaluate(()=>window.BunkSoft.S.tanks.map(t=>t.stock));
ok('tank stock moved from the readings '+JSON.stringify(stock), stock.some(s=>Number(s)!==0));

console.log('\n4. A dip still records, measured against a figure read now');
await p.click('[data-tab="stock"]'); await p.waitForTimeout(500);
await p.selectOption('#dp_tank',{index:0});
await p.evaluate(async ()=>{      /* another device sells while this page sits */
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient('https://demo.supabase.co','x'.repeat(60),{auth:{storageKey:'other'}});
  await sb.auth.signInWithPassword({email:'owner@subsel.com',password:'BunkSoft2026x'});
  const t = window.BunkSoft.S.tanks[0];
  await sb.from('tanks').update({current_stock: Number(t.stock) - 500}).eq('id', t.id);
});
const seen = await p.evaluate(()=>Number(window.BunkSoft.S.tanks[0].stock));
await p.fill('#dp_qty','4000'); await p.click('[data-act="adddip"]'); await p.waitForTimeout(1300);
const dip = await p.evaluate(()=>{
  const d=window.BunkSoft.S.days[window.BunkSoft.S.date]; return (d.dips||[]).slice(-1)[0];
});
ok('the dip was recorded', !!dip);
ok('against a freshly read book figure, not the stale page one ('+dip?.book+' vs '+seen+')',
   near(dip.book, seen-500));

console.log('\n5. The parts that need the migration are off, not broken');
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
ok('the rollover column is still shown so nothing looks missing',
   /Rollover/i.test(await p.textContent('#nozTable')));
const closings = await p.evaluate(async ()=>await window.BunkSoft.repo.lastClosings(window.BunkSoft.S.date));
ok('lastClosings returns empty rather than throwing', closings && typeof closings==='object');

console.log('\n5b. The dip note does not promise what this database cannot do');
await p.click('[data-tab="stock"]'); await p.waitForTimeout(600);
const stockTxt = await p.textContent('#view');
ok('it warns that a delete will NOT put the stock back', /will NOT put the stock back/i.test(stockTxt));
ok('and it does not claim the stock goes back', !/stock goes back to where it stood/i.test(stockTxt));

console.log('\n6. Once the migration is applied, everything comes back');
await p.evaluate(()=>sessionStorage.removeItem('__nomigration'));
await p.goto(BASE); await p.waitForTimeout(1800);
ok('the banner is gone', !/one update behind/i.test(await p.textContent('#view')));
await p.click('[data-tab="stock"]'); await p.waitForTimeout(600);
const stock2 = await p.textContent('#view');
ok('and the dip note now promises the rewind', /stock goes back to where it stood/i.test(stock2));
ok('and the app reports the migration present',
   (await p.evaluate(()=>window.BunkSoft.repo.migrationReady()))===true);

await b.close(); server.close();
console.log('\n'+pass+' passed, '+fail+' failed');
if (errs.length) console.log('\nPAGE ERRORS:\n'+errs.slice(0,8).join('\n'));
process.exitCode = fail ? 1 : 0;
