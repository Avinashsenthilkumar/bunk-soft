/* ============================================================================
   BunkSoft — application layer (domain, rendering, reports)
   Subsel Tech Solutions Pvt Ltd
   Persistence lives in db.js; this file never talks to SQL directly.
   ========================================================================== */
import { repo } from './db.js';

/* ============================ helpers ============================ */
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const nf=(n,d=0)=>{n=Number(n)||0;return n.toLocaleString('en-IN',{minimumFractionDigits:d,maximumFractionDigits:d});};
const money=n=>'₹'+nf(Math.round(Number(n)||0));
const money2=n=>'₹'+nf(Number(n)||0,2);
const L=n=>nf(Number(n)||0,2)+' L';
const diffTxt=d=>Math.abs(d)<1?'In balance':(d>0?'+':'−')+'₹'+nf(Math.abs(Math.round(d)));
const diffCls=d=>Math.abs(d)<1?'':(d<0?'neg':'pos');
const plural=(n,w)=>n+' '+w+(n===1?'':'s');
const r2=n=>Math.round((Number(n)||0)*100)/100;   // money never drifts below a paisa
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=v=>{const n=parseFloat(v);return isFinite(n)?n:0;};
const uid=p=>p+Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-3);
const iso=d=>{const x=new Date(d);return new Date(x.getTime()-x.getTimezoneOffset()*6e4).toISOString().slice(0,10);};
const today=()=>iso(new Date());
const shiftDate=(s,n)=>{const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+n);return iso(d);};
const dmy=s=>{if(!s)return '';const[y,m,d]=s.split('-');return d+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m-1]+' '+y;};
const dshort=s=>{const[y,m,d]=s.split('-');return d+'/'+m;};
const monthStart=s=>s.slice(0,8)+'01';
const clone=o=>JSON.parse(JSON.stringify(o));
/* #toasts is deliberately not #layer: render() rewrites #layer wholesale, so a
   message raised inside a save — including every error from mutate() — used to
   be destroyed by the re-render that followed it, before anyone could read it. */
function toastHost(){
  let h=$('#toasts');
  if(!h){h=document.createElement('div');h.id='toasts';h.setAttribute('aria-live','polite');document.body.appendChild(h);}
  return h;
}
function toast(msg){
  const h=toastHost();
  const t=document.createElement('div');t.className='toast';t.textContent=msg;
  h.appendChild(t);
  /* An error deserves longer on screen than a confirmation. */
  setTimeout(()=>t.remove(),String(msg).length>70?6000:2800);
}

/* ============================ state ============================ */
const S={
  ready:false, preview:false, mode:'loading',
  config:null, tanks:[], customers:[], days:{},
  date:today(), tab:'dash', shift:null, range:null, modal:null, chartMode:'value', members:[], report:null,
  /* dates actually read from the database, and the opening readings the
     server gave us for the current date */
  loadedDates:new Set(), openings:{}
};
const CC=['var(--c0)','var(--c1)','var(--c2)','var(--c3)','var(--c4)'];
const pcol=pid=>{const i=(S.config?.products||[]).findIndex(p=>p.id===pid);return CC[(i<0?4:i)%5];};
const prod=pid=>(S.config?.products||[]).find(p=>p.id===pid)||{id:pid,short:'?',name:'Unknown',sell:0,buy:0};
const tank=tid=>S.tanks.find(t=>t.id===tid)||null;
const cust=cid=>S.customers.find(c=>c.id===cid)||null;

/* ============================ defaults / sample ============================ */
/* deterministic pseudo-random so the sample looks like a real week, not noise */
function rnd(seed){let x=Math.sin(seed)*10000;return x-Math.floor(x);}function blankDay(date,cfg){
  const rates={}; ((cfg||S.config)?.products||[]).forEach(p=>rates[p.id]={sell:p.sell,buy:p.buy});
  return {date,rates,shifts:{},receipts:[],dips:[],expenses:[],payments:[],deposits:[],openingCash:0,cashCounted:null};
}
function getDay(date){
  let d=S.days[date];
  if(!d){d=blankDay(date);S.days[date]=d;}
  if(!d.rates)d.rates={};
  (S.config?.products||[]).forEach(p=>{if(!d.rates[p.id])d.rates[p.id]={sell:p.sell,buy:p.buy};});
  ['receipts','dips','expenses','payments','deposits'].forEach(k=>{if(!Array.isArray(d[k]))d[k]=[];});
  if(d.openingCash==null)d.openingCash=0;
  if(!d.shifts)d.shifts={};
  return d;
}
function blankShift(){return {operator:'',readings:{},cash:0,card:0,upi:0,bank:0,credit:[],other:{amount:0,cost:0,note:''},closed:false};}
const PAYMODES=['Cash','UPI','Card','Bank transfer','Cheque'];
const isCash=m=>(m||'Cash')==='Cash';
/* "Diesel", "diesel" and "Diesel " were three separate expense heads in every
   report. They are one head typed three ways. */
const headKey=h=>String(h||'Other').trim().toLowerCase();
function addHead(bag,h,amt){
  const k=headKey(h); const b=bag[k]||(bag[k]={label:String(h||'Other').trim()||'Other',amount:0});
  b.amount+=amt; return b;
}
const headList=bag=>Object.values(bag).sort((a,b)=>b.amount-a.amount);

/* ============================ derived ============================

   Reference data comes back from the repository with the retired rows
   included, each carrying `archived`. Two different questions are asked of
   it, and answering both from one list is what used to lose money:

     activeNozzles()  — what an operator may enter against today
     nozzlesFor(sh)   — what this shift actually recorded, retired or not

   Retiring a dispenser used to erase its sales from every day it had ever
   worked, because the historic readings were joined to the current list. */
const activeNozzles=()=>(S.config?.nozzles||[]).filter(n=>!n.archived);
const activeProducts=()=>(S.config?.products||[]).filter(p=>!p.archived);
const nozzle=nid=>(S.config?.nozzles||[]).find(n=>n.id===nid)||null;
/* every nozzle still in service, plus any archived one this shift has a
   reading for, in configured order */
function nozzlesFor(sh){
  const all=S.config?.nozzles||[], read=sh?.readings||{};
  return all.filter(n=>!n.archived||read[n.id]!=null);
}
/* The sell/buy card a line should be valued at: frozen once a shift closes,
   live while it is open. Revising a rate no longer restates shifts already
   closed, signed and handed over. */
function ratesOf(day,sh){
  return (sh&&sh.closed&&sh.ratesAtClose)?sh.ratesAtClose:(day.rates||{});
}
/* One definition of a sale, matching reading_sold() in the database. */
const soldOf=r=>Math.max(0,num(r.close)+num(r.rollover)-num(r.open)-num(r.test));

function shiftLines(day,shiftName){
  const sh=day.shifts[shiftName]; if(!sh)return [];
  const rates=ratesOf(day,sh);
  return nozzlesFor(sh).map(n=>{
    const r=sh.readings[n.id]||{open:lastClose(day.date,shiftName,n.id),close:0,test:0,rollover:0};
    const qty=soldOf(r);
    const rate=rates[n.product]?.sell||0;
    const buy=rates[n.product]?.buy||0;
    return {noz:n,open:num(r.open),close:num(r.close),test:num(r.test),
      rollover:num(r.rollover),qty,rate,buy,amount:qty*rate};
  });
}
/* The previous closing for a nozzle, from the days held in memory. db.js
   answers the same question from the records (repo.lastClosings) and that is
   what the entry form seeds itself from; this is only a fallback for days
   already loaded, and it no longer silently returns 0 for an unknown nozzle —
   callers check for null. */
function lastClose(date,shiftName,nozId){
  const order=S.config.shifts||[]; const idx=order.indexOf(shiftName);
  const d=S.days[date];
  if(d) for(let i=idx-1;i>=0;i--){const r=d.shifts[order[i]]?.readings?.[nozId];if(r&&num(r.close))return num(r.close);}
  const prev=Object.keys(S.days).filter(k=>k<date).sort().reverse();
  for(const k of prev){const dd=S.days[k];for(let i=order.length-1;i>=0;i--){const r=dd.shifts[order[i]]?.readings?.[nozId];if(r&&num(r.close))return num(r.close);}}
  const seeded=S.openings&&S.openings[nozId];
  return seeded!=null?num(seeded):0;
}
function shiftTotals(day,shiftName){
  const sh=day.shifts[shiftName]||blankShift(), lines=shiftLines(day,shiftName);
  const fuel=lines.reduce((a,b)=>a+b.amount,0), qty=lines.reduce((a,b)=>a+b.qty,0);
  const test=lines.reduce((a,b)=>a+b.test,0);
  const credit=(sh.credit||[]).reduce((a,b)=>a+num(b.amount),0);
  const other=num(sh.other?.amount);
  const due=fuel+other;
  const recv=num(sh.cash)+num(sh.card)+num(sh.upi)+num(sh.bank)+credit;
  return {lines,fuel,qty,test,credit,other,due,recv,diff:recv-due,sh};
}
/* Slips that lost their shift when it was cleared. They still owe money, so
   they belong to the day even though they belong to no shift. */
const strayCredit=day=>(day.unassignedCredit||[]).reduce((a,b)=>a+num(b.amount),0);
function dayTotals(date){
  const day=getDay(date); const out={qty:0,fuel:0,other:0,otherCost:0,cash:0,card:0,upi:0,bank:0,
    credit:0,stray:0,diff:0,margin:0,byProd:{},shifts:0,closed:0,expenses:0,recovered:0,received:0,
    /* true when a product sold today has no purchase rate on record: the
       margin below is then understated, and the UI must say so rather than
       print a profit that counts the fuel as free. */
    costMissing:false};
  (S.config?.shifts||[]).forEach(nm=>{
    if(!day.shifts[nm])return; out.shifts++;
    const t=shiftTotals(day,nm); if(t.sh.closed)out.closed++;
    out.qty+=t.qty;out.fuel+=t.fuel;out.other+=t.other;out.otherCost+=num(t.sh.other?.cost);
    out.cash+=num(t.sh.cash);out.card+=num(t.sh.card);out.upi+=num(t.sh.upi);out.bank+=num(t.sh.bank);out.credit+=t.credit;out.diff+=t.diff;
    t.lines.forEach(l=>{
      const b=out.byProd[l.noz.product]||(out.byProd[l.noz.product]={qty:0,amount:0,cost:0});
      b.qty+=l.qty;b.amount+=l.amount;b.cost+=l.qty*l.buy;
      if(l.qty>0&&!l.buy)out.costMissing=true;
    });
  });
  /* Slips orphaned by a cleared shift are still receivable money. */
  out.stray=strayCredit(day);
  out.credit+=out.stray;
  Object.values(out.byProd).forEach(b=>out.margin+=b.amount-b.cost);
  out.margin+=out.other-out.otherCost;
  out.expenses=(day.expenses||[]).reduce((a,b)=>a+num(b.amount),0);
  out.recovered=(day.payments||[]).reduce((a,b)=>a+num(b.amount),0);
  out.received=out.cash+out.card+out.upi+out.bank;
  out.net=out.margin-out.expenses;
  return out;
}
/* The day's cash position: what came in, what went out, what should be in the drawer. */
function closingCashOf(date){
  const day=S.days[date]; if(!day)return 0;
  const T=dayTotals(date);
  const rc=(day.payments||[]).filter(p=>isCash(p.mode)).reduce((a,b)=>a+num(b.amount),0);
  const ec=(day.expenses||[]).filter(e=>isCash(e.mode)).reduce((a,b)=>a+num(b.amount),0);
  const dp=(day.deposits||[]).reduce((a,b)=>a+num(b.amount),0);
  return r2(num(day.openingCash)+T.cash+rc-ec-dp);
}
function cashBook(date){
  const day=getDay(date), T=dayTotals(date);
  const pay=day.payments||[], exp=day.expenses||[], dep=day.deposits||[];
  const recovCash=pay.filter(p=>isCash(p.mode)).reduce((a,b)=>a+num(b.amount),0);
  const recovBank=pay.filter(p=>!isCash(p.mode)).reduce((a,b)=>a+num(b.amount),0);
  const expCash=exp.filter(e=>isCash(e.mode)).reduce((a,b)=>a+num(b.amount),0);
  const expBank=exp.filter(e=>!isCash(e.mode)).reduce((a,b)=>a+num(b.amount),0);
  const deposits=dep.reduce((a,b)=>a+num(b.amount),0);
  const opening=num(day.openingCash);
  const closing=r2(opening+T.cash+recovCash-expCash-deposits);
  const counted=(day.cashCounted===''||day.cashCounted==null)?null:num(day.cashCounted);
  const toBank=r2(T.card+T.upi+T.bank+recovBank+deposits-expBank);
  return {T,day,opening,recovCash,recovBank,expCash,expBank,deposits,closing,counted,
    diff:counted===null?null:r2(counted-closing),toBank};
}
function outstanding(){return S.customers.reduce((a,c)=>a+num(c.balance),0);}
function soldToday(date,tankId){
  const day=getDay(date); let q=0;
  (S.config?.shifts||[]).forEach(nm=>{if(day.shifts[nm])shiftTotals(day,nm).lines.forEach(l=>{if(l.noz.tank===tankId)q+=l.qty;});});
  return q;
}
function recvToday(date,tankId){return (getDay(date).receipts||[]).filter(r=>r.tank===tankId).reduce((a,b)=>a+num(b.qty),0);}

/* ============================ persistence ============================
   Every write goes through the repository. The database owns tank stock and
   credit balances (triggers and a view), so after a write we re-read rather
   than patch memory — two operators on two phones stay consistent. */
let BUSY=false;
export let SESSION_EMAIL='';
export function setSessionEmail(e){ SESSION_EMAIL=e||''; }

/* Returns true only when the write went through, so a caller can hold back a
   success message or a report. A failure re-reads the day as well: when the
   write was refused because somebody else had already saved, the point is to
   put their entries on screen. */
async function mutate(fn,okMsg){
  if(BUSY)return false;
  BUSY=true; renderStatus();
  let ok=false;
  try{
    await fn();
    await refreshDay();
    if(okMsg)toast(okMsg);
    ok=true;
  }catch(e){
    toast(e.message||'Could not save.');
    try{ await refreshDay(); }catch(_){}
  }finally{
    BUSY=false; render();
  }
  return ok;
}

async function refreshDay(){
  const d=await repo.loadDay(S.date);
  await repo.attachCreditSlips(S.date,d);
  S.days[S.date]=d;
  S.loadedDates.add(S.date);
  /* The opening reading each nozzle last carried, answered from the records.
     Working it out from whatever days happened to be in memory meant a date
     outside the loaded window fell back to 0 — and a shift saved that way
     booked the meter's entire lifetime total as one day's sale. */
  try{ S.openings=await repo.lastClosings(S.date); }catch(_){ S.openings=S.openings||{}; }
  const [tanks,customers]=await Promise.all([repo.loadTanks(),repo.loadCustomers()]);
  S.tanks=tanks; S.customers=customers;
}
async function refreshConfig(){
  S.config=await repo.loadConfig();
  S.tanks=await repo.loadTanks();
  if(!S.config.shifts.includes(S.shift))S.shift=S.config.shifts[0];
}
/* Which dates have actually been read. A report over a period that was never
   loaded used to be computed from whatever happened to be in memory and
   printed as if it were the whole period. */
function markLoaded(from,to){
  for(let d=from;d<=to;d=shiftDate(d,1))S.loadedDates.add(d);
}
function missingDays(from,to){
  const miss=[];
  for(let d=from;d<=to;d=shiftDate(d,1))if(!S.loadedDates.has(d))miss.push(d);
  return miss;
}
async function loadRange(from,to){
  try{
    Object.assign(S.days, await repo.loadRange(from,to));
    markLoaded(from,to);
    render();
  }
  catch(e){ toast(e.message||'Could not load that period.'); }
  return S.days;
}

/* A day row must exist before rates or cash can be written against it. */
function currentRates(){
  const r={}; (S.config?.products||[]).forEach(p=>r[p.id]={sell:p.sell,buy:p.buy}); return r;
}

/* Browser download — on our own domain there is no sandbox to work around. */
function download(blobOrText,filename){
  const blob=blobOrText instanceof Blob?blobOrText:new Blob([blobOrText],{type:'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(url); a.remove();},1500);
  toast('Downloaded '+filename);
}

/* ============================ boot ============================ */
export async function startApp(bunk){
  repo.setBunk(bunk.id,bunk.role);
  S.mode='loading'; S.date=today(); S.tab='dash'; S.days={};
  S.config=null; S.tanks=[]; S.customers=[]; S.members=[]; S.membersLoaded=false;
  S.modal=null; S.report=null; S.range=null; S.error='';
  render();
  try{
    S.config=await repo.loadConfig();
    S.shift=S.config.shifts[0]||null;
    await refreshDay();
    S.mode='ready';
    render();
    loadRange(shiftDate(today(),-45),today());   // fills the trend chart in the background
  }catch(e){
    S.mode='error'; S.error=e.message||'Could not open this bunk.';
    render();
  }
}

/* Demo data for QA and sales demos. Writes through the same API a real
   operator uses, so it exercises every policy and trigger. */
export async function seedDemoData(onProgress){
  const cfg=S.config;
  const byCode={}; cfg.products.forEach(p=>byCode[p.code]=p.id);
  const custs=[
    {name:'Annai Transports',phone:'98430 11224',vehicle:'TN 37 BX 4410',limit:150000,opening:0},
    {name:'KMR Logistics',phone:'99529 60781',vehicle:'TN 66 AH 2093',limit:80000,opening:0},
    {name:'Sakthi Cabs',phone:'94433 50019',vehicle:'TN 38 CQ 7781',limit:40000,opening:0}
  ];
  const custIds=[];
  for(const c of custs){ const r=await repo.addCustomer(c); custIds.push(r.id); }

  const rates={}; const RATE={ms:[102.63,99.35],hsd:[94.24,91.72],xp:[112.40,108.05]};
  cfg.products.forEach(p=>{ const r=RATE[p.code]||[100,97]; rates[p.id]={sell:r[0],buy:r[1]}; });

  const DAYS=14, meters={}; cfg.nozzles.forEach((n,i)=>meters[n.id]=100000+i*13750);
  let cash=25000, step=0, total=DAYS;
  for(let k=DAYS-1;k>=0;k--){
    const date=shiftDate(today(),-k);
    await repo.saveRates(date,rates);
    const dow=new Date(date+'T12:00:00').getDay();
    const busy=(dow===0?.78:dow===6?1.12:1)*(0.88+rnd(k*7.3)*0.3);
    let dayCash=0;
    for(let si=0;si<cfg.shifts.length;si++){
      const nm=cfg.shifts[si];
      const sh={operator:si===0?'Ravi K':'Muthu S',readings:{},cash:0,card:0,upi:0,bank:0,
                credit:[],other:{amount:0,cost:0,note:'Lubes / 2T oil'},closed:true,
                closedAtISO:new Date(date+'T'+(si===0?'14:10':'22:05')+':00').toISOString()};
      let sale=0;
      cfg.nozzles.forEach((n,ni)=>{
        const p=cfg.products.find(x=>x.id===n.product);
        const base=p&&p.code==='hsd'?320:p&&p.code==='ms'?210:70;
        const q=Math.round(base*busy*(si===0?1:0.92)*(0.85+rnd(k*3+ni*1.7+si)*0.32));
        const open=meters[n.id], test=(si===0&&ni===0)?5:0, close=open+q+test;
        meters[n.id]=close;
        sh.readings[n.id]={open,close,test,rollover:0};
        sale+=q*(rates[n.product]?.sell||0);
      });
      sh.other.amount=si===0?Math.round(900+rnd(k+9)*1400):Math.round(400+rnd(k+3)*900);
      sh.other.cost=Math.round(sh.other.amount*0.72);
      let cr=0;
      const slips=[];
      if(si===0&&k%4===0)slips.push({cust:custIds[0],product:byCode.hsd,qty:180,
        amount:Math.round(180*(rates[byCode.hsd]?.sell||94)),vehicle:'TN 37 BX 4410',slip:'S'+(1200+k)});
      if(si===1&&k%5===2)slips.push({cust:custIds[1],product:byCode.hsd,qty:120,
        amount:Math.round(120*(rates[byCode.hsd]?.sell||94)),vehicle:'TN 66 AH 2093',slip:'S'+(1300+k)});
      slips.forEach(s=>cr+=s.amount);
      const recv=sale-cr+sh.other.amount;
      sh.upi=Math.round(recv*(0.31+rnd(k+si)*0.08));
      sh.card=Math.round(recv*(0.17+rnd(k*2+si)*0.06));
      sh.bank=rnd(k*3+si)>.45?Math.round(recv*(0.05+rnd(k+si*2)*0.04)):0;
      sh.cash=Math.round(recv-sh.upi-sh.card-sh.bank);
      dayCash+=sh.cash;
      sh.ratesAtClose={...rates};
      const shiftId=await repo.saveShift(date,nm,sh,cfg.nozzles,rates);
      for(const s of slips) await repo.addCreditSlip(date,shiftId,s);
    }
    if(k===9)await repo.addReceipt(date,{tank:tankFor(byCode.hsd),product:byCode.hsd,qty:12000,rate:91.72,invoice:'IOC/8841',truck:'TN 45 K 9012'});
    if(k===5)await repo.addReceipt(date,{tank:tankFor(byCode.ms),product:byCode.ms,qty:8000,rate:99.35,invoice:'IOC/9107',truck:'TN 45 K 3388'});
    if(k===2)await repo.addReceipt(date,{tank:tankFor(byCode.xp),product:byCode.xp,qty:4000,rate:108.05,invoice:'IOC/9260',truck:'TN 45 K 1157'});
    let expCash=0;
    if(k%7===3)await repo.addExpense(date,{head:'Electricity',mode:'Bank transfer',amount:Math.round(2400+rnd(k)*900),note:'TNEB'});
    if(k%7===0){await repo.addExpense(date,{head:'Salaries',mode:'Cash',amount:18000,note:'Weekly wages — 6 staff'}); expCash+=18000;}
    if(k%6===1){const a=Math.round(700+rnd(k*2)*1500); await repo.addExpense(date,{head:'Maintenance',mode:'Cash',amount:a,note:'Nozzle service'}); expCash+=a;}
    let recovCash=0;
    if(k===6)await repo.addPayment(date,{cust:custIds[0],amount:30000,mode:'Bank transfer',note:'Part settlement'});
    if(k===1){await repo.addPayment(date,{cust:custIds[1],amount:11000,mode:'Cash',note:'Against slip S1302'}); recovCash+=11000;}
    const avail=cash+dayCash+recovCash-expCash;
    const dep=k===0?0:Math.max(0,Math.round((avail-30000)/500)*500);
    if(dep)await repo.addDeposit(date,{amount:dep,bank:'SBI current a/c',ref:'DEP'+(4400+k)});
    await repo.saveDayCash(date,cash,k===0?null:Math.round(avail-dep));
    cash=Math.round(avail-dep);
    if(onProgress)onProgress(++step,total);
  }
  function tankFor(productId){
    const t=S.tanks.find(x=>x.product===productId); return t?t.id:(S.tanks[0]||{}).id;
  }
}

/* ============================ render ============================ */
const IC={
  dash:'<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/>',
  shift:'<path d="M4 20V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v14"/><path d="M2 20h13"/><path d="M4 10h9"/><path d="M16 9l3 3v6a1.5 1.5 0 0 0 3 0v-8l-3-3"/>',
  stock:'<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  credit:'<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 15h4"/>',
  expense:'<path d="M6 2.5h12v19l-2.4-1.6-2.4 1.6-2.4-1.6L8.4 21.5 6 19.9z"/><path d="M9.5 8h5"/><path d="M9.5 12h5"/>',
  report:'<path d="M3 3v18h18"/><path d="M7 15l4-5 3.5 3L20 6"/><path d="M20 6h-4"/><path d="M20 6v4"/>',
  setup:'<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.93-1.15l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 14.1a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.15-2.93l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9.9 3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.93 1.15l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 21 9.9a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.1z"/>'
};
const svgIcon=k=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${IC[k]||IC.dash}</svg>`;
const TABS=[['dash','Dashboard'],['shift','Sales Entry'],['stock','Stock'],['expense','Expenses'],['report','PL Reports'],['credit','Credit'],['setup','Settings']];
function render(){
  const view=$('#view');
  renderStatus();
  if(S.mode==='loading'||(S.mode!=='error'&&!S.config)){
    $('#tabs').innerHTML=''; $('#rateBoard').innerHTML='';
    view.innerHTML='<div class="panel"><div class="empty">Opening the bunk…</div></div>';
    return;
  }
  if(S.mode==='error'){
    $('#tabs').innerHTML=''; $('#rateBoard').innerHTML='';
    view.innerHTML=`<div class="panel"><div class="pb">
      <h2 style="margin-bottom:6px">Could not open this bunk</h2>
      <p style="color:var(--ink-2);margin:0 0 14px">${esc(S.error||'')}</p>
      <button class="btn" data-act="switchbunk">Choose another bunk</button>
      <button class="btn ghost" data-act="signout">Sign out</button></div></div>`;
    return;
  }
  if(S.mode==='setup'){ $('#tabs').innerHTML=''; $('#rateBoard').innerHTML=''; $('#hdName').textContent='BunkSoft'; $('#hdMeta').textContent='First-time setup'; view.innerHTML=vSetupFirst(); return; }
  if(!S.shift)S.shift=S.config.shifts?.[0]||null;
  $('#hdName').textContent=S.config.station||'BunkSoft';
  $('#hdMeta').textContent=[S.config.brand,S.config.place].filter(Boolean).join(' · ')||'by Subsel Tech Solutions';
  $('#curDate').value=S.date;
  $('#tabs').innerHTML=TABS.map(([k,t])=>`<button class="nv" data-tab="${k}" aria-current="${S.tab===k}">${svgIcon(k)}<span>${t}</span></button>`).join('');
  renderRateBoard();
  const fn={dash:vDash,shift:vShift,stock:vStock,credit:vCredit,expense:vExpense,report:vReport,setup:vSetup}[S.tab]||vDash;
  if(S.tab==='setup'&&repo.canConfigure()&&!S.membersLoaded){
    S.membersLoaded=true;
    repo.members().then(m=>{S.members=m;render();}).catch(()=>{});
  }
  view.innerHTML=storageBanner()+fn();
  if(S.modal)$('#layer').innerHTML=S.modal(); else $('#layer').innerHTML='';
  wireLive();
  /* phone: the nav is a horizontal strip — keep the active section in view */
  if(window.innerWidth<=900) $('#tabs .nv[aria-current="true"]')?.scrollIntoView({block:'nearest',inline:'center'});
}
const banner=h=>`<div class="banner">${h}</div>`;
function renderStatus(){
  const el=$('#storageDot'); if(!el)return;
  const tone={owner:'ok',manager:'ok',operator:'wr'}[repo.role]||'wr';
  el.className='pill '+(BUSY?'wr':tone);
  el.textContent=BUSY?'Saving…':({owner:'Owner',manager:'Manager',operator:'Operator'}[repo.role]||'Signed in');
  el.title='Signed in as '+(SESSION_EMAIL||'')+' — '+repo.role;
}
function storageBanner(){
  if(repo.canConfigure())return '';
  return banner('<b>Operator access.</b> You can run shifts, stock, credit and expenses. Rates, tanks and nozzles are read-only.');
}
function renderRateBoard(){
  const d=getDay(S.date);
  $('#rateBoard').innerHTML=`<span class="rbtag">Rate board · ${dmy(S.date)}</span>`+
    activeProducts().map(p=>`<span class="rbitem"><b>${esc(p.short)}</b><span>₹${nf(d.rates[p.id]?.sell||0,2)}</span></span>`).join('')+
    `<button class="rbedit" data-act="rates">Revise rates</button>`;
}

/* ---------------- dashboard ---------------- */
function vDash(){
  const t=dayTotals(S.date), day=getDay(S.date);
  const prods=S.config.products.filter(p=>t.byProd[p.id]?.qty);
  const days=lastNDays(14);
  const slips=Object.values(day.shifts).reduce((a,s)=>a+(s.credit||[]).length,0);
  return `
  <div class="kpis">
    ${kpi('blue','shift','Total Sales',money(t.fuel+t.other),nf(t.qty,0)+' L on '+dmy(S.date))}
    ${kpi('teal','stock','Stock Value',money(stockValue()),'fuel held across '+plural(S.tanks.length,'tank'))}
    ${kpi('amber','expense','Total Expenses',money(t.expenses),plural((day.expenses||[]).length,'entry').replace('entrys','entries'))}
    ${kpi('red','credit','Pending Credits',money(outstanding()),plural(S.customers.length,'account')+' outstanding')}
  </div>

  <div class="stats">
    ${stat('Collected today',money(t.received),'cash + card + UPI')}
    ${t.costMissing
      ? stat('Gross margin','—','set a purchase rate to see this','wrn')
      : stat('Gross margin',money(t.margin),'fuel + lubes, before expenses',t.margin>=0?'pos':'neg')}
    ${t.costMissing
      ? stat('Net for the day','—','purchase rate missing','wrn')
      : stat('Net for the day',money(t.net),t.net>=0?'profit':'loss',t.net>=0?'pos':'neg')}
    ${stat('Credit given',money(t.credit),'on '+plural(slips,'slip'))}
    ${stat('Credit recovered',money(t.recovered),'from customers')}
    ${stat('Cash short / excess',diffTxt(t.diff),t.closed+' of '+S.config.shifts.length+' shifts closed',diffCls(t.diff))}
  </div>

  <div class="grid g23" style="margin-top:16px">
    <div class="panel" style="margin:0">
      <div class="ph"><h2>Sales Overview</h2><span class="hint">last 14 days</span><span class="spacer"></span>
        <button class="tb" data-act="chartmode">${S.chartMode==='value'?'Showing ₹':'Showing litres'}</button></div>
      ${chartStacked(days)}
    </div>
    <div class="panel" style="margin:0">
      <div class="ph"><h2>Fuel Wise Sales</h2><span class="hint">${dmy(S.date)}</span></div>
      ${prods.length?chartDonut(prods.map(p=>({label:p.short,value:t.byProd[p.id].qty,color:pcol(p.id)})),'L')
        :'<div class="empty">No readings entered for this date yet.</div>'}
      <div style="padding:2px 16px 16px;border-top:1px solid var(--line)">
        <div class="sectitle" style="margin-top:14px">Collections</div>
        <div class="kv"><span>Cash</span><span>${money(t.cash)}</span></div>
        <div class="kv"><span>UPI</span><span>${money(t.upi)}</span></div>
        <div class="kv"><span>Card</span><span>${money(t.card)}</span></div>
        <div class="kv"><span>Bank transfer</span><span>${money(t.bank)}</span></div>
        <div class="kv"><span>Credit</span><span>${money(t.credit)}</span></div>
        <div class="kv" style="border-top:1px solid var(--line);margin-top:6px;padding-top:7px"><span style="color:var(--ink)!important;font-weight:700">Total billed</span><span style="font-weight:700">${money(t.cash+t.card+t.upi+t.bank+t.credit)}</span></div>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="ph"><h2>Tank stock</h2><span class="hint">book stock after today's sales and receipts</span></div>
    <div class="pb"><div class="tanks">${S.tanks.map(tankCard).join('')||'<div class="empty">No tanks configured. Add them under Setup.</div>'}</div></div>
  </div>

  <div class="panel">
    <div class="ph"><h2>Shifts</h2><span class="hint">${dmy(S.date)}</span><span class="spacer"></span>
      <button class="btn sm" data-act="pdf-day">Day report PDF</button></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Shift</th><th>Operator</th><th class="r">Litres</th><th class="r">Sale value</th><th class="r">Cash</th><th class="r">UPI</th><th class="r">Card</th><th class="r">Bank</th><th class="r">Credit</th><th class="r">Short / excess</th><th></th></tr></thead>
      <tbody>${S.config.shifts.map(nm=>{
        const has=!!day.shifts[nm]; const x=shiftTotals(day,nm);
        return `<tr>
          <td><b>${esc(nm)}</b> ${has?(x.sh.closed?'<span class="pill ok">closed</span>':'<span class="pill wr">draft</span>'):'<span class="pill">pending</span>'}</td>
          <td>${esc(x.sh.operator||'—')}</td>
          <td class="r num">${has?nf(x.qty,2):'—'}</td>
          <td class="r num">${has?money(x.due):'—'}</td>
          <td class="r num">${has?money(x.sh.cash):'—'}</td>
          <td class="r num">${has?money(x.sh.upi):'—'}</td>
          <td class="r num">${has?money(x.sh.card):'—'}</td>
          <td class="r num">${has?money(x.sh.bank):'—'}</td>
          <td class="r num">${has?money(x.credit):'—'}</td>
          <td class="r num ${has?diffCls(x.diff):''}">${has?diffTxt(x.diff):'—'}</td>
          <td class="r" style="white-space:nowrap">${has?`<button class="btn ghost sm" data-act="shiftreport" data-shift="${esc(nm)}">Report</button> `:''}<button class="btn ghost sm" data-act="goshift" data-shift="${esc(nm)}">${has?'Open':'Enter'}</button></td></tr>`;}).join('')}
      </tbody></table></div></div>
  </div>

  ${vCashBook()}`;
}

/* ---------------- cash book ---------------- */
function vCashBook(){
  const day=getDay(S.date), c=cashBook(S.date);
  const row=(k,v,cls='')=>`<div class="rline"><span>${k}</span><span class="${cls}">${v}</span></div>`;
  return `<div class="grid g2" style="margin-top:16px">
    <div class="panel" style="margin:0">
      <div class="ph"><h2>Cash book</h2><span class="hint">${dmy(S.date)}</span></div>
      <div class="pb" style="padding-bottom:6px"><div class="fr" style="max-width:520px">
        <label class="f"><span>Opening cash in hand ₹</span><input type="number" step="0.01" id="cb_open" value="${day.openingCash||''}" placeholder="0"></label>
        <label class="f"><span>Cash counted at close ₹</span><input type="number" step="0.01" id="cb_count" value="${day.cashCounted??''}" placeholder="not counted"></label>
        <button class="btn" data-act="savecash">Save</button>
        <button class="btn ghost" data-act="carrycash">Carry from yesterday</button>
      </div></div>
      <div style="padding-bottom:8px">
        ${row('Opening cash in hand',money(c.opening))}
        ${row('Add: cash sales',money(c.T.cash))}
        ${row('Add: credit recovered in cash',money(c.recovCash))}
        ${row('Less: expenses paid in cash','('+money(c.expCash).slice(1)+')')}
        ${row('Less: deposited to bank','('+money(c.deposits).slice(1)+')')}
        <div class="rline big"><span>Closing cash in hand</span><span>${money(c.closing)}</span></div>
        ${c.counted===null?'<div class="rline"><span style="color:var(--ink-3)">Cash not counted yet</span><span>—</span></div>'
          :row('Cash counted',money(c.counted))}
        ${c.diff===null?'':`<div class="rline big" style="background:${Math.abs(c.diff)<1?'var(--good-soft)':'var(--bad-soft)'};color:${Math.abs(c.diff)<1?'var(--good)':'var(--bad)'}">
          <span>Difference</span><span>${diffTxt(c.diff)}</span></div>`}
      </div>
    </div>

    <div class="panel" style="margin:0">
      <div class="ph"><h2>Receipts by mode</h2><span class="hint">last 24 hours</span></div>
      <div style="padding-bottom:8px">
        ${row('Cash',money(c.T.cash))}
        ${row('UPI',money(c.T.upi))}
        ${row('Card',money(c.T.card))}
        ${row('Bank transfer',money(c.T.bank))}
        ${row('Credit (unpaid)',money(c.T.credit))}
        <div class="rline big"><span>Total received</span><span>${money(c.T.received+c.T.credit)}</span></div>
        ${row('Sale value for the day',money(c.T.fuel+c.T.other))}
        <div class="rline big" style="background:${Math.abs(c.T.diff)<1?'var(--good-soft)':'var(--bad-soft)'};color:${Math.abs(c.T.diff)<1?'var(--good)':'var(--bad)'}">
          <span>Short / excess</span><span>${diffTxt(c.T.diff)}</span></div>
        ${row('Credit recovered by bank / UPI',money(c.recovBank))}
        <div class="rline big"><span>Into the bank today</span><span>${money(c.toBank)}</span></div>
      </div>
      <div class="pb" style="border-top:1px solid var(--line)">
        <div class="sectitle" style="margin-top:0">Cash deposited to bank</div>
        <div class="fr">
          <label class="f"><span>Amount ₹</span><input type="number" step="0.01" id="dp_amt" placeholder="0"></label>
          <label class="f"><span>Bank</span><input type="text" id="dp_bank" placeholder="e.g. SBI current"></label>
          <label class="f"><span>Slip / ref</span><input type="text" id="dp_ref" placeholder="optional"></label>
          <button class="btn" data-act="adddeposit">Add</button>
        </div>
        <div class="tw" style="margin-top:10px"><table>
          <thead><tr><th>Time</th><th>Bank</th><th>Ref</th><th class="r">Amount</th><th></th></tr></thead>
          <tbody>${(day.deposits||[]).map(d=>`<tr><td class="num">${esc(d.time||'—')}</td><td>${esc(d.bank||'—')}</td><td>${esc(d.ref||'—')}</td>
            <td class="r num">${money(d.amount)}</td><td class="r"><button class="x" data-act="deldeposit" data-id="${esc(d.id)}">✕</button></td></tr>`).join('')
            ||'<tr><td colspan="5" class="empty">No deposit recorded on this date.</td></tr>'}</tbody></table></div>
      </div>
    </div>
  </div>`;
}
function stat(k,v,s,cls=''){return `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;}
function kpi(tone,icon,k,v,s){
  return `<div class="kpi ${tone}"><div class="ki">${svgIcon(icon)}</div>
    <div class="kk">${k}</div><div class="kv">${v}</div><div class="ks">${s}</div></div>`;
}
/* Value of fuel sitting in the tanks, at the current purchase rate. */
function stockValue(){return S.tanks.reduce((a,t)=>a+num(t.stock)*num(prod(t.product).buy),0);}

/* Part-to-whole: donut with direct labels on every slice plus a valued legend. */
function chartDonut(items,unit){
  const total=items.reduce((a,b)=>a+b.value,0);
  if(!total)return '<div class="empty">Nothing sold on this date.</div>';
  const R=52,r=32,CX=60,CY=60,GAP=0.022;
  let a0=-Math.PI/2, arcs='';
  items.forEach(it=>{
    const frac=it.value/total, a1=a0+frac*Math.PI*2;
    const s=a0+GAP/2, e=Math.max(s+0.001,a1-GAP/2), large=(e-s)>Math.PI?1:0;
    const p=(rad,ang)=>[CX+rad*Math.cos(ang),CY+rad*Math.sin(ang)];
    if(frac>0.995){ arcs+=`<circle cx="${CX}" cy="${CY}" r="${(R+r)/2}" fill="none" stroke-width="${R-r}" style="stroke:${it.color}"/>`; }
    else{
      const[x1,y1]=p(R,s),[x2,y2]=p(R,e),[x3,y3]=p(r,e),[x4,y4]=p(r,s);
      arcs+=`<path d="M${x1} ${y1}A${R} ${R} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${r} ${r} 0 ${large} 0 ${x4} ${y4}Z" style="fill:${it.color}"/>`;
    }
    a0=a1;
  });
  return `<svg class="donut" viewBox="0 0 120 120" role="img" aria-label="Share of volume by fuel">
      ${arcs}
      <text x="${CX}" y="${CY-2}" text-anchor="middle" style="fill:var(--ink);font-family:var(--fd);font-size:15px;font-weight:700">${nf(total,0)}</text>
      <text x="${CX}" y="${CY+11}" text-anchor="middle" style="fill:var(--ink-3);font-family:var(--fb);font-size:8px">${unit==='L'?'litres':'total'}</text>
    </svg>
    <div class="dlegend">${items.map(it=>`<div class="dlrow"><i class="dot" style="background:${it.color}"></i>
      <span>${esc(it.label)}</span><i>${Math.round(it.value/total*100)}%</i><b>${nf(it.value,0)}${unit==='L'?' L':''}</b></div>`).join('')}</div>`;
}
function tankCard(t){
  const p=prod(t.product), pct=Math.max(0,Math.min(100,(num(t.stock)/Math.max(1,num(t.capacity)))*100));
  const low=num(t.stock)<=num(t.min);
  const sold=soldToday(S.date,t.id), rec=recvToday(S.date,t.id);
  const avg=avgDaily(t.id); const dos=avg>0?(num(t.stock)/avg):null;
  return `<div class="tank">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span class="chip"><i class="dot" style="background:${pcol(t.product)}"></i>${esc(t.name)} · ${esc(p.short)}</span>
      ${low?'<span class="pill no">low</span>':(dos!==null&&dos<2?'<span class="pill wr">'+dos.toFixed(1)+'d</span>':'')}
    </div>
    <div class="gauge"><div class="gfill" style="width:${pct}%;background:${pcol(t.product)}"></div>
      <div class="gmark" style="left:${Math.min(100,(num(t.min)/Math.max(1,num(t.capacity)))*100)}%" title="Reorder level"></div></div>
    <div class="kv"><span>Book stock</span><span>${nf(t.stock,0)} L <span style="color:var(--ink-3)">/ ${nf(t.capacity,0)}</span></span></div>
    <div class="kv"><span>Received today</span><span>${rec?'+'+nf(rec,0)+' L':'—'}</span></div>
    <div class="kv"><span>Sold today</span><span>${sold?'−'+nf(sold,2)+' L':'—'}</span></div>
    <div class="kv"><span>Cover at 7-day avg</span><span>${dos===null?'—':dos.toFixed(1)+' days'}</span></div>
  </div>`;
}
function avgDaily(tankId){
  const ds=lastNDays(7).filter(d=>d.hasData); if(!ds.length)return 0;
  let q=0; ds.forEach(d=>q+=soldToday(d.date,tankId)); return q/ds.length;
}
function lastNDays(n){
  const out=[];
  for(let i=n-1;i>=0;i--){
    const date=shiftDate(S.date,-i), d=S.days[date];
    const t=d?dayTotals(date):null;
    out.push({date,hasData:!!(t&&t.qty),byProd:t?t.byProd:{},value:t?t.fuel:0,qty:t?t.qty:0});
  }
  return out;
}

/* ---------------- chart ---------------- */
function chartStacked(days){
  const prods=S.config.products.filter(p=>!p.archived||days.some(d=>d.byProd[p.id]?.qty)), W=Math.max(520,days.length*46), H=210, PL=54, PR=12, PT=14, PB=30;
  const val=d=>prods.map(p=>S.chartMode==='value'?(d.byProd[p.id]?.amount||0):(d.byProd[p.id]?.qty||0));
  const tot=days.map(d=>val(d).reduce((a,b)=>a+b,0));
  const max=Math.max(1,...tot), step=niceStep(max), top=Math.ceil(max/step)*step;
  const iw=W-PL-PR, ih=H-PT-PB, bw=Math.min(30,iw/days.length*0.62);
  const x=i=>PL+iw*((i+0.5)/days.length), y=v=>PT+ih-(v/top)*ih;
  let ticks=''; for(let v=0;v<=top+1e-6;v+=step){const yy=y(v);
    ticks+=`<line x1="${PL}" x2="${W-PR}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/>
      <text x="${PL-8}" y="${yy+3.5}" text-anchor="end" style="fill:var(--ink-3);font-family:var(--fm);font-size:10px">${S.chartMode==='value'?compact(v):nf(v,0)}</text>`;}
  let bars='';
  days.forEach((d,i)=>{
    const vs=val(d); let acc=0;
    vs.forEach((v,pi)=>{
      if(v<=0)return;
      const y1=y(acc+v), y0=y(acc), h=Math.max(1,y0-y1-2);
      const topSeg=vs.slice(pi+1).every(z=>z<=0);
      bars+=`<rect x="${x(i)-bw/2}" y="${y1}" width="${bw}" height="${h}" rx="${topSeg?3:0}" style="fill:${pcol(prods[pi].id)}"></rect>`;
      acc+=v;
    });
    bars+=`<rect class="hit" x="${x(i)-iw/days.length/2}" y="${PT}" width="${iw/days.length}" height="${ih}" fill="transparent" data-i="${i}"></rect>`;
    if(days.length<=16||i%2===0)
      bars+=`<text x="${x(i)}" y="${H-10}" text-anchor="middle" style="fill:var(--ink-3);font-family:var(--fm);font-size:10px">${dshort(d.date)}</text>`;
  });
  const data=days.map(d=>({date:d.date,vals:val(d)}));
  window.__chart={data,prods:prods.map(p=>p.short),mode:S.chartMode};
  return `<div class="chartwrap"><svg class="chart" id="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily fuel sales, last ${days.length} days">
    ${ticks}<line x1="${PL}" x2="${W-PR}" y1="${PT+ih}" y2="${PT+ih}" stroke="var(--line-2)" stroke-width="1"/>${bars}
  </svg></div>
  <div class="legend">${prods.map(p=>`<span class="chip"><i class="dot" style="background:${pcol(p.id)}"></i>${esc(p.short)}</span>`).join('')}</div>`;
}
function niceStep(max){const raw=max/4,mag=Math.pow(10,Math.floor(Math.log10(raw)||0)),n=raw/mag;return (n<=1?1:n<=2?2:n<=5?5:10)*mag;}
function compact(v){return v>=1e7?'₹'+(v/1e7).toFixed(1)+'cr':v>=1e5?'₹'+(v/1e5).toFixed(1)+'L':v>=1000?'₹'+Math.round(v/1000)+'k':'₹'+Math.round(v);}

/* ---------------- shift entry ---------------- */
function vShift(){
  const day=getDay(S.date); const nm=S.shift;
  if(!day.shifts[nm])day.shifts[nm]=blankShift();
  const sh=day.shifts[nm], t=shiftTotals(day,nm);
  return `
  <div class="panel">
    <div class="ph">
      <h2>Shift entry</h2><span class="hint">${dmy(S.date)}</span><span class="spacer"></span>
      ${S.config.shifts.map(x=>`<button class="tb" data-act="setshift" data-shift="${esc(x)}" style="${x===nm?'border-color:var(--accent);color:var(--accent)':''}">${esc(x)}</button>`).join('')}
    </div>
    <div class="pb">
      <div class="fr" style="max-width:560px">
        <label class="f"><span>Operator / cashier</span><input type="text" id="f_operator" value="${esc(sh.operator||'')}" placeholder="Name on the shift sheet"></label>
        <label class="f"><span>Status</span><select id="f_closed"><option value="0"${!sh.closed?' selected':''}>Draft</option><option value="1"${sh.closed?' selected':''}>Closed &amp; handed over</option></select></label>
      </div>

      <div class="sectitle">Nozzle meter readings</div>
      <div class="tw"><table id="nozTable">
        <thead><tr><th>Nozzle</th><th>Product</th><th class="r">Opening</th><th class="r">Closing</th><th class="r">Test (L)</th><th class="r">Rollover (L)</th><th class="r">Sold (L)</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
        <tbody>${t.lines.map(l=>`<tr data-noz="${esc(l.noz.id)}">
          <td><b>${esc(l.noz.name)}</b>${l.noz.archived?' <span class="chip" title="This nozzle has been retired. Its past readings stay on the books.">retired</span>':''}</td>
          <td><span class="chip"><i class="dot" style="background:${pcol(l.noz.product)}"></i>${esc(prod(l.noz.product).short)}</span></td>
          <td class="r"><input class="mono r" type="number" step="0.01" data-fld="open" value="${l.open||''}" style="text-align:right"></td>
          <td class="r"><input class="mono r" type="number" step="0.01" data-fld="close" value="${l.close||''}" style="text-align:right" placeholder="totalizer"></td>
          <td class="r"><input class="mono r" type="number" step="0.01" data-fld="test" value="${l.test||''}" style="text-align:right" placeholder="0"></td>
          <td class="r"><input class="mono r" type="number" step="1" data-fld="roll" value="${l.rollover||''}" style="text-align:right" placeholder="0" title="Only when the totalizer wrapped past all nines. Use the Check readings button to fill this in."></td>
          <td class="r num" data-out="qty">${nf(l.qty,2)}</td>
          <td class="r num" style="color:var(--ink-3)">${nf(l.rate,2)}</td>
          <td class="r num" data-out="amt">${money(l.amount)}</td></tr>`).join('')}
          <tr class="totalrow"><td colspan="6">Total</td><td class="r num" id="tQty">${nf(t.qty,2)}</td><td></td><td class="r num" id="tAmt">${money(t.fuel)}</td></tr>
        </tbody></table></div>
      <div class="setupnote" id="nozWarn">Opening is carried from the previous shift's closing — correct it only if the meter was reset or swapped. Test litres are returned to the tank and are not billed. Rollover stays 0 unless the totalizer wrapped past all nines; if a closing is below its opening the app will offer to record the wrap for you.</div>
      ${sh.closed&&sh.ratesAtClose?`<div class="setupnote">Valued at the rates this shift was closed at. Later rate revisions do not restate it.</div>`:''}

      <div class="sectitle">Credit slips (udhaar)</div>
      <div class="tw"><table><thead><tr><th>Customer</th><th>Vehicle</th><th>Slip no.</th><th class="r">Litres</th><th class="r">Amount</th><th></th></tr></thead>
        <tbody id="creditRows">${(sh.credit||[]).map(c=>{const cu=cust(c.cust);return `<tr>
          <td>${esc(cu?cu.name:'Deleted account')}</td><td>${esc(c.vehicle||'—')}</td><td class="num">${esc(c.slip||'—')}</td>
          <td class="r num">${c.qty?nf(c.qty,2):'—'}</td><td class="r num">${money(c.amount)}</td>
          <td class="r"><button class="x" data-act="delcredit" data-id="${esc(c.id)}" title="Remove slip">✕</button></td></tr>`;}).join('')
          ||'<tr><td colspan="6" class="empty">No credit sales in this shift.</td></tr>'}
        </tbody></table></div>
      ${(day.unassignedCredit||[]).length?`<div class="setupnote" style="border-color:var(--wrn,#caa)">
        <b>${plural(day.unassignedCredit.length,'slip')} on this day belongs to no shift</b> — the shift it was entered in was cleared.
        ${money(strayCredit(day))} is still owed and is counted in the day's credit.
        <div class="tw" style="margin-top:8px"><table><thead><tr><th>Customer</th><th>Slip no.</th><th class="r">Amount</th><th></th></tr></thead>
        <tbody>${day.unassignedCredit.map(c=>{const cu=cust(c.cust);return `<tr>
          <td>${esc(cu?cu.name:'Deleted account')}</td><td class="num">${esc(c.slip||'—')}</td>
          <td class="r num">${money(c.amount)}</td>
          <td class="r"><button class="x" data-act="delcredit" data-id="${esc(c.id)}" title="Remove slip">✕</button></td></tr>`;}).join('')}
        </tbody></table></div></div>`:''}
      ${S.customers.length?`<div class="fr" style="margin-top:10px">
        <label class="f"><span>Customer</span><select id="cr_cust">${S.customers.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Product</span><select id="cr_prod">${activeProducts().map(p=>`<option value="${esc(p.id)}">${esc(p.short)}</option>`).join('')}</select></label>
        <label class="f"><span>Litres</span><input type="number" step="0.01" id="cr_qty" placeholder="0.00"></label>
        <label class="f"><span>Amount ₹</span><input type="number" step="0.01" id="cr_amt" placeholder="auto"></label>
        <label class="f"><span>Slip no.</span><input type="text" id="cr_slip" placeholder="e.g. 1284"></label>
        <button class="btn" data-act="addcredit">Add slip</button></div>`
        :`<div class="setupnote">Add credit customers under the Credit tab first.</div>`}

      <div class="sectitle">Collections &amp; other sales</div>
      <div class="fr" style="max-width:820px">
        <label class="f"><span>Cash ₹</span><input type="number" step="0.01" id="f_cash" value="${sh.cash||''}" placeholder="0"></label>
        <label class="f"><span>Card ₹</span><input type="number" step="0.01" id="f_card" value="${sh.card||''}" placeholder="0"></label>
        <label class="f"><span>UPI ₹</span><input type="number" step="0.01" id="f_upi" value="${sh.upi||''}" placeholder="0"></label>
        <label class="f"><span>Bank transfer ₹</span><input type="number" step="0.01" id="f_bank" value="${sh.bank||''}" placeholder="0"></label>
        <label class="f"><span>Lube / other sale ₹</span><input type="number" step="0.01" id="f_other" value="${sh.other?.amount||''}" placeholder="0"></label>
        <label class="f"><span>Cost of that ₹</span><input type="number" step="0.01" id="f_othercost" value="${sh.other?.cost||''}" placeholder="0"></label>
      </div>

      <div class="meter" style="margin-top:14px">
        <div class="m"><b>Due</b><span id="mDue">${money(t.due)}</span></div>
        <div class="m"><b>Received</b><span id="mRecv">${money(t.recv)}</span></div>
        <div class="m"><b>Credit</b><span class="d" id="mCredit">${money(t.credit)}</span></div>
        <div class="m" style="margin-left:auto"><b>Short / excess</b><span id="mDiff" style="color:${Math.abs(t.diff)<1?'var(--display-ink)':(t.diff<0?'#FF7A7A':'#7BE0A8')}">${t.diff>=0?'+':'−'}₹${nf(Math.abs(t.diff),2)}</span></div>
      </div>

      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        <button class="btn" data-act="saveshift">Save shift</button>
        <button class="btn ghost" data-act="saveshift" data-close="1">Save &amp; close shift</button>
        ${day.shifts[nm]&&(t.qty||t.recv)&&(!sh.closed||repo.canConfigure())
          ?'<button class="btn ghost" data-act="clearshift" style="margin-left:auto">Clear this shift</button>':''}
        ${sh.closed&&!repo.canConfigure()?'<span class="hint" style="margin-left:auto">A closed shift can only be cleared by the owner or a manager.</span>':''}
      </div>
    </div>
  </div>`;
}

/* ---------------- stock ---------------- */
function vStock(){
  const day=getDay(S.date);
  return `
  <div class="panel">
    <div class="ph"><h2>Tanks</h2><span class="hint">${dmy(S.date)}</span></div>
    <div class="pb"><div class="tanks">${S.tanks.map(tankCard).join('')||'<div class="empty">No tanks yet — add them in Setup.</div>'}</div></div>
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="panel" style="margin:0">
      <div class="ph"><h2>Decantation</h2><span class="hint">tanker receipt</span></div>
      <div class="pb">
        <div class="fr">
          <label class="f"><span>Tank</span><select id="rc_tank">${S.tanks.map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${esc(prod(t.product).short)}</option>`).join('')}</select></label>
          <label class="f"><span>Quantity (L)</span><input type="number" step="1" id="rc_qty" placeholder="e.g. 12000"></label>
          <label class="f"><span>Rate ₹/L</span><input type="number" step="0.01" id="rc_rate" placeholder="invoice rate"></label>
          <label class="f"><span>Invoice no.</span><input type="text" id="rc_inv" placeholder="IOC/…"></label>
          <label class="f"><span>Tanker no.</span><input type="text" id="rc_truck" placeholder="TN 45 K …"></label>
          <button class="btn" data-act="addreceipt">Add receipt</button>
        </div>
        <div class="setupnote">The invoice rate becomes the product's purchase cost for margin from this date on.</div>
        <div class="tw" style="margin-top:12px"><table>
          <thead><tr><th>Tank</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Value</th><th>Invoice</th><th></th></tr></thead>
          <tbody>${(day.receipts||[]).map(r=>`<tr>
            <td><span class="chip"><i class="dot" style="background:${pcol(r.product)}"></i>${esc(tank(r.tank)?.name||r.tank)}</span></td>
            <td class="r num">${nf(r.qty,0)} L</td><td class="r num">${nf(r.rate,2)}</td><td class="r num">${money(num(r.qty)*num(r.rate))}</td>
            <td>${esc(r.invoice||'—')}<div style="font-size:11px;color:var(--ink-3)">${esc(r.truck||'')}</div></td>
            <td class="r"><button class="x" data-act="delreceipt" data-id="${esc(r.id)}" title="Remove">✕</button></td></tr>`).join('')
            ||'<tr><td colspan="6" class="empty">No decantation recorded on this date.</td></tr>'}
          </tbody></table></div>
      </div>
    </div>

    <div class="panel" style="margin:0">
      <div class="ph"><h2>Dip reading</h2><span class="hint">physical vs book</span></div>
      <div class="pb">
        <div class="fr">
          <label class="f"><span>Tank</span><select id="dp_tank">${S.tanks.map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${esc(prod(t.product).short)}</option>`).join('')}</select></label>
          <label class="f"><span>Dip stock (L)</span><input type="number" step="1" id="dp_qty" placeholder="from dip chart"></label>
          <button class="btn" data-act="adddip">Record dip</button>
        </div>
        <div class="setupnote">Recording a dip sets book stock to the measured quantity and logs the difference as gain or loss.
          Removing a dip from this list deletes the record but does not rewind the stock — a measurement cannot be un-taken.
          To correct a wrong dip, record another one with the right figure.</div>
        <div class="tw" style="margin-top:12px"><table>
          <thead><tr><th>Tank</th><th class="r">Book</th><th class="r">Dip</th><th class="r">Variation</th><th class="r">Valued</th><th></th></tr></thead>
          <tbody>${(day.dips||[]).map(d=>{const v=num(d.dip)-num(d.book);return `<tr>
            <td><span class="chip"><i class="dot" style="background:${pcol(d.product)}"></i>${esc(tank(d.tank)?.name||d.tank)}</span></td>
            <td class="r num">${nf(d.book,0)}</td><td class="r num">${nf(d.dip,0)}</td>
            <td class="r num ${v>=0?'pos':'neg'}">${v>=0?'+':'−'}${nf(Math.abs(v),0)} L</td>
            <td class="r num ${v>=0?'pos':'neg'}">${money(v*(day.rates[d.product]?.buy||0))}</td>
            <td class="r"><button class="x" data-act="deldip" data-id="${esc(d.id)}" title="Remove">✕</button></td></tr>`;}).join('')
            ||'<tr><td colspan="6" class="empty">No dip recorded on this date.</td></tr>'}
          </tbody></table></div>
      </div>
    </div>
  </div>`;
}

/* ---------------- credit ---------------- */
function vCredit(){
  const day=getDay(S.date);
  const over=S.customers.filter(c=>num(c.limit)>0&&num(c.balance)>num(c.limit)).length;
  return `
  <div class="stats">
    ${stat('Total outstanding',money(outstanding()),S.customers.length+' accounts',outstanding()>0?'wrn':'')}
    ${stat('Recovered today',money((day.payments||[]).reduce((a,b)=>a+num(b.amount),0)),(day.payments||[]).length+' receipts')}
    ${stat('Issued today',money(dayTotals(S.date).credit),'credit sales')}
    ${stat('Over limit',String(over),over?'accounts need attention':'all within limit',over?'neg':'pos')}
  </div>

  <div class="panel">
    <div class="ph"><h2>Credit accounts</h2><span class="spacer"></span>
      <button class="btn sm" data-act="newcust">Add customer</button>
      <button class="btn ghost sm" data-act="export-credit">Export CSV</button></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Customer</th><th>Vehicle</th><th>Phone</th><th class="r">Limit</th><th class="r">Outstanding</th><th class="r">Used</th><th></th></tr></thead>
      <tbody>${S.customers.length?S.customers.slice().sort((a,b)=>num(b.balance)-num(a.balance)).map(c=>{
        const pct=num(c.limit)>0?Math.min(100,num(c.balance)/num(c.limit)*100):0;
        return `<tr>
        <td><b>${esc(c.name)}</b></td><td class="num">${esc(c.vehicle||'—')}</td><td class="num">${esc(c.phone||'—')}</td>
        <td class="r num">${num(c.limit)?money(c.limit):'—'}</td>
        <td class="r num ${num(c.balance)>0?'wrn':''}">${money(c.balance)}</td>
        <td class="r" style="width:110px">${num(c.limit)?`<div class="gauge" style="margin:0"><div class="gfill" style="width:${pct}%;background:${pct>=100?'var(--bad)':pct>80?'var(--warn)':'var(--c0)'}"></div></div>`:'—'}</td>
        <td class="r" style="white-space:nowrap">
          <button class="btn ghost sm" data-act="ledger" data-id="${esc(c.id)}">Ledger</button>
          <button class="btn ghost sm" data-act="pay" data-id="${esc(c.id)}">Receive</button></td></tr>`;}).join('')
        :'<tr><td colspan="7" class="empty">No credit accounts yet. Add your regular fleet and cab customers here.</td></tr>'}
      </tbody></table></div></div>
  </div>

  <div class="panel">
    <div class="ph"><h2>Receipts on ${dmy(S.date)}</h2></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Customer</th><th>Mode</th><th>Note</th><th class="r">Amount</th><th></th></tr></thead>
      <tbody>${(day.payments||[]).map(p=>`<tr><td>${esc(cust(p.cust)?.name||'—')}</td><td>${esc(p.mode)}</td><td>${esc(p.note||'—')}</td>
        <td class="r num">${money(p.amount)}</td><td class="r"><button class="x" data-act="delpay" data-id="${esc(p.id)}">✕</button></td></tr>`).join('')
        ||'<tr><td colspan="5" class="empty">No payments received on this date.</td></tr>'}
      </tbody></table></div></div>
  </div>`;
}

/* ---------------- expenses ---------------- */
function vExpense(){
  const day=getDay(S.date), from=monthStart(S.date), to=S.date;
  const rows=[]; let total=0; const byHead={};
  Object.keys(S.days).filter(d=>d>=from&&d<=to).sort().forEach(d=>{
    (S.days[d].expenses||[]).forEach(e=>{rows.push({...e,date:d});total+=num(e.amount);addHead(byHead,e.head,num(e.amount));});
  });
  rows.reverse();
  return `
  <div class="panel">
    <div class="ph"><h2>Add expense</h2><span class="hint">${dmy(S.date)}</span></div>
    <div class="pb"><div class="fr" style="max-width:700px">
      <label class="f"><span>Head</span><select id="ex_head">${(S.config.heads||[]).map(h=>`<option>${esc(h)}</option>`).join('')}</select></label>
      <label class="f"><span>Paid by</span><select id="ex_mode">${PAYMODES.map(m=>`<option>${esc(m)}</option>`).join('')}</select></label>
      <label class="f"><span>Amount ₹</span><input type="number" step="0.01" id="ex_amt" placeholder="0"></label>
      <label class="f"><span>Note</span><input type="text" id="ex_note" placeholder="paid to / bill no."></label>
      <button class="btn" data-act="addexpense">Add</button>
    </div>
    <div class="tw" style="margin-top:12px"><table>
      <thead><tr><th>Head</th><th>Paid by</th><th>Note</th><th class="r">Amount</th><th></th></tr></thead>
      <tbody>${(day.expenses||[]).map(e=>`<tr><td>${esc(e.head)}</td><td><span class="pill">${esc(e.mode||'Cash')}</span></td><td>${esc(e.note||'—')}</td><td class="r num">${money(e.amount)}</td>
        <td class="r"><button class="x" data-act="delexpense" data-id="${esc(e.id)}">✕</button></td></tr>`).join('')
        ||'<tr><td colspan="5" class="empty">Nothing spent on this date yet.</td></tr>'}</tbody></table></div>
    </div>
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="panel" style="margin:0">
      <div class="ph"><h2>Month to date</h2><span class="hint">${dmy(from)} – ${dmy(to)}</span></div>
      <div class="pb tight"><div class="tw"><table id="headTable">
        <thead><tr><th>Head</th><th class="r">Amount</th><th class="r">Share</th></tr></thead>
        <tbody>${headList(byHead).map(h=>`<tr><td>${esc(h.label)}</td><td class="r num">${money(h.amount)}</td>
          <td class="r num" style="color:var(--ink-3)">${total?Math.round(h.amount/total*100):0}%</td></tr>`).join('')
          ||'<tr><td colspan="3" class="empty">No expenses this month.</td></tr>'}
          ${total?`<tr class="totalrow"><td>Total</td><td class="r num">${money(total)}</td><td></td></tr>`:''}
        </tbody></table></div></div>
    </div>
    <div class="panel" style="margin:0">
      <div class="ph"><h2>Recent entries</h2></div>
      <div class="pb tight"><div class="tw"><table>
        <thead><tr><th>Date</th><th>Head</th><th>Note</th><th class="r">Amount</th></tr></thead>
        <tbody>${rows.slice(0,25).map(e=>`<tr><td class="num">${dshort(e.date)}</td><td>${esc(e.head)}</td><td>${esc(e.note||'—')}</td><td class="r num">${money(e.amount)}</td></tr>`).join('')
          ||'<tr><td colspan="4" class="empty">Nothing recorded yet.</td></tr>'}</tbody></table></div></div>
    </div>
  </div>`;
}

/* ---------------- reports ---------------- */
function reportRange(){
  if(S.range)return S.range;
  return {from:monthStart(S.date),to:S.date};
}
function vReport(){
  const {from,to}=reportRange();
  const dates=Object.keys(S.days).filter(d=>d>=from&&d<=to).sort();
  /* Days never read cannot be distinguished from days with no trade, so say
     so rather than print a profit that is quietly missing a fortnight. */
  const gap=missingDays(from,to);
  const agg={qty:0,sales:0,cost:0,other:0,otherCost:0,expenses:0,byProd:{},byHead:{},cash:0,card:0,upi:0,bank:0,credit:0,recovered:0,diff:0,varQty:0,varVal:0,days:0};
  dates.forEach(d=>{
    const t=dayTotals(d); if(t.qty||t.expenses||t.other)agg.days++;
    if(t.costMissing)agg.costMissing=true;
    agg.qty+=t.qty;agg.other+=t.other;agg.otherCost+=t.otherCost;agg.expenses+=t.expenses;
    agg.cash+=t.cash;agg.card+=t.card;agg.upi+=t.upi;agg.bank+=t.bank;agg.credit+=t.credit;agg.recovered+=t.recovered;agg.diff+=t.diff;
    Object.entries(t.byProd).forEach(([p,b])=>{const x=agg.byProd[p]||(agg.byProd[p]={qty:0,amount:0,cost:0});x.qty+=b.qty;x.amount+=b.amount;x.cost+=b.cost;agg.sales+=b.amount;agg.cost+=b.cost;});
    (S.days[d].expenses||[]).forEach(e=>addHead(agg.byHead,e.head,num(e.amount)));
    (S.days[d].dips||[]).forEach(dp=>{const v=num(dp.dip)-num(dp.book);agg.varQty+=v;agg.varVal+=v*(S.days[d].rates?.[dp.product]?.buy||0);});
  });
  const grossFuel=agg.sales-agg.cost, grossOther=agg.other-agg.otherCost;
  const gross=grossFuel+grossOther+agg.varVal, net=gross-agg.expenses;
  const chartDays=dates.slice(-31).map(d=>{const t=dayTotals(d);return {date:d,byProd:t.byProd,value:t.fuel,qty:t.qty,hasData:!!t.qty};});
  const pl=[
    ['Fuel sales',agg.sales,'h'],
    ...S.config.products.filter(p=>agg.byProd[p.id]?.qty).map(p=>['   '+esc(p.name)+(p.archived?' (retired)':'')+' · '+nf(agg.byProd[p.id].qty,0)+' L',agg.byProd[p.id].amount,'s']),
    ['Less: cost of fuel sold',-agg.cost,''],
    ['Gross margin on fuel',grossFuel,'t'],
    ['Lube &amp; other sales',agg.other,''],
    ['Less: cost of lubes',-agg.otherCost,''],
    ['Stock variation (dip vs book)',agg.varVal,''],
    ['Gross profit',gross,'t'],
    ...headList(agg.byHead).map(h=>['   '+esc(h.label),-h.amount,'s']),
    ['Total expenses',-agg.expenses,''],
    ['Net profit',net,'g']
  ];
  return `
  <div class="panel">
    <div class="ph"><h2>Period</h2><span class="spacer"></span>
      <button class="tb" data-act="range" data-r="mtd">This month</button>
      <button class="tb" data-act="range" data-r="last">Last month</button>
      <button class="tb" data-act="range" data-r="30">Last 30 days</button>
      <button class="tb" data-act="range" data-r="fy">This FY</button>
    </div>
    <div class="pb"><div class="fr" style="max-width:520px">
      <label class="f"><span>From</span><input type="date" id="rg_from" value="${from}"></label>
      <label class="f"><span>To</span><input type="date" id="rg_to" value="${to}"></label>
      <button class="btn" data-act="applyrange">Apply</button>
    </div><div class="setupnote">${dmy(from)} – ${dmy(to)} · ${agg.days} business day${agg.days===1?'':'s'} with entries</div>
    ${gap.length?`<div class="setupnote" style="color:#c0392b"><b>${plural(gap.length,'day')} in this period has not been read from the database yet</b>
      — the figures below would be understated. <button class="btn sm" data-act="loadperiod">Load the whole period</button></div>`:''}</div>
  </div>

  <div class="stats">
    ${stat('Volume sold',nf(agg.qty,0)+' L',agg.days?nf(agg.qty/agg.days,0)+' L / day':'—')}
    ${stat('Sales value',money(agg.sales+agg.other),'fuel + lubes')}
    ${stat('Gross profit',money(gross),'after cost of goods',gross>=0?'pos':'neg')}
    ${stat('Expenses',money(agg.expenses),Object.keys(agg.byHead).length+' heads')}
    ${stat('Net profit',money(net),agg.qty?money2(net/agg.qty).replace('₹','₹')+' / litre':'—',net>=0?'pos':'neg')}
    ${stat('Cash short / excess',diffTxt(agg.diff),'across all shifts',diffCls(agg.diff))}
  </div>

  <div class="grid g23" style="margin-top:16px">
    <div class="panel" style="margin:0">
      <div class="ph"><h2>Profit &amp; loss</h2><span class="spacer"></span><button class="btn ghost sm" data-act="export-pl">Export CSV</button></div>
      ${agg.costMissing?`<div class="pb" style="padding-bottom:0"><div class="setupnote" style="color:#c0392b;margin:0">
        A product sold in this period has no purchase rate on record, so the cost of fuel sold — and every profit line below it — is understated.
        Set it under <b>Revise rates</b> for the days concerned.</div></div>`:''}
      <div class="pb tight"><div class="tw"><table>
        <tbody>${pl.map(([k,v,kind])=>`<tr class="${kind==='t'||kind==='g'?'totalrow':''}">
          <td style="${kind==='s'?'color:var(--ink-3);font-size:12.5px':kind==='g'?'font-weight:600':''}">${k}</td>
          <td class="r num" style="${kind==='g'?'font-size:16px;':''}${v<0&&kind!=='s'?'color:var(--ink-2);':''}${kind==='g'?(v>=0?'color:var(--good)':'color:var(--bad)'):''}">${v<0?'('+money(Math.abs(v)).slice(1)+')':money(v)}</td></tr>`).join('')}
        </tbody></table></div></div>
    </div>
    <div class="panel" style="margin:0">
      <div class="ph"><h2>Collections</h2></div>
      <div class="pb tight"><div class="tw"><table>
        <tbody>
          <tr><td>Cash</td><td class="r num">${money(agg.cash)}</td></tr>
          <tr><td>UPI</td><td class="r num">${money(agg.upi)}</td></tr>
          <tr><td>Card</td><td class="r num">${money(agg.card)}</td></tr>
          <tr><td>Bank transfer</td><td class="r num">${money(agg.bank)}</td></tr>
          <tr><td>Credit issued</td><td class="r num">${money(agg.credit)}</td></tr>
          <tr class="totalrow"><td>Total billed</td><td class="r num">${money(agg.cash+agg.card+agg.upi+agg.bank+agg.credit)}</td></tr>
          <tr><td>Credit recovered</td><td class="r num">${money(agg.recovered)}</td></tr>
          <tr><td>Outstanding now</td><td class="r num wrn">${money(outstanding())}</td></tr>
          <tr><td>Stock variation</td><td class="r num ${agg.varQty>=0?'pos':'neg'}">${agg.varQty>=0?'+':'−'}${nf(Math.abs(agg.varQty),0)} L</td></tr>
        </tbody></table></div></div>
    </div>
  </div>

  <div class="panel">
    <div class="ph"><h2>Daily sales</h2><span class="hint">${chartDays.length} day${chartDays.length===1?'':'s'}</span><span class="spacer"></span>
      <button class="tb" data-act="chartmode">${S.chartMode==='value'?'Showing ₹':'Showing litres'}</button>
      <button class="btn ghost sm" data-act="export-day">Export day book</button>
      <button class="btn sm" data-act="pdf-day">Day report PDF</button></div>
    ${chartDays.length?chartStacked(chartDays):'<div class="empty">No sales in this period.</div>'}
  </div>

  <div class="panel">
    <div class="ph"><h2>Product performance</h2></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Product</th><th class="r">Litres</th><th class="r">Sales</th><th class="r">Cost</th><th class="r">Margin</th><th class="r">₹ / litre</th><th class="r">Share</th></tr></thead>
      <tbody>${S.config.products.filter(p=>agg.byProd[p.id]?.qty).map(p=>{const b=agg.byProd[p.id];return `<tr>
        <td><span class="chip"><i class="dot" style="background:${pcol(p.id)}"></i>${esc(p.name)}</span></td>
        <td class="r num">${nf(b.qty,0)}</td><td class="r num">${money(b.amount)}</td><td class="r num">${money(b.cost)}</td>
        <td class="r num ${b.amount-b.cost>=0?'pos':'neg'}">${money(b.amount-b.cost)}</td>
        <td class="r num">${money2((b.amount-b.cost)/Math.max(1,b.qty))}</td>
        <td class="r num" style="color:var(--ink-3)">${agg.qty?Math.round(b.qty/agg.qty*100):0}%</td></tr>`;}).join('')
        ||'<tr><td colspan="7" class="empty">No sales in this period.</td></tr>'}
      </tbody></table></div></div>
  </div>`;
}

/* ---------------- setup ---------------- */
function vSetupFirst(){
  return `<div class="panel" style="max-width:520px;margin:26px auto"><div class="empty">
    No bunk selected. <button class="btn sm" data-act="switchbunk">Choose a bunk</button></div></div>`;
}
function vSetup(){
  const c=S.config;
  return `
  <div class="panel">
    <div class="ph"><h2>Bunk details</h2></div>
    <div class="pb"><div class="fr" style="max-width:760px">
      <label class="f"><span>Bunk name</span><input type="text" id="cf_station" value="${esc(c.station||'')}"></label>
      <label class="f"><span>Oil company</span><input type="text" id="cf_brand" value="${esc(c.brand||'')}"></label>
      <label class="f"><span>Location</span><input type="text" id="cf_place" value="${esc(c.place||'')}"></label>
      <label class="f"><span>Shifts (comma separated)</span><input type="text" id="cf_shifts" value="${esc((c.shifts||[]).join(', '))}"></label>
      <label class="f"><span>Expense heads</span><input type="text" id="cf_heads" value="${esc((c.heads||[]).join(', '))}"></label>
      <button class="btn" data-act="savecfg">Save details</button>
    </div></div>
  </div>

  <div class="panel">
    <div class="ph"><h2>Products &amp; rates</h2><span class="hint">selling rate applies to new days; use “Revise rates” for a mid-day change</span></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Name</th><th>Short</th><th class="r">Selling ₹/L</th><th class="r">Purchase ₹/L</th><th class="r">Margin</th><th></th></tr></thead>
      <tbody>${c.products.filter(p=>!p.archived).map(p=>`<tr data-pid="${esc(p.id)}">
        <td><span class="chip"><i class="dot" style="background:${pcol(p.id)}"></i></span> <input type="text" data-pf="name" value="${esc(p.name)}" style="width:150px;display:inline-block"></td>
        <td><input type="text" data-pf="short" value="${esc(p.short)}" style="width:72px"></td>
        <td class="r"><input type="number" step="0.01" data-pf="sell" value="${p.sell}" style="text-align:right"></td>
        <td class="r"><input type="number" step="0.01" data-pf="buy" value="${p.buy}" style="text-align:right"></td>
        <td class="r num ${p.sell-p.buy>=0?'pos':'neg'}">${money2(p.sell-p.buy)}</td>
        <td class="r">${c.products.length>1?`<button class="x" data-act="delprod" data-id="${esc(p.id)}">✕</button>`:''}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="pb" style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" data-act="saveprods">Save products</button>
        <button class="btn ghost" data-act="addprod">Add product</button></div>
    </div>
  </div>

  <div class="panel">
    <div class="ph"><h2>Tanks</h2></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Name</th><th>Product</th><th class="r">Capacity (L)</th><th class="r">Book stock (L)</th><th class="r">Reorder at</th><th></th></tr></thead>
      <tbody>${S.tanks.map(t=>`<tr data-tid="${esc(t.id)}">
        <td><input type="text" data-tf="name" value="${esc(t.name)}" style="width:130px"></td>
        <td><select data-tf="product">${c.products.filter(p=>!p.archived).map(p=>`<option value="${esc(p.id)}"${p.id===t.product?' selected':''}>${esc(p.short)}</option>`).join('')}</select></td>
        <td class="r"><input type="number" data-tf="capacity" value="${t.capacity}" style="text-align:right"></td>
        <td class="r num" title="Book stock is maintained by the database. Correct it with a dip reading under Stock.">${nf(t.stock,2)}</td>
        <td class="r"><input type="number" data-tf="min" value="${t.min||0}" style="text-align:right"></td>
        <td class="r"><button class="x" data-act="deltank" data-id="${esc(t.id)}">✕</button></td></tr>`).join('')
        ||'<tr><td colspan="6" class="empty">No tanks yet.</td></tr>'}
      </tbody></table></div>
      <div class="pb" style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" data-act="savetanks">Save tanks</button>
        <button class="btn ghost" data-act="addtank">Add tank</button></div>
      <div class="pb" style="padding-top:0"><div class="setupnote" style="margin:0">Book stock is shown, not edited.
        The database owns it — sales reduce it, decantation raises it — so two people entering shifts at once
        cannot corrupt it. To correct it, record a dip under <b>Stock</b>; that sets the figure and leaves a trail.</div></div>
    </div>
  </div>

  <div class="panel">
    <div class="ph"><h2>Nozzles</h2><span class="hint">one row per gun on the forecourt</span></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Label</th><th>Product</th><th>Draws from</th><th></th></tr></thead>
      <tbody>${c.nozzles.filter(n=>!n.archived).map(n=>`<tr data-nid="${esc(n.id)}">
        <td><input type="text" data-nf="name" value="${esc(n.name)}" style="width:150px"></td>
        <td><select data-nf="product">${c.products.filter(p=>!p.archived).map(p=>`<option value="${esc(p.id)}"${p.id===n.product?' selected':''}>${esc(p.short)}</option>`).join('')}</select></td>
        <td><select data-nf="tank">${S.tanks.map(t=>`<option value="${esc(t.id)}"${t.id===n.tank?' selected':''}>${esc(t.name)}</option>`).join('')}</select></td>
        <td class="r"><button class="x" data-act="delnoz" data-id="${esc(n.id)}">✕</button></td></tr>`).join('')
        ||'<tr><td colspan="4" class="empty">No nozzles yet.</td></tr>'}
      </tbody></table></div>
      <div class="pb" style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" data-act="savenoz">Save nozzles</button>
        <button class="btn ghost" data-act="addnoz">Add nozzle</button></div>
    </div>
  </div>

  ${repo.canConfigure()?`<div class="panel">
    <div class="ph"><h2>Team</h2><span class="hint">who can open this bunk</span></div>
    <div class="pb">
      <div class="fr" style="max-width:640px">
        <label class="f"><span>Their BunkSoft email</span><input type="email" id="mb_email" placeholder="name@example.com"
          inputmode="email" autocapitalize="none" spellcheck="false"></label>
        <label class="f"><span>Role</span><select id="mb_role">
          <option value="operator">Operator — runs shifts, stock, credit</option>
          <option value="manager">Manager — also edits rates and setup</option>
          <option value="owner">Owner — full control</option>
        </select></label>
        <button class="btn" data-act="addmember">Give access</button>
      </div>
      <div class="setupnote">Staff cannot sign themselves up. Ask your BunkSoft administrator to create
        the login, then give it access here. Removing someone here takes away their access to this bunk
        but leaves their login alone.</div>
      <div class="tw" style="margin-top:12px"><table>
        <thead><tr><th>Name</th><th>Role</th><th>Since</th><th></th></tr></thead>
        <tbody>${(S.members||[]).map(m=>`<tr><td>${esc(m.name)}</td>
          <td><span class="pill ${m.role==='owner'?'ok':''}">${esc(m.role)}</span></td>
          <td class="num">${m.since?dmy(m.since.slice(0,10)):'—'}</td>
          <td class="r"><button class="x" data-act="delmember" data-id="${esc(m.userId)}" title="Remove access">✕</button></td></tr>`).join('')
          ||'<tr><td colspan="4" class="empty">Loading the team…</td></tr>'}
        </tbody></table></div>
    </div>
  </div>`:''}

  <div class="panel">
    <div class="ph"><h2>Data</h2></div>
    <div class="pb" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn ghost" data-act="export-day">Export day book (CSV)</button>
      <button class="btn ghost" data-act="export-credit">Export credit ledger (CSV)</button>
      <button class="btn ghost" data-act="pdf-day">Day report (PDF)</button>
      ${repo.canConfigure()?`<button class="btn ghost" data-act="seeddemo">Load 14 days of sample data</button>
      <span class="setupnote" id="seedProg" style="margin:0"></span>`:''}
    </div>
    <div class="pb" style="padding-top:0"><div class="setupnote" style="margin:0">
      Entries are stored in your Supabase database and shared live with everyone you give access to.
      Sample data is for testing — load it into a test bunk, never a live one.
    </div></div>
  </div>`;
}

/* ============================ live calculation ============================ */
function wireLive(){
  const tbl=$('#nozTable'); if(!tbl)return;
  const warn=$('#nozWarn'); if(warn&&!warn.dataset.orig)warn.dataset.orig=warn.innerHTML;
  const recalc=()=>{
    const day=getDay(S.date);
    const rates=ratesOf(day,day.shifts[S.shift]);
    let tq=0,ta=0; const bad=[];
    $$('#nozTable tbody tr[data-noz]').forEach(tr=>{
      const nz=nozzle(tr.dataset.noz); if(!nz)return;
      const g=f=>num($(`input[data-fld="${f}"]`,tr)?.value);
      const moved=g('close')+g('roll')-g('open');
      const q=Math.max(0,moved-g('test')), rate=rates[nz.product]?.sell||0;
      $('[data-out="qty"]',tr).textContent=nf(q,2);
      $('[data-out="amt"]',tr).textContent=money(q*rate);
      /* Flag the two readings that cannot be true, rather than silently
         flooring the litres at zero and losing the sale. */
      if(moved<0)bad.push(nz.name+': closing is below opening');
      else if(g('test')>moved)bad.push(nz.name+': test litres exceed what passed the meter');
      tq+=q; ta+=q*rate;
    });
    $('#tQty').textContent=nf(tq,2); $('#tAmt').textContent=money(ta);
    const w=$('#nozWarn');
    if(w){
      if(bad.length){ w.style.color='#c0392b'; w.innerHTML='<b>Check these readings:</b> '+bad.map(esc).join('; ')+'.'; }
      else if(w.dataset.orig){ w.style.color=''; w.innerHTML=w.dataset.orig; }
    }
    const sh=day.shifts[S.shift]||blankShift();
    const credit=(sh.credit||[]).reduce((a,b)=>a+num(b.amount),0);
    const other=num($('#f_other')?.value), due=ta+other;
    const recv=num($('#f_cash')?.value)+num($('#f_card')?.value)+num($('#f_upi')?.value)+num($('#f_bank')?.value)+credit;
    const diff=recv-due;
    $('#mDue').textContent=money(due); $('#mRecv').textContent=money(recv); $('#mCredit').textContent=money(credit);
    const el=$('#mDiff'); el.textContent=(diff>=0?'+':'−')+'₹'+nf(Math.abs(diff),2);
    el.style.color=Math.abs(diff)<1?'var(--display-ink)':(diff<0?'#FF7A7A':'#7BE0A8');
  };
  ['input','change'].forEach(ev=>{
    tbl.addEventListener(ev,recalc);
    ['f_cash','f_card','f_upi','f_bank','f_other'].forEach(id=>$('#'+id)?.addEventListener(ev,recalc));
  });
  const q=$('#cr_qty'), a=$('#cr_amt'), p=$('#cr_prod');
  const sync=()=>{if(!q||!p)return;const r=getDay(S.date).rates[p.value]?.sell||0; if(num(q.value))a.value=(num(q.value)*r).toFixed(2);};
  q?.addEventListener('input',sync); p?.addEventListener('change',sync);
}

/* ============================ chart hover ============================ */
let tipEl=null;
document.addEventListener('mousemove',e=>{
  const hit=e.target.closest?.('#trend .hit');
  if(!hit){if(tipEl){tipEl.remove();tipEl=null;}return;}
  /* __chart is written when a chart renders; a stale hit area after a tab
     switch would otherwise dereference nothing. */
  const c=window.__chart, i=+hit.dataset.i, row=c?.data?.[i];
  if(!row){if(tipEl){tipEl.remove();tipEl=null;}return;}
  if(!tipEl){tipEl=document.createElement('div');tipEl.className='tip';$('#layer').appendChild(tipEl);}
  const tot=row.vals.reduce((a,b)=>a+b,0);
  tipEl.innerHTML=`<div class="tt">${dmy(row.date)}</div>`+
    c.prods.map((p,k)=>row.vals[k]>0?`<div class="tr"><span><i class="dot" style="display:inline-block;background:${CC[k%5]}"></i> ${esc(p)}</span><span>${c.mode==='value'?money(row.vals[k]):nf(row.vals[k],0)+' L'}</span></div>`:'').join('')+
    `<div class="tr" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>Total</span><span>${c.mode==='value'?money(tot):nf(tot,0)+' L'}</span></div>`;
  tipEl.style.left=Math.min(window.innerWidth-190,e.clientX+14)+'px';
  tipEl.style.top=Math.max(8,e.clientY-70)+'px';
});

/* ============================ actions ============================ */
document.addEventListener('change',e=>{
  if(e.target.id==='curDate'&&e.target.value){ S.date=e.target.value; mutate(async()=>{},''); }
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&S.modal){S.modal=null;render();} });
document.addEventListener('click',async e=>{
  if(e.target.classList?.contains('scrim')){ S.modal=null; render(); return; }   // click outside the dialog
  const tabBtn=e.target.closest('[data-tab]');
  if(tabBtn){S.tab=tabBtn.dataset.tab;S.modal=null;render();window.scrollTo({top:0});return;}
  const b=e.target.closest('[data-act]'); if(!b)return;
  const act=b.dataset.act, day=S.config?getDay(S.date):null;
  const goDate=d=>{ S.date=d; mutate(async()=>{},''); };

  const A={
    /* ---- navigation ---- */
    'day-prev':()=>goDate(shiftDate(S.date,-1)),
    'day-next':()=>goDate(shiftDate(S.date,1)),
    'today':()=>goDate(today()),
    'theme':()=>{const r=document.documentElement;const cur=r.getAttribute('data-theme');
      const dark=cur?cur==='dark':matchMedia('(prefers-color-scheme:dark)').matches;
      r.setAttribute('data-theme',dark?'light':'dark');
      try{localStorage.setItem('bunksoft.theme',dark?'light':'dark');}catch(_){}
      render();},
    'chartmode':()=>{S.chartMode=S.chartMode==='value'?'qty':'value';render();},
    'goshift':()=>{S.shift=b.dataset.shift;S.tab='shift';render();window.scrollTo({top:0});},
    'setshift':()=>{S.shift=b.dataset.shift;render();},
    'closemodal':()=>{S.modal=null;render();},
    'signout':()=>{ window.dispatchEvent(new CustomEvent('bunksoft:signout')); },
    'switchbunk':()=>{ window.dispatchEvent(new CustomEvent('bunksoft:switchbunk')); },

    /* ---- shift ---- */
    'saveshift':()=>saveShift(b.dataset.close==='1'),
    'clearshift':()=>{
      const cs=getDay(S.date).shifts[S.shift];
      if(cs&&cs.closed&&!repo.canConfigure())return toast('A closed shift can only be cleared by the owner or a manager.');
      if(!confirm('Clear all entries for the '+S.shift+' shift on '+dmy(S.date)+'?'+
        (cs&&cs.closed?'\n\nThis shift is closed. Clearing it removes its readings and moves the tank stock back.':'')))return;
      return mutate(()=>repo.deleteShift(S.date,S.shift),'Shift cleared.');
    },
    'shiftreport':()=>openShiftReport(S.date,b.dataset.shift),

    /* ---- credit ---- */
    'addcredit':()=>addCredit(),
    'delcredit':()=>mutate(()=>repo.deleteTxn(b.dataset.id),'Slip removed.'),
    'newcust':()=>openCust(),
    'ledger':()=>openLedger(b.dataset.id),
    'pay':()=>openPay(b.dataset.id),
    'savecust':()=>saveCustForm(),
    'savepay':()=>savePayForm(),
    'delpay':()=>mutate(()=>repo.deleteTxn(b.dataset.id),'Receipt removed.'),

    /* ---- stock ---- */
    'addreceipt':()=>addReceipt(),
    'delreceipt':()=>mutate(()=>repo.deleteReceipt(b.dataset.id),'Receipt removed.'),
    'adddip':()=>addDip(),
    'deldip':()=>mutate(()=>repo.deleteDip(b.dataset.id),'Dip removed.'),

    /* ---- expenses & cash ---- */
    'addexpense':()=>{
      const amt=num($('#ex_amt').value);
      /* A negative expense is a credit entered in the wrong place; it used to
         be accepted and quietly raised the day's profit. */
      if(amt<=0)return toast('Enter an amount greater than zero.');
      return mutate(()=>repo.addExpense(S.date,{head:$('#ex_head').value,mode:$('#ex_mode').value,
        amount:amt,note:$('#ex_note').value.trim()}),'Expense added.');
    },
    'delexpense':()=>mutate(()=>repo.deleteExpense(b.dataset.id),'Expense removed.'),
    'savecash':()=>mutate(()=>repo.saveDayCash(S.date,num($('#cb_open').value),
      $('#cb_count').value===''?null:num($('#cb_count').value)),'Cash book updated.'),
    'carrycash':()=>{
      const prev=Object.keys(S.days).filter(k=>k<S.date).sort().pop();
      if(!prev)return toast('No earlier day on record.');
      const v=closingCashOf(prev);
      $('#cb_open').value=v;
      toast('Carried '+money(v)+' from '+dmy(prev)+'. Press Save to confirm.');
    },
    'adddeposit':()=>{
      const amt=num($('#dp_amt').value);
      if(amt<=0)return toast('Enter an amount greater than zero.');
      /* You cannot bank cash that is not in the drawer. Allowed on a
         confirmation, because the drawer may hold cash carried over that was
         never entered as an opening balance. */
      const cb=cashBook(S.date);
      if(amt>cb.closing+0.5&&
         !confirm('The cash book shows only '+money(cb.closing)+' in hand today.\n\n'+
                  'Banking '+money(amt)+' will leave the drawer '+money(amt-cb.closing)+
                  ' short.\n\nRecord it anyway?')) return;
      return mutate(()=>repo.addDeposit(S.date,{amount:amt,bank:$('#dp_bank').value.trim(),
        ref:$('#dp_ref').value.trim()}),'Deposit recorded.');
    },
    'deldeposit':()=>mutate(()=>repo.deleteDeposit(b.dataset.id),'Deposit removed.'),

    /* ---- reports ---- */
    'range':()=>setRange(b.dataset.r),
    'loadperiod':()=>{const {from,to}=reportRange();return loadRange(from,to);},
    'applyrange':()=>{const f=$('#rg_from').value,t=$('#rg_to').value;
      if(f&&t){S.range={from:f,to:t};loadRange(f,t);render();}},
    'copy-shift':()=>copyText(shiftText(S.report.date,S.report.shift)),
    'pdf-shift':()=>pdfShift(S.report.date,S.report.shift),
    'pdf-day':()=>pdfDay(S.report?S.report.date:S.date),
    'export-pl':()=>exportPL(),
    'export-day':()=>exportDayBook(),
    'export-credit':()=>exportCredit(),

    /* ---- rates ---- */
    'rates':()=>openRates(),
    'saverates':()=>{
      const rates={};
      activeProducts().forEach(p=>{rates[p.id]={sell:num($('#rt_s_'+cssId(p.id)).value),
        buy:num($('#rt_b_'+cssId(p.id)).value)};});
      S.modal=null;
      return mutate(()=>repo.saveRates(S.date,rates),'Rates revised for '+dmy(S.date)+'.');
    },

    /* ---- settings (owner / manager) ---- */
    'savecfg':()=>{
      const c={station:$('#cf_station').value.trim(),brand:$('#cf_brand').value.trim(),
        place:$('#cf_place').value.trim(),
        shifts:$('#cf_shifts').value.split(',').map(s=>s.trim()).filter(Boolean),
        heads:$('#cf_heads').value.split(',').map(s=>s.trim()).filter(Boolean)};
      if(!c.shifts.length)c.shifts=['Day'];
      return mutate(async()=>{ await repo.saveBunkSettings(c); await refreshConfig(); },'Saved.');
    },
    'saveprods':()=>mutate(async()=>{
      for(const tr of $$('#view tr[data-pid]')){
        const p=prod(tr.dataset.pid); if(!p)continue;
        const upd={...p};
        $$('[data-pf]',tr).forEach(i=>{const f=i.dataset.pf;
          upd[f]=(f==='sell'||f==='buy')?num(i.value):i.value.trim();});
        await repo.saveProduct(upd);
      }
      await refreshConfig();
    },'Products saved.'),
    'addprod':()=>mutate(async()=>{
      await repo.saveProduct({name:'New product',short:'NEW',sell:0,buy:0,
        sort:(activeProducts().length||0)+1});
      await refreshConfig();
    },'Product added.'),
    'delprod':()=>mutate(async()=>{ await repo.archiveProduct(b.dataset.id); await refreshConfig(); },'Product removed.'),
    'savetanks':()=>mutate(async()=>{
      for(const tr of $$('#view tr[data-tid]')){
        const t=tank(tr.dataset.tid); if(!t)continue;
        const upd={...t};
        $$('[data-tf]',tr).forEach(i=>{const f=i.dataset.tf;
          upd[f]=['capacity','stock','min'].includes(f)?num(i.value):i.value.trim();});
        await repo.saveTank(upd);
      }
      await refreshConfig();
    },'Tanks saved.'),
    'addtank':()=>mutate(async()=>{
      await repo.saveTank({name:'Tank '+(S.tanks.length+1),product:activeProducts()[0]?.id,
        capacity:10000,min:1500,sort:S.tanks.length+1});
      await refreshConfig();
    },'Tank added.'),
    'deltank':()=>mutate(async()=>{ await repo.archiveTank(b.dataset.id); await refreshConfig(); },'Tank removed.'),
    'savenoz':()=>mutate(async()=>{
      for(const tr of $$('#view tr[data-nid]')){
        const n=nozzle(tr.dataset.nid); if(!n)continue;
        const upd={...n};
        $$('[data-nf]',tr).forEach(i=>upd[i.dataset.nf]=i.value.trim());
        await repo.saveNozzle(upd);
      }
      await refreshConfig();
    },'Nozzles saved.'),
    'addnoz':()=>mutate(async()=>{
      await repo.saveNozzle({name:'DU-? / N'+(activeNozzles().length+1),
        product:activeProducts()[0]?.id,tank:S.tanks[0]?.id,sort:activeNozzles().length+1});
      await refreshConfig();
    },'Nozzle added.'),
    'delnoz':()=>mutate(async()=>{ await repo.archiveNozzle(b.dataset.id); await refreshConfig(); },'Nozzle removed.'),

    /* ---- team ---- */
    'addmember':()=>{
      const em=$('#mb_email').value.trim(), role=$('#mb_role').value;
      if(!em)return toast('Enter their BunkSoft email.');
      return mutate(async()=>{ await repo.addMember(em,role); S.members=await repo.members(); },'Access granted to '+em+'.');
    },
    'delmember':()=>mutate(async()=>{ await repo.removeMember(b.dataset.id); S.members=await repo.members(); },'Access removed.'),

    /* ---- demo data ---- */
    'seeddemo':()=>{
      if(!confirm('Load 14 days of sample figures into this bunk? Use a test bunk, not a live one.'))return;
      return mutate(async()=>{
        await seedDemoData((n,t)=>{ const el=$('#seedProg'); if(el)el.textContent='Day '+n+' of '+t+'…'; });
        await refreshConfig();
        await loadRange(shiftDate(today(),-45),today());
      },'Sample data loaded.');
    }
  };
  if(A[act]){ e.preventDefault(); await A[act](); }
});

/* ids from Postgres are uuids with dashes — fine in CSS selectors only if escaped */
const cssId=s=>String(s).replace(/[^a-zA-Z0-9_-]/g,'_');

function setRange(r){
  const t=S.date;
  if(r==='mtd')S.range={from:monthStart(t),to:t};
  else if(r==='30')S.range={from:shiftDate(t,-29),to:t};
  else if(r==='last'){const d=new Date(t+'T12:00:00');d.setDate(1);d.setDate(0);const to=iso(d);S.range={from:monthStart(to),to};}
  else if(r==='fy'){const y=+t.slice(0,4),m=+t.slice(5,7);const fy=m>=4?y:y-1;S.range={from:fy+'-04-01',to:t};}
  loadRange(S.range.from,S.range.to); render();
}

/* ---- shift save ----
   Nothing is written until every reading can be true. A closing below its
   opening is either a typo or a totalizer that wrapped past all nines; the
   operator says which, and a wrap is recorded as litres rather than being
   floored away. */
function readMeterRows(){
  const rows=[];
  $$('#nozTable tbody tr[data-noz]').forEach(tr=>{
    const g=f=>num($(`input[data-fld="${f}"]`,tr)?.value);
    rows.push({tr,id:tr.dataset.noz,noz:nozzle(tr.dataset.noz),
      open:g('open'),close:g('close'),test:g('test'),roll:g('roll')});
  });
  return rows;
}
/* 10^digits for the meter: an eight-digit head wrapping at 99,999,999 gives
   back 100,000,000 litres. Taken from the width of the opening reading. */
const wrapSpan=open=>Math.pow(10,Math.max(4,String(Math.floor(Math.abs(open))).length));

function checkMeters(rows){
  for(const r of rows){
    const name=r.noz?r.noz.name:'This nozzle';
    if(r.open<0||r.close<0)return name+': a meter reading cannot be negative.';
    if(r.test<0)return name+': test litres cannot be negative.';
    let moved=r.close+r.roll-r.open;
    if(moved<0){
      const span=wrapSpan(r.open);
      if(r.close+span-r.open>=0&&confirm(name+': the closing reading ('+nf(r.close,2)+
         ') is below the opening ('+nf(r.open,2)+').\n\nDid the totalizer roll over past all nines?\n\n'+
         'OK records a rollover of '+nf(span,0)+' L, giving '+nf(r.close+span-r.open-r.test,2)+
         ' L sold.\nCancel lets you correct the reading.')){
        r.roll=span;
        const el=$('input[data-fld="roll"]',r.tr); if(el)el.value=String(span);
        moved=r.close+r.roll-r.open;
      } else {
        return name+': the closing reading is below the opening. Correct it, or confirm a rollover.';
      }
    }
    if(r.test>moved)return name+': test litres ('+nf(r.test,2)+') exceed the '+nf(moved,2)+
      ' litres that passed this meter.';
  }
  return null;
}

function saveShift(close){
  const day=getDay(S.date), nm=S.shift;
  const sh=day.shifts[nm]||blankShift();
  const wasClosed=!!sh.closed;
  const rows=readMeterRows();
  const bad=checkMeters(rows);
  if(bad){ toast(bad); return; }

  const closing=close?true:$('#f_closed').value==='1';
  /* A shift cannot be closed against a rate card that is not set: the sale
     would be valued at zero and the handover would show the whole take as
     short. The margin needs the purchase rate too, but that is a warning. */
  if(closing){
    const sold={}; rows.forEach(r=>{const q=Math.max(0,r.close+r.roll-r.open-r.test);
      if(q>0&&r.noz)sold[r.noz.product]=(sold[r.noz.product]||0)+q;});
    const rates=day.rates||{};
    const noSell=Object.keys(sold).filter(pid=>!num(rates[pid]?.sell));
    if(noSell.length){
      toast('Set today\'s selling rate for '+noSell.map(pid=>prod(pid).short).join(', ')+
            ' before closing this shift.');
      return;
    }
    const noBuy=Object.keys(sold).filter(pid=>!num(rates[pid]?.buy));
    if(noBuy.length&&!confirm('No purchase rate is set for '+noBuy.map(pid=>prod(pid).short).join(', ')+
        '.\n\nThe shift will close correctly, but the margin cannot be worked out until you enter it under Revise rates.\n\nClose the shift anyway?')) return;
  }

  sh.operator=$('#f_operator').value.trim();
  sh.closed=closing;
  /* Stamp the close time once. The database keeps closed_at, and db.js falls
     back to now() whenever closedAtISO is absent — so without carrying the
     original forward, every later edit to a closed shift would quietly move
     its closing time to the moment of the edit. */
  if(!sh.closed) sh.closedAtISO=null;
  else if(!sh.closedAtISO) sh.closedAtISO=new Date().toISOString();
  sh.cash=num($('#f_cash').value); sh.card=num($('#f_card').value);
  sh.upi=num($('#f_upi').value);   sh.bank=num($('#f_bank').value);
  sh.other={amount:num($('#f_other').value),cost:num($('#f_othercost').value),note:sh.other?.note||''};
  sh.readings=sh.readings||{};
  rows.forEach(r=>{ sh.readings[r.id]={open:r.open,close:r.close,test:r.test,rollover:r.roll}; });
  /* Freeze the rate card onto the shift as it closes, so a later revision
     does not restate a handover that has already been signed. */
  if(sh.closed&&!sh.ratesAtClose)sh.ratesAtClose=clone(day.rates||currentRates());
  if(!sh.closed)sh.ratesAtClose=null;
  day.shifts[nm]=sh;
  /* The database recalculates tank stock from the readings we send. */
  return mutate(async()=>{
    await repo.ensureDay(S.date,day.rates&&Object.keys(day.rates).length?day.rates:currentRates());
    /* nozzlesFor, not the active list: a retired nozzle this shift still has
       a reading for must keep being written, or its litres vanish. */
    await repo.saveShift(S.date,nm,sh,nozzlesFor(sh),day.rates||currentRates());
  }).then(ok=>{
    if(!ok)return;
    if(sh.closed&&(close||!wasClosed)){ openShiftReport(S.date,nm); toast(nm+' shift closed.'); }
    else toast('Shift saved.');
  });
}

function addCredit(){
  const day=getDay(S.date), nm=S.shift;
  const cid=$('#cr_cust').value, pid=$('#cr_prod').value, qty=num($('#cr_qty').value);
  let amt=num($('#cr_amt').value); if(!amt&&qty)amt=qty*(day.rates[pid]?.sell||0);
  if(qty<0)return toast('Litres cannot be negative.');
  if(amt<=0)return toast('Enter litres or an amount.');
  const c=cust(cid); if(!c)return toast('Pick a customer.');
  /* A credit limit that is never enforced is a limit in name only. The owner
     can still allow it — the point is that it is a decision, not an accident. */
  const limit=num(c.limit);
  if(limit&&num(c.balance)+amt>limit&&
     !confirm(c.name+' has a credit limit of '+money(limit)+' and owes '+money(c.balance)+'.\n\n'+
              'This slip takes the outstanding to '+money(num(c.balance)+amt)+
              ', which is '+money(num(c.balance)+amt-limit)+' over the limit.\n\nIssue it anyway?')) return;
  const sh=day.shifts[nm];
  return mutate(async()=>{
    let shiftId=sh&&sh.id;
    if(!shiftId){   /* a slip before the shift is saved still needs a shift row */
      await repo.ensureDay(S.date,currentRates());
      shiftId=await repo.saveShift(S.date,nm,sh||blankShift(),activeNozzles(),day.rates||currentRates());
    }
    await repo.addCreditSlip(S.date,shiftId,{cust:cid,product:pid,qty,amount:amt,
      vehicle:c.vehicle||'',slip:$('#cr_slip').value.trim()});
  },'Credit slip added to '+c.name+'.');
}

function addReceipt(){
  const tid=$('#rc_tank').value, qty=num($('#rc_qty').value), rate=num($('#rc_rate').value);
  if(qty<=0)return toast('Enter the quantity decanted.');
  if(rate<0)return toast('The purchase rate cannot be negative.');
  const t=tank(tid); if(!t)return toast('Pick a tank.');
  /* A decantation larger than the tank can hold is a typo — 80000 for 8000. */
  const room=num(t.capacity)-num(t.stock);
  if(num(t.capacity)&&qty>room&&
     !confirm(t.name+' holds '+nf(t.capacity,0)+' L and already has '+nf(t.stock,0)+' L in it, '+
              'so only '+nf(Math.max(0,room),0)+' L will fit.\n\nRecord '+nf(qty,0)+' L anyway?')) return;
  return mutate(()=>repo.addReceipt(S.date,{tank:tid,product:t.product,qty,rate,
    invoice:$('#rc_inv').value.trim(),truck:$('#rc_truck').value.trim()}),
    nf(qty,0)+' L decanted into '+t.name+'.');
}
/* The dip SETS the tank, so the book figure it is compared against must be the
   one in the database at that instant, not the one this browser last saw. The
   repository asks the server to read it inside the same statement. */
function addDip(){
  const tid=$('#dp_tank').value;
  if($('#dp_qty').value==='')return toast('Enter the dip quantity.');
  const dip=num($('#dp_qty').value), t=tank(tid); if(!t)return toast('Pick a tank.');
  if(dip<0)return toast('A dip cannot be negative.');
  let res=null;
  return mutate(async()=>{ res=await repo.addDip(S.date,{tank:tid,dip}); })
    .then(ok=>{
      if(!ok)return;
      const v=res&&res.variation!=null?Number(res.variation):dip-num(t.stock);
      toast(Math.abs(v)<0.5?'Dip matches the book figure.'
        :(v>0?'Gain of '+nf(v,0)+' L recorded.':'Loss of '+nf(Math.abs(v),0)+' L recorded.'));
    });
}

/* ---- modals ---- */
/* The scrim closes on a click on ITSELF (handled in the click dispatcher).
   Never stop propagation inside the modal — the buttons rely on the
   document-level dispatcher, and swallowing the event makes them all dead. */
const wrapModal=(title,body,footer)=>()=>`<div class="scrim"><div class="modal" role="dialog" aria-modal="true">
  <div class="ph"><h2>${title}</h2><span class="spacer"></span><button class="x" data-act="closemodal">✕</button></div>
  <div class="pb">${body}</div>${footer?`<div class="pb" style="border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end">${footer}</div>`:''}</div></div>`;
function openRates(){
  const day=getDay(S.date);
  S.modal=wrapModal('Revise rates · '+dmy(S.date),
    `<div class="setupnote" style="margin:0 0 12px">Oil companies revise the retail price at 6 a.m. Changing it here applies to this date only; Setup holds the standing rate for new days.</div>`+
    activeProducts().map(p=>`<div class="fr" style="margin-bottom:10px">
      <label class="f"><span>${esc(p.name)} — selling ₹/L</span><input type="number" step="0.01" id="rt_s_${cssId(p.id)}" value="${day.rates[p.id]?.sell||0}"></label>
      <label class="f"><span>Purchase ₹/L</span><input type="number" step="0.01" id="rt_b_${cssId(p.id)}" value="${day.rates[p.id]?.buy||0}"></label>
    </div>`).join(''),
    `<button class="btn ghost" data-act="closemodal">Cancel</button><button class="btn" data-act="saverates">Save rates</button>`);
  render();
}
function openCust(){
  S.modal=wrapModal('New credit account',
    `<div class="fr">
      <label class="f"><span>Name</span><input type="text" id="cu_name" placeholder="Firm or person"></label>
      <label class="f"><span>Phone</span><input type="tel" id="cu_phone" placeholder="98xxx xxxxx"></label>
      <label class="f"><span>Vehicle no.</span><input type="text" id="cu_veh" placeholder="TN 37 …"></label>
      <label class="f"><span>Credit limit ₹</span><input type="number" id="cu_limit" placeholder="0"></label>
      <label class="f"><span>Opening balance ₹</span><input type="number" id="cu_open" placeholder="0"></label>
    </div>`,
    `<button class="btn ghost" data-act="closemodal">Cancel</button><button class="btn" data-act="savecust">Add account</button>`);
  render();
}
function saveCustForm(){
  const name=$('#cu_name').value.trim(); if(!name)return toast('Enter a name.');
  const c={name,phone:$('#cu_phone').value.trim(),vehicle:$('#cu_veh').value.trim(),
    limit:num($('#cu_limit').value),opening:num($('#cu_open').value)};
  S.modal=null;
  return mutate(()=>repo.addCustomer(c),name+' added.');
}
function openPay(id){
  const c=cust(id); if(!c)return;
  S.modal=wrapModal('Receive from '+esc(c.name),
    `<div class="setupnote" style="margin:0 0 12px">Outstanding today: <b class="num">${money(c.balance)}</b></div>
     <div class="fr">
      <label class="f"><span>Amount ₹</span><input type="number" step="0.01" id="pm_amt" data-cust="${esc(id)}" placeholder="0"></label>
      <label class="f"><span>Mode</span><select id="pm_mode">${PAYMODES.map(m=>`<option>${esc(m)}</option>`).join('')}</select></label>
      <label class="f"><span>Note</span><input type="text" id="pm_note" placeholder="ref no."></label>
     </div>`,
    `<button class="btn ghost" data-act="closemodal">Cancel</button><button class="btn" data-act="savepay">Record receipt</button>`);
  render();
}
function savePayForm(){
  const el=$('#pm_amt'), amt=num(el.value), c=cust(el.dataset.cust);
  if(!c)return toast('Pick a customer.');
  if(amt<=0)return toast('Enter an amount greater than zero.');
  /* Paying more than is owed leaves the account in credit. Legitimate as an
     advance, but worth a glance — it is usually a mistyped figure. */
  if(amt>num(c.balance)+0.5&&
     !confirm(c.name+' owes '+money(c.balance)+'.\n\nReceiving '+money(amt)+' leaves '+
              money(amt-num(c.balance))+' as an advance.\n\nRecord it anyway?')) return;
  const row={cust:c.id,amount:amt,mode:$('#pm_mode').value,note:$('#pm_note').value.trim()};
  S.modal=null;
  return mutate(()=>repo.addPayment(S.date,row),money(amt)+' received from '+c.name+'.');
}
function openLedger(id){
  const c=cust(id); if(!c)return;
  const rows=(c.txns||[]).slice(0,60);
  S.modal=wrapModal(esc(c.name)+' · ledger',
    `<div class="stats" style="margin:0 0 14px">
      ${stat('Outstanding',money(c.balance),c.vehicle||'—',num(c.balance)>0?'wrn':'')}
      ${stat('Limit',num(c.limit)?money(c.limit):'—',num(c.limit)&&num(c.balance)>num(c.limit)?'over limit':'within limit',num(c.limit)&&num(c.balance)>num(c.limit)?'neg':'')}
      ${stat('Phone',esc(c.phone||'—'),'')}
    </div>
    ${c.partial?`<div class="setupnote" style="margin:0 0 10px">Only the most recent transactions are shown. The outstanding figure above is the full balance from the database; the running balance in the last rows of this list starts from the oldest entry shown.</div>`:''}
    <div class="tw" style="max-height:44vh;overflow-y:auto"><table><thead><tr><th>Date</th><th>Detail</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
    <tbody>${rows.length?rows.map(t=>`<tr><td class="num">${dshort(t.date)}</td><td>${esc(t.label||t.ref||'')}</td>
      <td class="r num">${t.type!=='payment'?money(t.amount):''}</td><td class="r num">${t.type==='payment'?money(t.amount):''}</td>
      <td class="r num">${money(t.bal)}</td></tr>`).join('')
      :'<tr><td colspan="5" class="empty">No transactions yet.</td></tr>'}</tbody></table></div>`,
    `<button class="btn ghost" data-act="closemodal">Close</button><button class="btn" data-act="pay" data-id="${esc(id)}">Receive payment</button>`);
  render();
}

/* ============================ reports ============================
   A shift closing report on screen when a shift is closed, and a full
   day sheet as a PDF: readings, sales, credit, stock and expenses. */
function shiftData(date,nm){
  const day=getDay(date), t=shiftTotals(day,nm), byProd={};
  t.lines.forEach(l=>{ if(!l.qty)return;
    const b=byProd[l.noz.product]||(byProd[l.noz.product]={qty:0,amount:0,cost:0});
    /* l.buy is the frozen rate for a closed shift, the live one otherwise. */
    b.qty+=l.qty; b.amount+=l.amount; b.cost+=l.qty*l.buy; });
  return {day,t,byProd};
}
function openShiftReport(date,nm){ S.report={date,shift:nm}; S.modal=vShiftReport; render(); }

function vShiftReport(){
  const {date,shift:nm}=S.report, {day,t,byProd}=shiftData(date,nm), sh=t.sh;
  const prods=Object.keys(byProd);
  return `<div class="scrim"><div class="modal wide"><div class="rpt">
    <div class="rpthead">
      <div class="rt">${esc(S.config.station||'BunkSoft')}</div>
      <div class="rs">${esc([S.config.brand,S.config.place].filter(Boolean).join(' · '))}</div>
      <div class="rb">Shift closing report</div>
      <div class="rs" style="margin-top:8px">${dmy(date)} · ${esc(nm)} shift · Operator ${esc(sh.operator||'—')}${sh.closedAt?' · closed '+esc(sh.closedAt):''}</div>
      ${sh.closed&&sh.ratesAtClose?`<div class="rs" style="margin-top:4px;font-size:11px">Valued at the rates in force when this shift closed.</div>`:''}
    </div>

    <div class="rsec">Nozzle meter readings</div>
    <div class="tw"><table>
      <thead><tr><th>Nozzle</th><th>Product</th><th class="r">Opening</th><th class="r">Closing</th><th class="r">Test</th><th class="r">Sold L</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
      <tbody>${t.lines.filter(l=>l.qty||l.close).map(l=>`<tr>
        <td>${esc(l.noz.name)}</td><td>${esc(prod(l.noz.product).short)}</td>
        <td class="r num">${nf(l.open,2)}</td><td class="r num">${nf(l.close,2)}${l.rollover?' <span class="chip" title="Totalizer rolled over">+'+nf(l.rollover,0)+'</span>':''}</td><td class="r num">${l.test?nf(l.test,2):'—'}</td>
        <td class="r num">${nf(l.qty,2)}</td><td class="r num">${nf(l.rate,2)}</td><td class="r num">${money(l.amount)}</td></tr>`).join('')
        ||'<tr><td colspan="8" class="empty">No readings recorded.</td></tr>'}
        <tr class="totalrow"><td colspan="5">Total</td><td class="r num">${nf(t.qty,2)}</td><td></td><td class="r num">${money(t.fuel)}</td></tr>
      </tbody></table></div>

    ${prods.length?`<div class="rsec">Fuel sold</div>
    ${prods.map(p=>`<div class="rline"><span><span class="chip"><i class="dot" style="background:${pcol(p)}"></i>${esc(prod(p).name)}</span></span>
      <span>${nf(byProd[p].qty,2)} L · ${money(byProd[p].amount)}</span></div>`).join('')}`:''}
    ${t.other?`<div class="rline"><span>${esc(sh.other?.note||'Lubes / other sales')}</span><span>${money(t.other)}</span></div>`:''}
    <div class="rline big"><span>Total due</span><span>${money(t.due)}</span></div>

    <div class="rsec">Collections</div>
    <div class="rline"><span>Cash</span><span>${money(sh.cash)}</span></div>
    <div class="rline"><span>UPI</span><span>${money(sh.upi)}</span></div>
    <div class="rline"><span>Card</span><span>${money(sh.card)}</span></div>
    <div class="rline"><span>Bank transfer</span><span>${money(sh.bank)}</span></div>
    <div class="rline"><span>Credit — ${plural((sh.credit||[]).length,'slip')}</span><span>${money(t.credit)}</span></div>
    ${(sh.credit||[]).map(c=>`<div class="rslip"><span>${esc(cust(c.cust)?.name||'—')}${c.vehicle?' · '+esc(c.vehicle):''}${c.slip?' · slip '+esc(c.slip):''}</span><span>${money(c.amount)}</span></div>`).join('')}
    <div class="rline big"><span>Total received</span><span>${money(t.recv)}</span></div>
    <div class="rline big" style="background:${Math.abs(t.diff)<1?'var(--good-soft)':'var(--bad-soft)'};color:${Math.abs(t.diff)<1?'var(--good)':'var(--bad)'}">
      <span>Short / excess</span><span>${diffTxt(t.diff)}</span></div>

    <div class="rsec">Tank stock after this shift</div>
    ${S.tanks.map(tk=>`<div class="rline"><span>${esc(tk.name)} · ${esc(prod(tk.product).short)}</span><span>${nf(tk.stock,0)} L</span></div>`).join('')
      ||'<div class="rline"><span>No tanks configured.</span><span></span></div>'}

    <div class="rsign"><div>Operator signature</div><div>Manager signature</div></div>
  </div>
  <div class="pb" style="border-top:1px solid var(--line);display:flex;gap:9px;justify-content:flex-end;flex-wrap:wrap">
    <button class="btn ghost" data-act="closemodal">Close</button>
    <button class="btn ghost" data-act="copy-shift">Copy for WhatsApp</button>
    <button class="btn ghost" data-act="pdf-day">Full day PDF</button>
    <button class="btn" data-act="pdf-shift">Download PDF</button>
  </div></div></div>`;
}

function shiftText(date,nm){
  const {t,byProd}=shiftData(date,nm), sh=t.sh, L=[];
  L.push('*'+(S.config.station||'BunkSoft')+'*');
  L.push(dmy(date)+' · '+nm+' shift'+(sh.operator?' · '+sh.operator:''));
  L.push('');
  L.push('*Fuel sold*');
  Object.keys(byProd).forEach(p=>L.push(prod(p).short+'  '+nf(byProd[p].qty,2)+' L  '+money(byProd[p].amount)));
  if(t.other)L.push('Lubes / other  '+money(t.other));
  L.push('Total due  '+money(t.due));
  L.push('');
  L.push('*Collections*');
  L.push('Cash  '+money(sh.cash));
  L.push('UPI   '+money(sh.upi));
  L.push('Card  '+money(sh.card));
  if(num(sh.bank))L.push('Bank  '+money(sh.bank));
  L.push('Credit '+money(t.credit)+' ('+plural((sh.credit||[]).length,'slip')+')');
  (sh.credit||[]).forEach(c=>L.push('  - '+(cust(c.cust)?.name||'—')+(c.slip?' slip '+c.slip:'')+'  '+money(c.amount)));
  L.push('Received  '+money(t.recv));
  L.push('Short/excess  '+diffTxt(t.diff));
  L.push('');
  L.push('*Tank stock*');
  S.tanks.forEach(tk=>L.push(tk.name+' ('+prod(tk.product).short+')  '+nf(tk.stock,0)+' L'));
  return L.join('\n');
}
async function copyText(txt){
  try{ await navigator.clipboard.writeText(txt); toast('Report copied — paste it into WhatsApp.'); return; }catch(e){}
  S.modal=wrapModal('Copy the report',
    `<div class="setupnote" style="margin:0 0 10px">Select all and copy.</div>
     <textarea id="cpbox" rows="16" style="font-family:var(--fm);font-size:12px;line-height:1.5">${esc(txt)}</textarea>`,
    `<button class="btn" data-act="closemodal">Done</button>`);
  render(); const b=$('#cpbox'); b?.focus(); b?.select();
}

/* ---- PDF ---- */
let PDFLIB=null;
const CDN=['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
           'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'];
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=()=>res();s.onerror=()=>rej(new Error('could not load'));document.head.appendChild(s);});}
async function pdfReady(){
  if(PDFLIB)return PDFLIB;
  if(!window.jspdf) await loadScript(CDN[0]);
  if(!window.jspdf?.jsPDF?.API?.autoTable) await loadScript(CDN[1]);
  if(!window.jspdf?.jsPDF) throw new Error('no library');
  PDFLIB=window.jspdf; return PDFLIB;
}
/* The PDF's built-in fonts have no rupee glyph, so money is written "Rs." there. */
const R=n=>'Rs. '+nf(Math.round(Number(n)||0));
const R2=n=>'Rs. '+nf(Number(n)||0,2);
const NAVY=[10,42,92], BLUE=[21,101,216], LINE=[223,232,243], INK=[15,32,56], MUTE=[110,130,155];

function pdfHead(d,title,sub){
  d.setFillColor(...NAVY); d.rect(0,0,595,80,'F');
  d.setTextColor(255,255,255); d.setFont('helvetica','bold'); d.setFontSize(15);
  d.text(String(S.config.station||'BunkSoft').slice(0,42),40,32);
  d.setFont('helvetica','normal'); d.setFontSize(8.5); d.setTextColor(185,212,241);
  d.text([S.config.brand,S.config.place].filter(Boolean).join('  ·  ').slice(0,60),40,47);
  d.setTextColor(255,255,255); d.setFont('helvetica','bold'); d.setFontSize(11.5);
  d.text(title,555,32,{align:'right'});
  d.setFont('helvetica','normal'); d.setFontSize(9); d.setTextColor(185,212,241);
  d.text(sub,555,47,{align:'right'});
  return 106;
}
function pdfCards(d,y,cards){
  const W=(515-3*11)/4;
  cards.forEach((c,i)=>{
    const x=40+i*(W+11);
    d.setFillColor(...(c.tint||[236,242,251])); d.setDrawColor(...LINE);
    d.roundedRect(x,y,W,52,6,6,'FD');
    d.setFont('helvetica','bold'); d.setFontSize(7.5); d.setTextColor(...(c.ink||BLUE));
    d.text(c.k.toUpperCase(),x+10,y+16);
    d.setFontSize(13); d.text(String(c.v),x+10,y+34);
    if(c.s){d.setFont('helvetica','normal');d.setFontSize(7);d.setTextColor(...MUTE);d.text(String(c.s).slice(0,30),x+10,y+45);}
  });
  return y+52+20;
}
function pdfSec(d,y,t){
  if(y>752){d.addPage();y=52;}
  d.setFont('helvetica','bold'); d.setFontSize(9); d.setTextColor(...BLUE);
  d.text(t.toUpperCase(),40,y);
  d.setDrawColor(...LINE); d.setLineWidth(.7); d.line(40,y+5,555,y+5);
  return y+14;
}
function pdfTable(d,y,head,body,colStyles){
  if(!body.length)return y;
  d.autoTable({startY:y,head:[head],body,theme:'grid',
    styles:{font:'helvetica',fontSize:7.6,cellPadding:4,lineColor:LINE,lineWidth:.5,textColor:INK,overflow:'linebreak'},
    headStyles:{fillColor:BLUE,textColor:[255,255,255],fontStyle:'bold',fontSize:7.2},
    alternateRowStyles:{fillColor:[246,249,253]},
    columnStyles:colStyles||{}, margin:{left:40,right:40}});
  return d.lastAutoTable.finalY+18;
}
function pdfRows(d,y,rows){
  rows.forEach(([k,v,bold,col])=>{
    if(y>790){d.addPage();y=52;}
    d.setFont('helvetica',bold?'bold':'normal'); d.setFontSize(bold?9.5:8.6);
    d.setTextColor(...(col||(bold?INK:[70,90,115])));
    d.text(String(k),44,y); d.text(String(v),551,y,{align:'right'});
    if(bold){d.setDrawColor(...LINE);d.line(40,y+4,555,y+4);}
    y+=bold?17:13.5;
  });
  return y+8;
}
function pdfFinish(d,sign,y){
  if(sign){
    y=(y||0)+42;
    if(y>756){d.addPage();y=120;}
    d.setDrawColor(...LINE); d.setLineWidth(.8);
    d.line(60,y,250,y); d.line(345,y,535,y);
    d.setFont('helvetica','normal'); d.setFontSize(8); d.setTextColor(...MUTE);
    d.text('Operator signature',155,y+13,{align:'center'});
    d.text('Manager signature',440,y+13,{align:'center'});
  }
  const n=d.internal.getNumberOfPages(), stamp=new Date().toLocaleString('en-IN');
  for(let i=1;i<=n;i++){
    d.setPage(i);
    d.setDrawColor(...LINE); d.setLineWidth(.7); d.line(40,806,555,806);
    d.setFont('helvetica','normal'); d.setFontSize(7); d.setTextColor(...MUTE);
    d.text('BunkSoft · Subsel Tech Solutions Pvt Ltd · generated '+stamp,40,818);
    d.text('Page '+i+' of '+n,555,818,{align:'right'});
  }
}
async function savePdf(d,filename){ download(d.output('blob'),filename); }

async function pdfShift(date,nm){
  let lib; try{ lib=await pdfReady(); }catch(e){ return toast('Could not load the PDF library. Check the connection and try again.'); }
  const {day,t,byProd}=shiftData(date,nm), sh=t.sh;
  const d=new lib.jsPDF({unit:'pt',format:'a4'});
  let y=pdfHead(d,'SHIFT CLOSING REPORT',dmy(date)+'  ·  '+nm+' shift');
  y=pdfCards(d,y,[
    {k:'Sale value',v:R(t.due),s:nf(t.qty,0)+' litres',tint:[228,238,253],ink:BLUE},
    {k:'Collected',v:R(num(sh.cash)+num(sh.card)+num(sh.upi)),s:'cash + card + UPI',tint:[223,243,242],ink:[0,120,115]},
    {k:'Credit given',v:R(t.credit),s:plural((sh.credit||[]).length,'slip'),tint:[253,240,220],ink:[190,110,10]},
    {k:'Short / excess',v:Math.abs(t.diff)<1?'In balance':R(t.diff),s:'against sale value',
      tint:Math.abs(t.diff)<1?[226,245,236]:[252,228,233],ink:Math.abs(t.diff)<1?[14,122,78]:[200,30,66]}
  ]);
  d.setFont('helvetica','normal'); d.setFontSize(8.5); d.setTextColor(...MUTE);
  d.text('Operator: '+(sh.operator||'-')+'     Status: '+(sh.closed?'Closed and handed over':'Draft')
    +(sh.closedAt?'     Closed at: '+sh.closedAt:''),40,y);
  y+=20;
  y=pdfSec(d,y,'Nozzle meter readings');
  y=pdfTable(d,y,['Nozzle','Product','Opening','Closing','Test','Sold L','Rate','Amount'],
    t.lines.filter(l=>l.qty||l.close).map(l=>[l.noz.name+(l.noz.archived?' (retired)':''),prod(l.noz.product).short,nf(l.open,2),
      nf(l.close,2)+(l.rollover?' (+'+nf(l.rollover,0)+' rollover)':''),l.test?nf(l.test,2):'-',nf(l.qty,2),nf(l.rate,2),R(l.amount)])
      .concat([[{content:'TOTAL',colSpan:5,styles:{fontStyle:'bold'}},{content:nf(t.qty,2),styles:{fontStyle:'bold'}},'',{content:R(t.fuel),styles:{fontStyle:'bold'}}]]),
    {2:{halign:'right'},3:{halign:'right'},4:{halign:'right'},5:{halign:'right'},6:{halign:'right'},7:{halign:'right'}});
  if(Object.keys(byProd).length){
    y=pdfSec(d,y,'Fuel sold');
    y=pdfTable(d,y,['Product','Litres','Value'],Object.keys(byProd).map(p=>[prod(p).name,nf(byProd[p].qty,2),R(byProd[p].amount)]),
      {1:{halign:'right'},2:{halign:'right'}});
  }
  y=pdfSec(d,y,'Collections');
  const cr=(sh.credit||[]).map(c=>['   '+(cust(c.cust)?.name||'-')+(c.slip?' · slip '+c.slip:''),R(c.amount)]);
  y=pdfRows(d,y,[['Cash',R(sh.cash)],['UPI',R(sh.upi)],['Card',R(sh.card)],['Bank transfer',R(sh.bank)],
    ['Credit ('+plural((sh.credit||[]).length,'slip')+')',R(t.credit)],...cr,
    ...(t.other?[[sh.other?.note||'Lubes / other sales',R(t.other)]]:[]),
    ['Total due',R(t.due),true],['Total received',R(t.recv),true],
    ['Short / excess',Math.abs(t.diff)<1?'In balance':R(t.diff),true,
      Math.abs(t.diff)<1?[14,122,78]:[200,30,66]]]);
  y=pdfSec(d,y,'Tank stock after this shift');
  y=pdfTable(d,y,['Tank','Product','Book stock (L)','Capacity (L)'],
    S.tanks.map(tk=>[tk.name,prod(tk.product).short,nf(tk.stock,0),nf(tk.capacity,0)]),{2:{halign:'right'},3:{halign:'right'}});
  pdfFinish(d,true,y);
  await savePdf(d,'shift-report-'+date+'-'+nm.toLowerCase().replace(/\s+/g,'-')+'.pdf');
}

async function pdfDay(date){
  let lib; try{ lib=await pdfReady(); }catch(e){ return toast('Could not load the PDF library. Check the connection and try again.'); }
  const day=getDay(date), T=dayTotals(date);
  const d=new lib.jsPDF({unit:'pt',format:'a4'});
  let y=pdfHead(d,'DAILY SALES REPORT',dmy(date));
  y=pdfCards(d,y,[
    {k:'Total sales',v:R(T.fuel+T.other),s:nf(T.qty,0)+' litres',tint:[228,238,253],ink:BLUE},
    {k:'Stock value',v:R(stockValue()),s:plural(S.tanks.length,'tank'),tint:[223,243,242],ink:[0,120,115]},
    {k:'Expenses',v:R(T.expenses),s:plural((day.expenses||[]).length,'entry').replace('entrys','entries'),tint:[253,240,220],ink:[190,110,10]},
    {k:'Pending credits',v:R(outstanding()),s:plural(S.customers.length,'account'),tint:[252,228,233],ink:[200,30,66]}
  ]);

  y=pdfSec(d,y,'Rates for the day');
  y=pdfTable(d,y,['Product','Selling Rs./L','Purchase Rs./L','Margin Rs./L'],
    activeProducts().map(p=>[p.name,nf(day.rates[p.id]?.sell||0,2),nf(day.rates[p.id]?.buy||0,2),nf((day.rates[p.id]?.sell||0)-(day.rates[p.id]?.buy||0),2)]),
    {1:{halign:'right'},2:{halign:'right'},3:{halign:'right'}});

  /* readings, shift by shift */
  (S.config.shifts||[]).forEach(nm=>{
    if(!day.shifts[nm])return;
    const t=shiftTotals(day,nm);
    y=pdfSec(d,y,nm+' shift — meter readings'+(t.sh.operator?'  ·  '+t.sh.operator:''));
    y=pdfTable(d,y,['Nozzle','Product','Opening','Closing','Test','Sold L','Rate','Amount'],
      t.lines.filter(l=>l.qty||l.close).map(l=>[l.noz.name,prod(l.noz.product).short,nf(l.open,2),nf(l.close,2),l.test?nf(l.test,2):'-',nf(l.qty,2),nf(l.rate,2),R(l.amount)])
        .concat([[{content:'TOTAL',colSpan:5,styles:{fontStyle:'bold'}},{content:nf(t.qty,2),styles:{fontStyle:'bold'}},'',{content:R(t.fuel),styles:{fontStyle:'bold'}}]]),
      {2:{halign:'right'},3:{halign:'right'},4:{halign:'right'},5:{halign:'right'},6:{halign:'right'},7:{halign:'right'}});
  });

  y=pdfSec(d,y,'Sales summary by product');
  y=pdfTable(d,y,['Product','Litres','Sales','Cost','Margin'],
    S.config.products.filter(p=>T.byProd[p.id]?.qty).map(p=>{const b=T.byProd[p.id];
      return [p.name,nf(b.qty,2),R(b.amount),R(b.cost),R(b.amount-b.cost)];}),
    {1:{halign:'right'},2:{halign:'right'},3:{halign:'right'},4:{halign:'right'}});

  const C=cashBook(date);
  y=pdfSec(d,y,'Collections by shift');
  y=pdfTable(d,y,['Shift','Operator','Cash','UPI','Card','Bank transfer','Credit','Short / excess'],
    (S.config.shifts||[]).filter(nm=>day.shifts[nm]).map(nm=>{const t=shiftTotals(day,nm);
      return [nm,t.sh.operator||'-',R(t.sh.cash),R(t.sh.upi),R(t.sh.card),R(t.sh.bank),R(t.credit),Math.abs(t.diff)<1?'In balance':R(t.diff)];})
      .concat(T.stray?[['(shift cleared)','-','-','-','-','-',R(T.stray),'-']]:[])
      .concat([[{content:'TOTAL',colSpan:2,styles:{fontStyle:'bold'}},
        ...[T.cash,T.upi,T.card,T.bank,T.credit].map(v=>({content:R(v),styles:{fontStyle:'bold'}})),
        {content:Math.abs(T.diff)<1?'In balance':R(T.diff),styles:{fontStyle:'bold'}}]]),
    {2:{halign:'right'},3:{halign:'right'},4:{halign:'right'},5:{halign:'right'},6:{halign:'right'},7:{halign:'right'}});

  y=pdfSec(d,y,'Payment tally — 24 hours');
  y=pdfRows(d,y,[
    ['Cash',R(T.cash)],['UPI',R(T.upi)],['Card',R(T.card)],['Bank transfer',R(T.bank)],
    ['Credit given (unpaid)',R(T.credit)],
    ['Total received against sales',R(T.received+T.credit),true],
    ['Sale value for the day',R(T.fuel+T.other)],
    ['Short / excess',Math.abs(T.diff)<1?'In balance':R(T.diff),true,
      Math.abs(T.diff)<1?[14,122,78]:[200,30,66]]
  ]);

  y=pdfSec(d,y,'Cash book');
  y=pdfRows(d,y,[
    ['Opening cash in hand',R(C.opening)],
    ['Add: cash sales',R(T.cash)],
    ['Add: credit recovered in cash',R(C.recovCash)],
    ['Less: expenses paid in cash','('+R(C.expCash)+')'],
    ['Less: cash deposited to bank','('+R(C.deposits)+')'],
    ['Closing cash in hand (expected)',R(C.closing),true],
    ['Cash counted',C.counted===null?'not counted':R(C.counted)],
    ...(C.diff===null?[]:[['Difference',Math.abs(C.diff)<1?'In balance':R(C.diff),true,
      Math.abs(C.diff)<1?[14,122,78]:[200,30,66]]])
  ]);

  y=pdfSec(d,y,'Bank and digital');
  y=pdfRows(d,y,[
    ['UPI',R(T.upi)],['Card',R(T.card)],['Bank transfer',R(T.bank)],
    ['Credit recovered by bank / UPI / cheque',R(C.recovBank)],
    ['Cash deposited to bank',R(C.deposits)],
    ['Less: expenses paid by bank / UPI / card','('+R(C.expBank)+')'],
    ['Net into the bank today',R(C.toBank),true]
  ]);
  if((day.deposits||[]).length){
    y=pdfSec(d,y,'Cash deposits');
    y=pdfTable(d,y,['Time','Bank','Slip / ref','Amount'],
      day.deposits.map(dp=>[dp.time||'-',dp.bank||'-',dp.ref||'-',R(dp.amount)])
        .concat([[{content:'TOTAL',colSpan:3,styles:{fontStyle:'bold'}},{content:R(C.deposits),styles:{fontStyle:'bold'}}]]),
      {3:{halign:'right'}});
  }

  const slips=[]; (S.config.shifts||[]).forEach(nm=>(day.shifts[nm]?.credit||[]).forEach(c=>
    slips.push([nm,cust(c.cust)?.name||'-',c.vehicle||'-',c.slip||'-',c.qty?nf(c.qty,2):'-',R(c.amount)])));
  /* Slips whose shift was cleared still owe money; they belong on the sheet. */
  (day.unassignedCredit||[]).forEach(c=>
    slips.push(['(shift cleared)',cust(c.cust)?.name||'-',c.vehicle||'-',c.slip||'-',c.qty?nf(c.qty,2):'-',R(c.amount)]));
  if(slips.length){
    y=pdfSec(d,y,'Credit slips issued');
    y=pdfTable(d,y,['Shift','Customer','Vehicle','Slip no.','Litres','Amount'],slips,{4:{halign:'right'},5:{halign:'right'}});
  }
  if((day.payments||[]).length){
    y=pdfSec(d,y,'Credit received');
    y=pdfTable(d,y,['Customer','Mode','Note','Amount'],
      day.payments.map(p=>[cust(p.cust)?.name||'-',p.mode||'-',p.note||'-',R(p.amount)]),{3:{halign:'right'}});
  }
  if(S.customers.length){
    y=pdfSec(d,y,'Credit outstanding');
    y=pdfTable(d,y,['Customer','Vehicle','Limit','Outstanding'],
      S.customers.slice().sort((a,b)=>num(b.balance)-num(a.balance))
        .map(c=>[c.name,c.vehicle||'-',num(c.limit)?R(c.limit):'-',R(c.balance)])
        .concat([[{content:'TOTAL',colSpan:3,styles:{fontStyle:'bold'}},{content:R(outstanding()),styles:{fontStyle:'bold'}}]]),
      {2:{halign:'right'},3:{halign:'right'}});
  }

  y=pdfSec(d,y,'Stock position');
  y=pdfTable(d,y,['Tank','Product','Received','Sold','Closing book (L)','Capacity (L)'],
    S.tanks.map(tk=>[tk.name,prod(tk.product).short,recvToday(date,tk.id)?nf(recvToday(date,tk.id),0):'-',
      soldToday(date,tk.id)?nf(soldToday(date,tk.id),2):'-',nf(tk.stock,0),nf(tk.capacity,0)]),
    {2:{halign:'right'},3:{halign:'right'},4:{halign:'right'},5:{halign:'right'}});
  if((day.receipts||[]).length){
    y=pdfSec(d,y,'Decantation');
    y=pdfTable(d,y,['Tank','Qty (L)','Rate','Value','Invoice','Tanker'],
      day.receipts.map(r=>[tank(r.tank)?.name||r.tank,nf(r.qty,0),nf(r.rate,2),R(num(r.qty)*num(r.rate)),r.invoice||'-',r.truck||'-']),
      {1:{halign:'right'},2:{halign:'right'},3:{halign:'right'}});
  }
  if((day.dips||[]).length){
    y=pdfSec(d,y,'Dip readings');
    y=pdfTable(d,y,['Tank','Book (L)','Dip (L)','Variation (L)','Valued'],
      day.dips.map(dp=>{const v=num(dp.dip)-num(dp.book);
        return [tank(dp.tank)?.name||dp.tank,nf(dp.book,0),nf(dp.dip,0),(v>=0?'+':'-')+nf(Math.abs(v),0),R(v*(day.rates[dp.product]?.buy||0))];}),
      {1:{halign:'right'},2:{halign:'right'},3:{halign:'right'},4:{halign:'right'}});
  }
  y=pdfSec(d,y,'Expenses');
  y=pdfTable(d,y,['Head','Paid by','Note','Amount'],
    (day.expenses||[]).length?day.expenses.map(e=>[e.head,e.mode||'Cash',e.note||'-',R(e.amount)])
      .concat([[{content:'TOTAL',colSpan:3,styles:{fontStyle:'bold'}},{content:R(T.expenses),styles:{fontStyle:'bold'}}]])
      :[['No expenses recorded','','','-']],{3:{halign:'right'}});

  y=pdfSec(d,y,'Profit and loss for the day');
  const cogs=Object.values(T.byProd).reduce((a,b)=>a+b.cost,0);
  y=pdfRows(d,y,[
    ['Fuel sales',R(T.fuel)],['Less: cost of fuel sold','('+R(cogs)+')'],
    ['Gross margin on fuel',R(T.fuel-cogs),true],
    ['Lubes and other sales',R(T.other)],['Less: cost of those','('+R(T.otherCost)+')'],
    ['Gross profit',R(T.margin),true],
    ['Less: expenses','('+R(T.expenses)+')'],
    ['Net profit for the day',R(T.net),true,T.net>=0?[14,122,78]:[200,30,66]]
  ]);
  pdfFinish(d,true,y);
  await savePdf(d,'daily-sales-report-'+date+'.pdf');
}

/* ---- CSV export ---- */
const cell=v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
function csv(filename,rows){
  const text=rows.map(r=>r.map(cell).join(',')).join('\r\n');
  download(new Blob(['\ufeff'+text],{type:'text/csv;charset=utf-8'}),filename);
}
function exportPL(){
  const {from,to}=reportRange(); const rows=[['Profit & loss',S.config.station],['Period',from+' to '+to]];
  /* Say it in the file as well as on screen: a reader of the CSV has no other
     way to know the period was only partly read. */
  const gap=missingDays(from,to);
  if(gap.length)rows.push(['WARNING',gap.length+' day(s) in this period were not loaded; the figures below are incomplete.']);
  rows.push([]);
  rows.push(['Product','Litres','Sales','Cost','Margin']);
  const dates=Object.keys(S.days).filter(d=>d>=from&&d<=to);
  const agg={},heads={}; let other=0,otherCost=0,exp=0;
  dates.forEach(d=>{const t=dayTotals(d);Object.entries(t.byProd).forEach(([p,b])=>{const x=agg[p]||(agg[p]={qty:0,amount:0,cost:0});x.qty+=b.qty;x.amount+=b.amount;x.cost+=b.cost;});
    other+=t.other;otherCost+=t.otherCost;exp+=t.expenses;
    (S.days[d].expenses||[]).forEach(e=>addHead(heads,e.head,num(e.amount)));});
  let gm=0; Object.entries(agg).forEach(([p,b])=>{rows.push([prod(p).name,b.qty.toFixed(2),b.amount.toFixed(2),b.cost.toFixed(2),(b.amount-b.cost).toFixed(2)]);gm+=b.amount-b.cost;});
  rows.push([],['Lube & other sales','',other.toFixed(2),otherCost.toFixed(2),(other-otherCost).toFixed(2)]);
  rows.push([],['Expenses','']); headList(heads).forEach(h=>rows.push([h.label,h.amount.toFixed(2)]));
  rows.push(['Total expenses',exp.toFixed(2)],[],['Gross profit',(gm+other-otherCost).toFixed(2)],['Net profit',(gm+other-otherCost-exp).toFixed(2)]);
  csv('profit-loss-'+from+'-to-'+to+'.csv',rows);
}
function exportDayBook(){
  const {from,to}=reportRange();
  const rows=[['Date','Shift','Nozzle','Product','Opening','Closing','Test','Rollover','Litres','Rate','Amount']];
  Object.keys(S.days).filter(d=>d>=from&&d<=to).sort().forEach(d=>{
    const day=S.days[d];
    (S.config.shifts||[]).forEach(nm=>{ if(!day.shifts?.[nm])return;
      shiftTotals(day,nm).lines.forEach(l=>{ if(!l.close&&!l.qty)return;
        rows.push([d,nm,l.noz.name+(l.noz.archived?' (retired)':''),prod(l.noz.product).short,
          l.open,l.close,l.test,l.rollover,l.qty.toFixed(2),l.rate.toFixed(2),l.amount.toFixed(2)]);});});
  });
  csv('day-book-'+from+'-to-'+to+'.csv',rows);
}
function exportCredit(){
  const rows=[['Customer','Vehicle','Phone','Limit','Outstanding']];
  S.customers.forEach(c=>rows.push([c.name,c.vehicle||'',c.phone||'',num(c.limit).toFixed(2),num(c.balance).toFixed(2)]));
  rows.push([],['Ledger']); rows.push(['Customer','Date','Type','Detail','Amount','Balance']);
  S.customers.forEach(c=>(c.txns||[]).forEach(t=>rows.push([c.name,t.date,t.type,t.label||'',num(t.amount).toFixed(2),num(t.bal).toFixed(2)])));
  csv('credit-ledger-'+today()+'.csv',rows);
}


/* Handles for the test harness and for support sessions. */
/* A small surface for the test suites and for support work in the console.
   Nothing in the app reads from here. */
window.BunkSoft={ get S(){return S;}, repo, get repoRole(){return repo.role;},
  cashBook, dayTotals, shiftTotals, shiftLines, lastClose, strayCredit,
  activeNozzles, activeProducts, nozzlesFor, ratesOf, missingDays,
  render, getDay };
