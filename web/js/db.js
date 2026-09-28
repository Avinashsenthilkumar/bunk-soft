/* ============================================================================
   BunkSoft — Supabase client, authentication and data repository.
   Subsel Tech Solutions Pvt Ltd

   The repository hands the UI exactly the shapes it already works with:
     config   {station, brand, place, shifts[], heads[], products[], nozzles[]}
     tanks    [{id,name,product,capacity,stock,min}]
     customers[{id,name,phone,vehicle,limit,opening,balance,txns[]}]
     day      {date, rates{}, shifts{}, receipts[], dips[], expenses[],
               payments[], deposits[], openingCash, cashCounted}
   Everything below that line is SQL. Tank stock is never written from here —
   database triggers own it, so we re-read tanks after anything that moves fuel.
   ========================================================================== */

export const cfg = window.BUNKSOFT_CONFIG || {};

/* Allow QA to point a deployed build at a database without a rebuild. */
const OVERRIDE_KEY = 'bunksoft.supabase';
export function storedOverride() {
  try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || 'null'); } catch { return null; }
}
export function saveOverride(url, key) {
  try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ url, key })); } catch {}
}
export function clearOverride() {
  try { localStorage.removeItem(OVERRIDE_KEY); } catch {}
}

const ov = storedOverride();
export const SUPABASE_URL = (ov && ov.url) || cfg.supabaseUrl || '';
export const SUPABASE_KEY = (ov && ov.key) || cfg.supabaseAnonKey || '';
export const configured = !!(SUPABASE_URL && SUPABASE_KEY && !/YOUR_/.test(SUPABASE_URL));

export let sb = null;
export function initClient(createClient) {
  if (!configured) return null;
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return sb;
}

/* ------------------------------------------------------------------ auth -- */
export const auth = {
  async session() { const { data } = await sb.auth.getSession(); return data.session || null; },
  async user() { const { data } = await sb.auth.getUser(); return data.user || null; },
  signIn: (email, password) => sb.auth.signInWithPassword({ email: email.trim(), password }),
  signUp: (email, password, fullName) => sb.auth.signUp({
    email: email.trim(), password, options: { data: { full_name: fullName || '' } }
  }),
  reset: (email) => sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + location.pathname }),
  signOut: () => sb.auth.signOut(),
  onChange: (fn) => sb.auth.onAuthStateChange((_e, s) => fn(s))
};

/* Errors from PostgREST are readable but long; trim to something an operator
   can act on, while keeping the real message for the console. */
function fail(context, error) {
  if (!error) return;
  console.error('[BunkSoft]', context, error);
  const msg = error.message || String(error);
  if (/row-level security/i.test(msg)) throw new Error('You do not have permission to do that.');
  if (/duplicate key/i.test(msg)) throw new Error('That entry already exists.');
  if (/JWT|session/i.test(msg)) throw new Error('Your session expired — please sign in again.');
  throw new Error(msg);
}
async function run(context, q) {
  const { data, error } = await q;
  if (error) fail(context, error);
  return data;
}

/* ------------------------------------------------------------- the bunk -- */
export const repo = {
  bunkId: null,
  role: 'operator',

  setBunk(id, role) { this.bunkId = id; this.role = role || 'operator'; },
  canConfigure() { return this.role === 'owner' || this.role === 'manager'; },

  myBunks() { return run('my_bunks', sb.rpc('my_bunks')); },

  async createBunk(name, brand, place) {
    const { data, error } = await sb.rpc('create_bunk',
      { p_name: name, p_brand: brand || null, p_place: place || null, p_seed: true });
    if (error) fail('create_bunk', error);
    return data;
  },

  addMember(email, role) {
    return run('add_member', sb.rpc('add_member', { p_bunk: this.bunkId, p_email: email, p_role: role }));
  },
  async members() {
    const rows = await run('members', sb.from('memberships')
      .select('user_id, role, created_at, profiles(full_name)').eq('bunk_id', this.bunkId));
    return (rows || []).map(r => ({
      userId: r.user_id, role: r.role, name: r.profiles?.full_name || '—', since: r.created_at
    }));
  },
  removeMember(userId) {
    return run('removeMember', sb.from('memberships').delete()
      .eq('bunk_id', this.bunkId).eq('user_id', userId));
  },

  /* ---------------------------------------------------- reference data -- */
  async loadConfig() {
    const [bunk, products, nozzles] = await Promise.all([
      run('bunk', sb.from('bunks').select('*').eq('id', this.bunkId).single()),
      run('products', sb.from('products').select('*').eq('bunk_id', this.bunkId).eq('archived', false).order('sort_order')),
      run('nozzles', sb.from('nozzles').select('*').eq('bunk_id', this.bunkId).eq('archived', false).order('sort_order'))
    ]);
    return {
      station: bunk.name, brand: bunk.brand || '', place: bunk.place || '',
      shifts: bunk.shift_names || ['Morning', 'Evening'],
      heads: bunk.expense_heads || [],
      products: (products || []).map(p => ({
        id: p.id, code: p.code, name: p.name, short: p.short_name,
        sell: Number(p.sell_rate), buy: Number(p.buy_rate), sort: p.sort_order
      })),
      nozzles: (nozzles || []).map(n => ({
        id: n.id, name: n.name, product: n.product_id, tank: n.tank_id, sort: n.sort_order
      }))
    };
  },

  async loadTanks() {
    const rows = await run('tanks', sb.from('tanks').select('*')
      .eq('bunk_id', this.bunkId).eq('archived', false).order('sort_order'));
    return (rows || []).map(t => ({
      id: t.id, name: t.name, product: t.product_id, capacity: Number(t.capacity),
      stock: Number(t.current_stock), min: Number(t.min_level), sort: t.sort_order
    }));
  },

  saveBunkSettings(c) {
    return run('saveBunkSettings', sb.from('bunks').update({
      name: c.station, brand: c.brand || null, place: c.place || null,
      shift_names: c.shifts, expense_heads: c.heads
    }).eq('id', this.bunkId));
  },

  async saveProduct(p) {
    const row = {
      bunk_id: this.bunkId, code: p.code || (p.short || 'new').toLowerCase().replace(/[^a-z0-9]/g, ''),
      name: p.name, short_name: p.short, sell_rate: p.sell, buy_rate: p.buy, sort_order: p.sort || 0
    };
    if (p.id && !String(p.id).startsWith('new')) {
      return run('updateProduct', sb.from('products').update(row).eq('id', p.id));
    }
    return run('insertProduct', sb.from('products').insert(row).select('id').single());
  },
  archiveProduct(id) {
    return run('archiveProduct', sb.from('products').update({ archived: true }).eq('id', id));
  },

  async saveTank(t) {
    const row = {
      bunk_id: this.bunkId, name: t.name, product_id: t.product || null,
      capacity: t.capacity, min_level: t.min, sort_order: t.sort || 0
    };
    /* current_stock is deliberately absent — triggers own it. An owner
       correcting stock does it through a dip reading, which leaves a trail. */
    if (t.id && !String(t.id).startsWith('new')) {
      return run('updateTank', sb.from('tanks').update(row).eq('id', t.id));
    }
    return run('insertTank', sb.from('tanks').insert({ ...row, current_stock: 0 }).select('id').single());
  },
  archiveTank(id) { return run('archiveTank', sb.from('tanks').update({ archived: true }).eq('id', id)); },

  async saveNozzle(n) {
    const row = {
      bunk_id: this.bunkId, name: n.name, product_id: n.product || null,
      tank_id: n.tank || null, sort_order: n.sort || 0
    };
    if (n.id && !String(n.id).startsWith('new')) {
      return run('updateNozzle', sb.from('nozzles').update(row).eq('id', n.id));
    }
    return run('insertNozzle', sb.from('nozzles').insert(row).select('id').single());
  },
  archiveNozzle(id) { return run('archiveNozzle', sb.from('nozzles').update({ archived: true }).eq('id', id)); },

  /* --------------------------------------------------------- customers -- */
  async loadCustomers() {
    const [bal, txns] = await Promise.all([
      run('balances', sb.from('customer_balances').select('*').eq('bunk_id', this.bunkId).eq('archived', false)),
      run('txns', sb.from('credit_txns').select('*').eq('bunk_id', this.bunkId)
        .order('day', { ascending: false }).order('created_at', { ascending: false }).limit(2000))
    ]);
    const byCust = {};
    (txns || []).forEach(t => (byCust[t.customer_id] = byCust[t.customer_id] || []).push(t));
    return (bal || []).map(c => {
      const list = byCust[c.customer_id] || [];
      /* Walk oldest-first to produce a running balance, then show newest first. */
      let bal2 = Number(c.opening_balance);
      const asc = list.slice().reverse().map(t => {
        bal2 += t.kind === 'payment' ? -Number(t.amount) : Number(t.amount);
        return {
          id: t.id, date: t.day, type: t.kind, amount: Number(t.amount),
          label: t.kind === 'payment' ? (t.mode || 'Cash') + (t.note ? ' · ' + t.note : '')
               : t.kind === 'opening' ? 'Opening balance'
               : (t.slip_no ? 'Slip ' + t.slip_no : 'Credit sale'),
          bal: Math.round(bal2 * 100) / 100
        };
      });
      return {
        id: c.customer_id, name: c.name, phone: c.phone || '', vehicle: c.vehicle || '',
        limit: Number(c.credit_limit), opening: Number(c.opening_balance),
        balance: Number(c.balance), txns: asc.reverse()
      };
    }).sort((a, b) => b.balance - a.balance);
  },

  addCustomer(c) {
    return run('addCustomer', sb.from('credit_customers').insert({
      bunk_id: this.bunkId, name: c.name, phone: c.phone || null, vehicle: c.vehicle || null,
      credit_limit: c.limit || 0, opening_balance: c.opening || 0
    }).select('id').single());
  },
  archiveCustomer(id) {
    return run('archiveCustomer', sb.from('credit_customers').update({ archived: true }).eq('id', id));
  },

  /* ---------------------------------------------------------- one day --- */
  async loadDay(date) {
    const B = this.bunkId;
    const [dayRow, shifts, expenses, receipts, dips, deposits, payments] = await Promise.all([
      run('day', sb.from('business_days').select('*').eq('bunk_id', B).eq('day', date).maybeSingle()),
      run('shifts', sb.from('shifts').select('*, readings(*)').eq('bunk_id', B).eq('day', date)),
      run('expenses', sb.from('expenses').select('*').eq('bunk_id', B).eq('day', date).order('created_at')),
      run('receipts', sb.from('fuel_receipts').select('*').eq('bunk_id', B).eq('day', date).order('received_at')),
      run('dips', sb.from('dip_readings').select('*').eq('bunk_id', B).eq('day', date).order('taken_at')),
      run('deposits', sb.from('cash_deposits').select('*').eq('bunk_id', B).eq('day', date).order('deposited_at')),
      run('payments', sb.from('credit_txns').select('*').eq('bunk_id', B).eq('day', date).eq('kind', 'payment'))
    ]);
    return this._assembleDay(date, dayRow, shifts, expenses, receipts, dips, deposits, payments);
  },

  _assembleDay(date, dayRow, shifts, expenses, receipts, dips, deposits, payments) {
    const day = {
      date,
      rates: (dayRow && dayRow.rates) || {},
      openingCash: dayRow ? Number(dayRow.opening_cash) : 0,
      cashCounted: dayRow && dayRow.cash_counted != null ? Number(dayRow.cash_counted) : null,
      shifts: {}, receipts: [], dips: [], expenses: [], payments: [], deposits: []
    };
    (shifts || []).forEach(s => {
      const readings = {};
      (s.readings || []).forEach(r => {
        readings[r.nozzle_id] = {
          open: Number(r.opening_reading), close: Number(r.closing_reading), test: Number(r.test_litres)
        };
      });
      day.shifts[s.name] = {
        id: s.id, operator: s.operator || '', closed: !!s.closed,
        closedAt: s.closed_at ? new Date(s.closed_at).toTimeString().slice(0, 5) : '',
        cash: Number(s.cash), card: Number(s.card), upi: Number(s.upi), bank: Number(s.bank),
        other: { amount: Number(s.other_amount), cost: Number(s.other_cost), note: s.other_note || '' },
        credit: [], readings
      };
    });
    (expenses || []).forEach(e => day.expenses.push({
      id: e.id, head: e.head, mode: e.mode, amount: Number(e.amount), note: e.note || ''
    }));
    (receipts || []).forEach(r => day.receipts.push({
      id: r.id, tank: r.tank_id, product: r.product_id, qty: Number(r.qty), rate: Number(r.rate),
      invoice: r.invoice_no || '', truck: r.tanker_no || '',
      time: new Date(r.received_at).toTimeString().slice(0, 5)
    }));
    (dips || []).forEach(d => day.dips.push({
      id: d.id, tank: d.tank_id, product: d.product_id, book: Number(d.book_qty), dip: Number(d.dip_qty),
      time: new Date(d.taken_at).toTimeString().slice(0, 5)
    }));
    (deposits || []).forEach(d => day.deposits.push({
      id: d.id, amount: Number(d.amount), bank: d.bank || '', ref: d.ref || '',
      time: new Date(d.deposited_at).toTimeString().slice(0, 5)
    }));
    (payments || []).forEach(p => day.payments.push({
      id: p.id, cust: p.customer_id, amount: Number(p.amount), mode: p.mode || 'Cash', note: p.note || ''
    }));
    return day;
  },

  /* Credit sales belong to a shift, so they are attached after shifts load. */
  async attachCreditSlips(date, day) {
    const rows = await run('creditSales', sb.from('credit_txns').select('*')
      .eq('bunk_id', this.bunkId).eq('day', date).eq('kind', 'sale'));
    const byShift = {};
    Object.entries(day.shifts).forEach(([name, s]) => { if (s.id) byShift[s.id] = s; });
    (rows || []).forEach(t => {
      const slip = {
        id: t.id, cust: t.customer_id, product: t.product_id, qty: t.qty ? Number(t.qty) : 0,
        amount: Number(t.amount), vehicle: t.vehicle || '', slip: t.slip_no || ''
      };
      const target = t.shift_id && byShift[t.shift_id];
      if (target) target.credit.push(slip);
      else {
        const first = Object.values(day.shifts)[0];
        if (first) first.credit.push(slip);
      }
    });
    return day;
  },

  /* Reports need many days at once; one round trip per table, not per day. */
  async loadRange(from, to) {
    const B = this.bunkId;
    const [dayRows, shifts, expenses, receipts, dips, deposits, txns] = await Promise.all([
      run('r-days', sb.from('business_days').select('*').eq('bunk_id', B).gte('day', from).lte('day', to)),
      run('r-shifts', sb.from('shifts').select('*, readings(*)').eq('bunk_id', B).gte('day', from).lte('day', to)),
      run('r-exp', sb.from('expenses').select('*').eq('bunk_id', B).gte('day', from).lte('day', to)),
      run('r-rec', sb.from('fuel_receipts').select('*').eq('bunk_id', B).gte('day', from).lte('day', to)),
      run('r-dip', sb.from('dip_readings').select('*').eq('bunk_id', B).gte('day', from).lte('day', to)),
      run('r-dep', sb.from('cash_deposits').select('*').eq('bunk_id', B).gte('day', from).lte('day', to)),
      run('r-txn', sb.from('credit_txns').select('*').eq('bunk_id', B).gte('day', from).lte('day', to))
    ]);
    const group = (rows, key = 'day') => {
      const m = {}; (rows || []).forEach(r => (m[r[key]] = m[r[key]] || []).push(r)); return m;
    };
    const gS = group(shifts), gE = group(expenses), gR = group(receipts),
          gD = group(dips), gDep = group(deposits), gT = group(txns);
    const dayRowBy = {}; (dayRows || []).forEach(r => dayRowBy[r.day] = r);
    const out = {};
    const dates = new Set([...Object.keys(gS), ...Object.keys(gE), ...Object.keys(gR),
      ...Object.keys(gD), ...Object.keys(gDep), ...Object.keys(gT), ...Object.keys(dayRowBy)]);
    dates.forEach(date => {
      const payments = (gT[date] || []).filter(t => t.kind === 'payment');
      const day = this._assembleDay(date, dayRowBy[date], gS[date], gE[date],
        gR[date], gD[date], gDep[date], payments);
      const byShift = {}; Object.values(day.shifts).forEach(s => { if (s.id) byShift[s.id] = s; });
      (gT[date] || []).filter(t => t.kind === 'sale').forEach(t => {
        const slip = {
          id: t.id, cust: t.customer_id, product: t.product_id, qty: t.qty ? Number(t.qty) : 0,
          amount: Number(t.amount), vehicle: t.vehicle || '', slip: t.slip_no || ''
        };
        const target = t.shift_id && byShift[t.shift_id];
        if (target) target.credit.push(slip);
        else { const f = Object.values(day.shifts)[0]; if (f) f.credit.push(slip); }
      });
      out[date] = day;
    });
    return out;
  },

  /* ------------------------------------------------------------ writes -- */
  async ensureDay(date, rates) {
    return run('ensureDay', sb.from('business_days').upsert({
      bunk_id: this.bunkId, day: date, rates: rates || {}
    }, { onConflict: 'bunk_id,day', ignoreDuplicates: true }));
  },

  saveRates(date, rates) {
    return run('saveRates', sb.from('business_days').upsert({
      bunk_id: this.bunkId, day: date, rates
    }, { onConflict: 'bunk_id,day' }));
  },

  saveDayCash(date, openingCash, cashCounted) {
    return run('saveDayCash', sb.from('business_days').upsert({
      bunk_id: this.bunkId, day: date, opening_cash: openingCash, cash_counted: cashCounted
    }, { onConflict: 'bunk_id,day' }));
  },

  /* One shift and all of its nozzle readings, saved together. */
  async saveShift(date, name, sh, nozzles) {
    const row = {
      bunk_id: this.bunkId, day: date, name,
      operator: sh.operator || null, closed: !!sh.closed,
      closed_at: sh.closed ? (sh.closedAtISO || new Date().toISOString()) : null,
      cash: sh.cash || 0, card: sh.card || 0, upi: sh.upi || 0, bank: sh.bank || 0,
      other_amount: sh.other?.amount || 0, other_cost: sh.other?.cost || 0,
      other_note: sh.other?.note || null
    };
    const saved = await run('upsertShift', sb.from('shifts')
      .upsert(row, { onConflict: 'bunk_id,day,name' }).select('id').single());
    const shiftId = saved.id;

    const rows = (nozzles || []).map(n => {
      const r = sh.readings[n.id] || { open: 0, close: 0, test: 0 };
      return {
        bunk_id: this.bunkId, shift_id: shiftId, nozzle_id: n.id, tank_id: n.tank || null,
        opening_reading: r.open || 0, closing_reading: r.close || 0, test_litres: r.test || 0
      };
    });
    if (rows.length) {
      await run('upsertReadings', sb.from('readings').upsert(rows, { onConflict: 'shift_id,nozzle_id' }));
    }
    return shiftId;
  },

  async deleteShift(date, name) {
    const s = await run('findShift', sb.from('shifts').select('id')
      .eq('bunk_id', this.bunkId).eq('day', date).eq('name', name).maybeSingle());
    if (!s) return;
    /* readings cascade, which unwinds their effect on tank stock */
    return run('deleteShift', sb.from('shifts').delete().eq('id', s.id));
  },

  addCreditSlip(date, shiftId, slip) {
    return run('addCreditSlip', sb.from('credit_txns').insert({
      bunk_id: this.bunkId, customer_id: slip.cust, day: date, kind: 'sale',
      amount: slip.amount, shift_id: shiftId || null, product_id: slip.product || null,
      qty: slip.qty || null, vehicle: slip.vehicle || null, slip_no: slip.slip || null
    }).select('id').single());
  },
  addPayment(date, p) {
    return run('addPayment', sb.from('credit_txns').insert({
      bunk_id: this.bunkId, customer_id: p.cust, day: date, kind: 'payment',
      amount: p.amount, mode: p.mode || 'Cash', note: p.note || null
    }).select('id').single());
  },
  deleteTxn(id) { return run('deleteTxn', sb.from('credit_txns').delete().eq('id', id)); },

  addExpense(date, e) {
    return run('addExpense', sb.from('expenses').insert({
      bunk_id: this.bunkId, day: date, head: e.head, mode: e.mode || 'Cash',
      amount: e.amount, note: e.note || null
    }).select('id').single());
  },
  deleteExpense(id) { return run('deleteExpense', sb.from('expenses').delete().eq('id', id)); },

  addReceipt(date, r) {
    return run('addReceipt', sb.from('fuel_receipts').insert({
      bunk_id: this.bunkId, day: date, tank_id: r.tank, product_id: r.product || null,
      qty: r.qty, rate: r.rate || 0, invoice_no: r.invoice || null, tanker_no: r.truck || null
    }).select('id').single());
  },
  deleteReceipt(id) { return run('deleteReceipt', sb.from('fuel_receipts').delete().eq('id', id)); },

  addDip(date, d) {
    return run('addDip', sb.from('dip_readings').insert({
      bunk_id: this.bunkId, day: date, tank_id: d.tank, product_id: d.product || null,
      book_qty: d.book, dip_qty: d.dip
    }).select('id').single());
  },
  deleteDip(id) { return run('deleteDip', sb.from('dip_readings').delete().eq('id', id)); },

  addDeposit(date, d) {
    return run('addDeposit', sb.from('cash_deposits').insert({
      bunk_id: this.bunkId, day: date, amount: d.amount, bank: d.bank || null, ref: d.ref || null
    }).select('id').single());
  },
  deleteDeposit(id) { return run('deleteDeposit', sb.from('cash_deposits').delete().eq('id', id)); }
};
