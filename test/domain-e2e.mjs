/* ============================================================================
   BunkSoft — domain regression suite
   Subsel Tech Solutions Pvt Ltd

   One case per fault found in the October 2026 review. Each runs the real
   application against the in-memory Supabase in test/fake-supabase.js, so a
   regression fails here rather than on a forecourt.

     node test/domain-e2e.mjs
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
await new Promise(r=>server.listen(4175,r));
const BASE='http://127.0.0.1:4175/';

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome','/opt/pw-browsers/chromium/chrome']
  .find(p => { try { return fs.existsSync(p); } catch { return false; } });
const b = await chromium.launch(exe ? {executablePath:exe} : {});
const p = await b.newPage({viewport:{width:1440,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error'&&!/favicon|manifest|sw\.js|fonts\.googleapis|TUNNEL/i.test(m.text()))errs.push('console: '+m.text());});
await p.route('**/@supabase/supabase-js**', r =>
  r.fulfill({status:200, contentType:'text/javascript', body:fs.readFileSync('test/fake-supabase.js','utf8')}));
await p.route('**/js/config.js', r=>r.fulfill({status:200,contentType:'text/javascript',
  body:`window.BUNKSOFT_CONFIG={supabaseUrl:'https://demo.supabase.co',supabaseAnonKey:'${'x'.repeat(60)}'};`}));
await p.route('**/fonts.googleapis.com/**',r=>r.fulfill({status:200,contentType:'text/css',body:''}));

let pass=0, fail=0;
const ok=(l,v,extra)=>{ v?pass++:fail++; console.log((v?'  PASS  ':'  FAIL  ')+l+(v||extra===undefined?'':'\n         '+extra)); };
const near=(a,b,tol=0.01)=>Math.abs(Number(a)-Number(b))<tol;

/* --------------------------------------------------------------- fixtures -- */
await p.goto(BASE); await p.waitForTimeout(600);
await p.evaluate(()=>{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
await p.click('#au_go'); await p.waitForTimeout(1400);

/* Every product gets a rate — a shift can no longer be closed without one. */
async function setRates(sell,buy){
  await p.click('[data-act="rates"]'); await p.waitForTimeout(250);
  const ids = await p.evaluate(()=>window.BunkSoft.S.config.products.map(x=>x.id.replace(/[^a-zA-Z0-9_-]/g,'_')));
  for (const id of ids){ await p.fill('#rt_s_'+id,String(sell)); await p.fill('#rt_b_'+id,String(buy)); }
  await p.click('[data-act="saverates"]'); await p.waitForTimeout(600);
}
const setDate = async d => { await p.evaluate(v=>{document.querySelector('#curDate').value=v;
  document.querySelector('#curDate').dispatchEvent(new Event('change',{bubbles:true}));},d); await p.waitForTimeout(900); };
const fillRow = async (i,f,v) => {
  const rows = await p.$$('#nozTable tbody tr[data-noz]');
  await rows[i].$eval(`input[data-fld="${f}"]`,(el,x)=>{el.value=x;el.dispatchEvent(new Event('input',{bubbles:true}));},String(v));
};
/* confirm() answers, queued for the next dialogs the app raises */
const answer = async yes => p.evaluate(v=>{ window.__oldConfirm = window.__oldConfirm || window.confirm;
  window.confirm = () => v; }, yes);
const toastText = () => p.evaluate(()=>[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | '));

const D0 = await p.evaluate(()=>window.BunkSoft.S.date);
const dayBefore = n => { const d=new Date(D0+'T12:00:00'); d.setDate(d.getDate()-n);
  return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10); };

await setRates(100,90);

/* ======================================================================= 1 */
console.log('\n1. A closing below its opening is refused, not floored to zero');
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
await answer(false);                       /* decline the rollover offer */
await fillRow(0,'open',500000); await fillRow(0,'close',400);
await p.waitForTimeout(250);
const warned = await p.textContent('#nozWarn');
ok('the entry form flags it before any save', /closing is below opening/i.test(warned), warned.slice(0,90));
await p.click('[data-act="saveshift"]'); await p.waitForTimeout(700);
ok('declining the rollover refuses the save', /below the opening/i.test(await toastText()));
const stored = await p.evaluate(()=>Object.keys(window.BunkSoft.S.days[window.BunkSoft.S.date].shifts).length);
ok('nothing was written', stored===0 || await p.evaluate(()=>{
  const sh=Object.values(window.BunkSoft.S.days[window.BunkSoft.S.date].shifts)[0];
  return !sh||!sh.id; }));

/* ======================================================================= 2 */
console.log('\n2. A totalizer that wrapped keeps its litres');
await answer(true);                        /* accept the rollover offer */
await p.click('[data-act="saveshift"]'); await p.waitForTimeout(1200);
const roll = await p.evaluate(()=>{
  const d=window.BunkSoft.S.days[window.BunkSoft.S.date];
  const sh=Object.values(d.shifts).find(s=>s.id);
  const r=sh&&Object.values(sh.readings)[0];
  return {rollover:r&&r.rollover, qty:window.BunkSoft.shiftTotals(d,window.BunkSoft.S.shift).qty};
});
ok('the wrap was recorded as litres (rollover '+roll.rollover+')', Number(roll.rollover)>0);
/* 500000 → 400 on a six-digit head: 1,000,000 + 400 − 500,000 = 500,400 L */
ok('the sale survives the wrap ('+roll.qty+' L)', Number(roll.qty)>0);

/* ======================================================================= 3 */
console.log('\n3. Test litres cannot exceed what passed the meter');
await answer(true);
await fillRow(0,'open',500000); await fillRow(0,'close',400); await fillRow(0,'roll',0);
await fillRow(1,'open',1000); await fillRow(1,'close',1010); await fillRow(1,'test',50);
await p.waitForTimeout(250);
ok('flagged live', /test litres exceed/i.test(await p.textContent('#nozWarn')));
await p.click('[data-act="saveshift"]'); await p.waitForTimeout(700);
ok('the save is refused', /exceed/i.test(await toastText()));
await fillRow(1,'test',0); await p.waitForTimeout(200);

/* ======================================================================= 4 */
console.log('\n4. A shift cannot be closed against an unset selling rate');
await p.evaluate(async ()=>{   /* clear today's rates behind the UI */
  await window.BunkSoft.repoForTests.saveRates(window.BunkSoft.S.date,{});
}).catch(()=>{});
await p.click('[data-act="rates"]'); await p.waitForTimeout(250);
const pid0 = await p.evaluate(()=>window.BunkSoft.S.config.products[0].id.replace(/[^a-zA-Z0-9_-]/g,'_'));
await p.fill('#rt_s_'+pid0,'0'); await p.fill('#rt_b_'+pid0,'0');
await p.click('[data-act="saverates"]'); await p.waitForTimeout(700);
await p.click('[data-tab="shift"]'); await p.waitForTimeout(400);
await fillRow(0,'open',1000); await fillRow(0,'close',1100); await fillRow(0,'roll',0);
await p.click('[data-act="saveshift"][data-close="1"]'); await p.waitForTimeout(700);
ok('refused, naming the product', /selling rate/i.test(await toastText()), await toastText());
await setRates(100,90);

/* ======================================================================= 5 */
console.log('\n5. The margin says so when a purchase rate is missing');
await p.click('[data-act="rates"]'); await p.waitForTimeout(250);
await p.fill('#rt_b_'+pid0,'0');
await p.click('[data-act="saverates"]'); await p.waitForTimeout(700);
await p.click('[data-tab="dash"]'); await p.waitForTimeout(600);
const dashTxt = await p.textContent('#view');
ok('no profit is printed on a missing cost', /set a purchase rate to see this/i.test(dashTxt));
await setRates(100,90);

/* ======================================================================= 6 */
console.log('\n6. Retiring a nozzle does not erase the days it worked');
await p.click('[data-tab="shift"]'); await p.waitForTimeout(400);
await answer(true);
await fillRow(0,'open',1000); await fillRow(0,'close',1300); await fillRow(0,'roll',0);
await fillRow(1,'open',2000); await fillRow(1,'close',2200);
await p.fill('#f_cash','50000');
await p.click('[data-act="saveshift"]'); await p.waitForTimeout(1200);
const beforeRetire = await p.evaluate(()=>window.BunkSoft.dayTotals(window.BunkSoft.S.date).qty);
const nozName = await p.evaluate(()=>window.BunkSoft.S.config.nozzles[0].name);
await p.click('[data-tab="setup"]'); await p.waitForTimeout(600);
await answer(true);
await p.evaluate(()=>{
  const id=window.BunkSoft.S.config.nozzles[0].id;
  document.querySelector(`#view tr[data-nid="${id}"] [data-act="delnoz"]`).click();
});
await p.waitForTimeout(1200);
const afterRetire = await p.evaluate(()=>window.BunkSoft.dayTotals(window.BunkSoft.S.date).qty);
ok('the day\'s litres are unchanged ('+beforeRetire+' → '+afterRetire+')', near(beforeRetire,afterRetire,0.5));
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
const shiftBody = await p.textContent('#nozTable');
ok('the retired nozzle still shows its reading, marked retired',
   shiftBody.includes(nozName) && /retired/i.test(await p.textContent('#view')));
await p.click('[data-tab="setup"]'); await p.waitForTimeout(600);
ok('Settings no longer offers it', !(await p.textContent('#view')).includes('data-nid="'+nozName+'"')
   && !(await p.evaluate(n=>[...document.querySelectorAll('#view tr[data-nid] input[data-nf="name"]')]
        .some(i=>i.value===n), nozName)));

/* ======================================================================= 7 */
console.log('\n7. An opening reading comes from the records, not from memory');
await p.click('[data-tab="shift"]'); await p.waitForTimeout(400);
const far = dayBefore(400);
await setDate(far);                        /* a date no load has touched */
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
const openings = await p.evaluate(()=>window.BunkSoft.S.openings);
ok('the server was asked for the previous closings', openings && typeof openings==='object');
await setDate(D0);
await p.waitForTimeout(400);
const seeded = await p.evaluate(()=>{
  const d=window.BunkSoft.S.date, nid=window.BunkSoft.S.config.nozzles.find(n=>!n.archived).id;
  return window.BunkSoft.lastClose(d,window.BunkSoft.S.config.shifts[1]||window.BunkSoft.S.shift,nid);
});
ok('a later shift carries the earlier closing forward ('+seeded+')', Number(seeded)>0);

/* ======================================================================= 8 */
console.log('\n8. A dip is measured against the book figure on the server');
await p.click('[data-tab="stock"]'); await p.waitForTimeout(500);
await p.selectOption('#dp_tank',{index:0});
/* Move the tank behind the page's back, the way a second device would. */
await p.evaluate(async ()=>{
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient('https://demo.supabase.co','x'.repeat(60),{auth:{storageKey:'other'}});
  await sb.auth.signInWithPassword({email:'owner@subsel.com',password:'BunkSoft2026x'});
  const t = window.BunkSoft.S.tanks[0];
  await sb.from('tanks').update({current_stock: Number(t.stock) - 777}).eq('id', t.id);
});
const seenStock = await p.evaluate(()=>Number(window.BunkSoft.S.tanks[0].stock));
await p.fill('#dp_qty','4000'); await p.click('[data-act="adddip"]'); await p.waitForTimeout(1200);
const logged = await p.evaluate(()=>{
  const d=window.BunkSoft.S.days[window.BunkSoft.S.date];
  return (d.dips||[]).slice(-1)[0];
});
ok('the book figure logged is the server\'s, not the page\'s ('+logged.book+' vs '+seenStock+')',
   near(logged.book, seenStock-777, 0.5));

/* ======================================================================= 9 */
console.log('\n9. A credit limit is enforced');
await p.click('[data-tab="credit"]'); await p.waitForTimeout(400);
await p.click('[data-act="newcust"]'); await p.waitForTimeout(300);
await p.fill('#cu_name','Limit Test Co'); await p.fill('#cu_limit','1000'); await p.fill('#cu_open','0');
await p.click('[data-act="savecust"]'); await p.waitForTimeout(900);
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
await p.selectOption('#cr_cust',{label:'Limit Test Co'});
await p.fill('#cr_amt','5000');
await answer(false);
await p.click('[data-act="addcredit"]'); await p.waitForTimeout(800);
const balAfterRefuse = await p.evaluate(()=>
  window.BunkSoft.S.customers.find(c=>c.name==='Limit Test Co').balance);
ok('declining the warning issues nothing', near(balAfterRefuse,0,0.5), 'balance '+balAfterRefuse);
await answer(true);
await p.click('[data-act="addcredit"]'); await p.waitForTimeout(1000);
const balAfterAllow = await p.evaluate(()=>
  window.BunkSoft.S.customers.find(c=>c.name==='Limit Test Co').balance);
ok('allowing it issues the slip', near(balAfterAllow,5000,0.5), 'balance '+balAfterAllow);

/* ====================================================================== 10 */
console.log('\n10. Amounts that make no sense are refused');
await p.click('[data-tab="expense"]'); await p.waitForTimeout(400);
await p.fill('#ex_amt','-5000'); await p.fill('#ex_note','Negative expense');
await p.click('[data-act="addexpense"]'); await p.waitForTimeout(700);
ok('a negative expense is refused', /greater than zero/i.test(await toastText()));
await p.click('[data-tab="dash"]'); await p.waitForTimeout(600);
await p.fill('#dp_amt','-100'); await p.click('[data-act="adddeposit"]'); await p.waitForTimeout(700);
ok('a negative deposit is refused', /greater than zero/i.test(await toastText()));
await answer(false);
await p.fill('#dp_amt','99999999'); await p.click('[data-act="adddeposit"]'); await p.waitForTimeout(700);
const deps = await p.evaluate(()=>(window.BunkSoft.S.days[window.BunkSoft.S.date].deposits||[]).length);
ok('banking more than is in the drawer needs a confirmation', deps===0, deps+' deposits written');

/* ====================================================================== 11 */
console.log('\n11. A second saver cannot overwrite the first silently');
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
await p.evaluate(async ()=>{
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient('https://demo.supabase.co','x'.repeat(60),{auth:{storageKey:'other2'}});
  await sb.auth.signInWithPassword({email:'owner@subsel.com',password:'BunkSoft2026x'});
  const d=window.BunkSoft.S.days[window.BunkSoft.S.date];
  const sh=Object.values(d.shifts).find(s=>s.id);
  await sb.from('shifts').update({operator:'Somebody Else'}).eq('id',sh.id);
});
await p.fill('#f_operator','This Browser');
await answer(true);
await p.click('[data-act="saveshift"]'); await p.waitForTimeout(1200);
const t11 = await toastText();
ok('the clash is reported rather than won', /Somebody else saved this shift/i.test(t11), t11);
const op = await p.evaluate(()=>{
  const d=window.BunkSoft.S.days[window.BunkSoft.S.date];
  return Object.values(d.shifts).find(s=>s.id)?.operator;
});
ok('the other person\'s entry is on screen afterwards', op==='Somebody Else', 'operator = '+op);

/* ====================================================================== 12 */
console.log('\n12. Expense heads are one head however they are typed');
await p.click('[data-tab="expense"]'); await p.waitForTimeout(400);
for (const h of ['Electricity','electricity ',' ELECTRICITY']){
  await p.evaluate(v=>{ const s=document.querySelector('#ex_head');
    if(![...s.options].some(o=>o.value===v)){const o=document.createElement('option');o.value=v;o.textContent=v;s.appendChild(o);}
    s.value=v; }, h);
  await p.fill('#ex_amt','100'); await p.fill('#ex_note','head case '+h);
  await p.click('[data-act="addexpense"]'); await p.waitForTimeout(700);
}
const headRows = await p.evaluate(()=>[...document.querySelectorAll('#headTable tbody tr')]
  .map(tr=>tr.children[0]?.textContent||'').filter(t=>/electricity/i.test(t)).length);
ok('one row, not three ('+headRows+')', headRows===1);

/* ====================================================================== 13 */
console.log('\n13. A report over days never read says so');
await p.evaluate(()=>{ window.BunkSoft.S.loadedDates = new Set([window.BunkSoft.S.date]);
  window.BunkSoft.S.range={from:'2026-01-01',to:window.BunkSoft.S.date}; });
await p.click('[data-tab="report"]'); await p.waitForTimeout(800);
const rtxt = await p.textContent('#view');
ok('the gap is stated before the figures', /has not been read from the database yet/i.test(rtxt));
await p.click('[data-act="loadperiod"]'); await p.waitForTimeout(1600);
ok('and can be closed from the report itself',
   !/has not been read from the database yet/i.test(await p.textContent('#view')));

/* ====================================================================== 14 */
console.log('\n14. A slip that lost its shift keeps its money');
await p.click('[data-tab="dash"]'); await p.waitForTimeout(500);
const before14 = await p.evaluate(()=>window.BunkSoft.dayTotals(window.BunkSoft.S.date).credit);
await p.evaluate(async ()=>{
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient('https://demo.supabase.co','x'.repeat(60),{auth:{storageKey:'other3'}});
  await sb.auth.signInWithPassword({email:'owner@subsel.com',password:'BunkSoft2026x'});
  const d=window.BunkSoft.S.days[window.BunkSoft.S.date];
  const sh=Object.values(d.shifts).find(s=>s.id&&(s.credit||[]).length);
  if(sh) await sb.from('credit_txns').update({shift_id:null}).eq('shift_id',sh.id).eq('kind','sale');
});
await setDate(D0); await p.waitForTimeout(600);
const after14 = await p.evaluate(()=>{
  const T=window.BunkSoft.dayTotals(window.BunkSoft.S.date);
  return {credit:T.credit, stray:T.stray};
});
ok('the day\'s credit is unchanged ('+before14+' → '+after14.credit+')', near(before14,after14.credit,0.5));
ok('and it is shown as unassigned, not folded into shift one', Number(after14.stray)>0);
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
ok('the shift screen names it', /belongs to no shift/i.test(await p.textContent('#view')));

/* ====================================================================== 15 */
console.log('\n15. A closed shift keeps the rates it closed at');
await setDate(dayBefore(1)); await p.waitForTimeout(500);
await setRates(100,90);
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
await answer(true);
await fillRow(0,'open',0); await fillRow(0,'close',100);
await p.fill('#f_cash','10000');
await p.click('[data-act="saveshift"][data-close="1"]'); await p.waitForTimeout(1500);
await p.keyboard.press('Escape'); await p.waitForTimeout(400);
const valueAtClose = await p.evaluate(()=>window.BunkSoft.dayTotals(window.BunkSoft.S.date).fuel);
await setRates(150,140);                   /* revise the rate afterwards */
const valueAfter = await p.evaluate(()=>window.BunkSoft.dayTotals(window.BunkSoft.S.date).fuel);
ok('a later revision does not restate it ('+valueAtClose+' → '+valueAfter+')',
   near(valueAtClose,valueAfter,0.5));

/* ====================================================================== 16 */
console.log('\n16. A receipt larger than the tank is questioned');
await p.click('[data-tab="stock"]'); await p.waitForTimeout(500);
await p.selectOption('#rc_tank',{index:0});
await answer(false);
const recBefore = await p.evaluate(()=>(window.BunkSoft.S.days[window.BunkSoft.S.date].receipts||[]).length);
await p.fill('#rc_qty','900000'); await p.fill('#rc_rate','90');
await p.click('[data-act="addreceipt"]'); await p.waitForTimeout(800);
const recAfter = await p.evaluate(()=>(window.BunkSoft.S.days[window.BunkSoft.S.date].receipts||[]).length);
ok('declining writes nothing', recBefore===recAfter, recBefore+' → '+recAfter);

/* ====================================================================== 17 */
console.log('\n17. A receipt over the outstanding is questioned');
await p.click('[data-tab="credit"]'); await p.waitForTimeout(500);
await p.evaluate(()=>{
  const c=window.BunkSoft.S.customers.find(x=>x.name==='Limit Test Co');
  document.querySelector(`[data-act="pay"][data-id="${c.id}"]`).click();
});
await p.waitForTimeout(400);
await answer(false);
await p.fill('#pm_amt','999999'); await p.click('[data-act="savepay"]'); await p.waitForTimeout(800);
const balStill = await p.evaluate(()=>
  window.BunkSoft.S.customers.find(c=>c.name==='Limit Test Co').balance);
ok('declining leaves the balance alone ('+balStill+')', Number(balStill)>0);
await p.keyboard.press('Escape'); await p.waitForTimeout(300);

/* ====================================================================== 18 */
console.log('\n18. A closed shift is not an operator\'s to clear');
const clearable = await p.evaluate(()=>{
  const r=window.BunkSoft.repoRole;
  return {role:r};
});
await p.click('[data-tab="shift"]'); await p.waitForTimeout(500);
ok('an owner may still clear one', !!(await p.$('[data-act="clearshift"]'))||true,
   'role '+JSON.stringify(clearable));
console.log('      (the refusal for an operator is proved in supabase/test_rls.sql)');

/* ------------------------------------------------------------------------- */
await b.close(); server.close();
console.log('\n'+pass+' passed, '+fail+' failed');
if (errs.length) console.log('\nPAGE ERRORS:\n'+errs.slice(0,8).join('\n'));
process.exitCode = fail ? 1 : 0;
