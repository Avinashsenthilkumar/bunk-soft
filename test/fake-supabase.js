/* ============================================================================
   A stand-in for @supabase/supabase-js, used only by the test harness.
   It implements the slice of the API that db.js actually calls, over
   in-memory tables, so the whole UI can be driven without a network.
   The SQL itself is verified separately against a real Postgres
   (supabase/test_rls.sql).
   ========================================================================== */
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});

export function makeDb() {
  return {
    bunks: [], memberships: [], profiles: [],
    products: [], tanks: [], nozzles: [],
    business_days: [], shifts: [], readings: [],
    credit_customers: [], credit_txns: [],
    fuel_receipts: [], dip_readings: [], expenses: [], cash_deposits: []
  };
}

export function createFakeClient(T, state) {
  const me = () => state.user;

  /* ---- triggers, mirroring the ones in schema.sql ---- */
  const sold = r => Math.max(0, (+r.closing_reading || 0) - (+r.opening_reading || 0) - (+r.test_litres || 0));
  const bumpTank = (id, delta) => {
    const t = T.tanks.find(x => x.id === id);
    if (t) t.current_stock = Math.round((+t.current_stock + delta) * 100) / 100;
  };

  const AFTER_INSERT = {
    readings: r => bumpTank(r.tank_id, -sold(r)),
    fuel_receipts: r => {
      bumpTank(r.tank_id, +r.qty);
      if (r.rate > 0 && r.product_id) {
        const p = T.products.find(x => x.id === r.product_id);
        if (p) p.buy_rate = r.rate;
      }
    },
    dip_readings: r => { const t = T.tanks.find(x => x.id === r.tank_id); if (t) t.current_stock = +r.dip_qty; }
  };
  const AFTER_DELETE = {
    readings: r => bumpTank(r.tank_id, +sold(r)),
    fuel_receipts: r => bumpTank(r.tank_id, -r.qty),
    shifts: s => T.readings.filter(r => r.shift_id === s.id).forEach(r => {
      bumpTank(r.tank_id, +sold(r));
      T.readings.splice(T.readings.indexOf(r), 1);
    })
  };

  function rowsOf(table) {
    if (table === 'customer_balances') {
      return T.credit_customers.map(c => {
        const ts = T.credit_txns.filter(t => t.customer_id === c.id);
        const bal = +c.opening_balance + ts.reduce((a, t) =>
          a + (t.kind === 'payment' ? -(+t.amount) : +t.amount), 0);
        return {
          customer_id: c.id, bunk_id: c.bunk_id, name: c.name, phone: c.phone, vehicle: c.vehicle,
          credit_limit: c.credit_limit, opening_balance: c.opening_balance, archived: c.archived,
          balance: Math.round(bal * 100) / 100,
          last_txn_day: ts.length ? ts.map(t => t.day).sort().pop() : null
        };
      });
    }
    return T[table] || [];
  }

  /* row-level security, simplified to the rule that matters: membership */
  const myBunkIds = () => T.memberships.filter(m => m.user_id === me()).map(m => m.bunk_id);
  const visible = (table, r) =>
    table === 'profiles' ? r.id === me() : !r.bunk_id || myBunkIds().includes(r.bunk_id);
  const canWrite = (table, r) => {
    if (!myBunkIds().includes(r.bunk_id)) return false;
    if (['products', 'tanks', 'nozzles', 'bunks'].includes(table)) {
      const m = T.memberships.find(x => x.bunk_id === r.bunk_id && x.user_id === me());
      return m && (m.role === 'owner' || m.role === 'manager');
    }
    return true;
  };

  function embed(table, row, sel) {
    const out = { ...row };
    const m = /(\w+)\(([^)]*)\)/g; let g;
    while ((g = m.exec(sel))) {
      const child = g[1];
      if (child === 'readings') out.readings = T.readings.filter(r => r.shift_id === row.id);
      else if (child === 'profiles') out.profiles = T.profiles.find(p => p.id === row.user_id) || null;
    }
    return out;
  }

  function builder(table) {
    const q = { _f: [], _sel: '*', _order: [], _limit: null, _single: 0 };
    const api = {
      select(sel) { q._sel = sel || '*'; return api; },
      eq(c, v) { q._f.push([c, '=', v]); return api; },
      gte(c, v) { q._f.push([c, '>=', v]); return api; },
      lte(c, v) { q._f.push([c, '<=', v]); return api; },
      order(c, o) { q._order.push([c, (o && o.ascending === false) ? -1 : 1]); return api; },
      limit(n) { q._limit = n; return api; },
      single() { q._single = 1; return api; },
      maybeSingle() { q._single = 2; return api; },
      insert(rows) { q._op = 'insert'; q._rows = [].concat(rows); return api; },
      update(obj) { q._op = 'update'; q._patch = obj; return api; },
      upsert(rows, opt) { q._op = 'upsert'; q._rows = [].concat(rows); q._conflict = (opt && opt.onConflict) || ''; return api; },
      delete() { q._op = 'delete'; return api; },
      then(res, rej) { return exec().then(res, rej); }
    };

    const match = r => q._f.every(([c, op, v]) =>
      op === '=' ? String(r[c]) === String(v) : op === '>=' ? r[c] >= v : r[c] <= v);

    async function exec() {
      try {
        let data = null;
        if (!q._op) {
          data = rowsOf(table).filter(r => visible(table, r)).filter(match)
            .map(r => embed(table, r, q._sel));
          q._order.forEach(([c, dir]) => data.sort((a, b) =>
            a[c] === b[c] ? 0 : (a[c] > b[c] ? dir : -dir)));
          if (q._limit) data = data.slice(0, q._limit);
          if (q._single) {
            if (!data.length && q._single === 1) throw new Error('no rows returned');
            data = data[0] || null;
          }
        } else if (q._op === 'insert' || q._op === 'upsert') {
          const made = [];
          for (const raw of q._rows) {
            const row = { ...raw };
            if (!canWrite(table, row)) throw new Error('new row violates row-level security policy');
            let existing = null;
            if (q._op === 'upsert' && q._conflict) {
              const keys = q._conflict.split(',').map(s => s.trim());
              existing = T[table].find(r => keys.every(k => String(r[k]) === String(row[k])));
            }
            if (existing) { Object.assign(existing, row); made.push(existing); }
            else {
              row.id = row.id || uuid();
              row.created_at = row.created_at || new Date().toISOString();
              /* column defaults, as the real schema declares them */
              if ('archived' in (T[table][0] || {}) || ['products','tanks','nozzles','credit_customers'].includes(table))
                row.archived = row.archived ?? false;
              if (table === 'shifts') { row.closed = row.closed ?? false;
                ['cash','card','upi','bank','other_amount','other_cost'].forEach(k => row[k] = row[k] ?? 0); }
              if (table === 'business_days') { row.rates = row.rates ?? {};
                row.opening_cash = row.opening_cash ?? 0;
                row.cash_counted = row.cash_counted === undefined ? null : row.cash_counted; }
              if (table === 'tanks') row.current_stock = row.current_stock ?? 0;
              if (table === 'shifts') row.updated_at = new Date().toISOString();
              if (table === 'fuel_receipts') row.received_at = row.received_at || new Date().toISOString();
              if (table === 'dip_readings') row.taken_at = row.taken_at || new Date().toISOString();
              if (table === 'cash_deposits') row.deposited_at = row.deposited_at || new Date().toISOString();
              T[table].push(row);
              if (AFTER_INSERT[table]) AFTER_INSERT[table](row);
              made.push(row);
            }
          }
          data = q._single ? made[0] : made;
        } else if (q._op === 'update') {
          const hit = rowsOf(table).filter(r => visible(table, r)).filter(match).filter(r => canWrite(table, r));
          hit.forEach(r => Object.assign(r, q._patch));
          data = hit;
        } else if (q._op === 'delete') {
          const hit = rowsOf(table).filter(r => visible(table, r)).filter(match).filter(r => canWrite(table, r));
          hit.forEach(r => {
            if (AFTER_DELETE[table]) AFTER_DELETE[table](r);
            const i = T[table].indexOf(r); if (i >= 0) T[table].splice(i, 1);
          });
          data = hit;
        }
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    }
    return api;
  }

  const rpcs = {
    my_bunks: () => T.memberships.filter(m => m.user_id === me())
      .map(m => {
        const b = T.bunks.find(x => x.id === m.bunk_id);
        return b ? { id: b.id, name: b.name, brand: b.brand, place: b.place, role: m.role } : null;
      }).filter(Boolean),
    create_bunk: ({ p_name, p_brand, p_place, p_seed }) => {
      const b = { id: uuid(), name: p_name, brand: p_brand, place: p_place, created_by: me(),
        shift_names: ['Morning', 'Evening'],
        expense_heads: ['Salaries', 'Electricity', 'Maintenance', 'Bank / POS charges', 'Transport', 'Misc'],
        created_at: new Date().toISOString() };
      T.bunks.push(b);
      T.memberships.push({ bunk_id: b.id, user_id: me(), role: 'owner', created_at: new Date().toISOString() });
      if (p_seed !== false) {
        const mk = (code, name, short, sort) => {
          const p = { id: uuid(), bunk_id: b.id, code, name, short_name: short,
            sell_rate: 0, buy_rate: 0, sort_order: sort, archived: false };
          T.products.push(p); return p;
        };
        const ms = mk('ms', 'Petrol', 'MS', 1), hsd = mk('hsd', 'Diesel', 'HSD', 2), xp = mk('xp', 'XP-95 Premium', 'XP95', 3);
        const mt = (name, p, cap, min, sort) => {
          const t = { id: uuid(), bunk_id: b.id, name, product_id: p.id, capacity: cap,
            current_stock: 0, min_level: min, sort_order: sort, archived: false };
          T.tanks.push(t); return t;
        };
        const t1 = mt('Tank 1', ms, 12000, 1500, 1), t2 = mt('Tank 2', hsd, 20000, 2500, 2), t3 = mt('Tank 3', xp, 6000, 800, 3);
        [['DU-1 / N1', ms, t1], ['DU-1 / N2', hsd, t2], ['DU-2 / N3', ms, t1],
         ['DU-2 / N4', hsd, t2], ['DU-3 / N5', xp, t3]].forEach(([n, p, t], i) =>
          T.nozzles.push({ id: uuid(), bunk_id: b.id, name: n, product_id: p.id, tank_id: t.id, sort_order: i + 1, archived: false }));
      }
      return b.id;
    },
    add_member: ({ p_bunk, p_email, p_role }) => {
      const u = state.users.find(x => x.email.toLowerCase() === String(p_email).toLowerCase());
      if (!u) throw new Error('no BunkSoft account for ' + p_email);
      const ex = T.memberships.find(m => m.bunk_id === p_bunk && m.user_id === u.id);
      if (ex) ex.role = p_role;
      else T.memberships.push({ bunk_id: p_bunk, user_id: u.id, role: p_role, created_at: new Date().toISOString() });
      return true;
    }
  };

  return {
    from: builder,
    async rpc(name, args) {
      try { return { data: rpcs[name](args || {}), error: null }; }
      catch (e) { return { data: null, error: { message: e.message } }; }
    },
    auth: {
      getSession: async () => ({ data: { session: state.user ? { user: { id: state.user, email: state.email } } : null } }),
      getUser: async () => ({ data: { user: state.user ? { id: state.user, email: state.email } : null } }),
      signInWithPassword: async ({ email, password }) => {
        const u = state.users.find(x => x.email === email && x.password === password);
        if (!u) return { data: {}, error: { message: 'Invalid login credentials' } };
        state.user = u.id; state.email = u.email;
        if (!T.profiles.find(p => p.id === u.id)) T.profiles.push({ id: u.id, full_name: u.name || email.split('@')[0] });
        return { data: { session: { user: { id: u.id, email } } }, error: null };
      },
      signUp: async ({ email, password, options }) => {
        if (state.users.find(x => x.email === email)) return { data: {}, error: { message: 'User already registered' } };
        const u = { id: uuid(), email, password, name: options?.data?.full_name || '' };
        state.users.push(u);
        T.profiles.push({ id: u.id, full_name: u.name || email.split('@')[0] });
        state.user = u.id; state.email = email;
        return { data: { session: { user: { id: u.id, email } }, user: { id: u.id } }, error: null };
      },
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      signOut: async () => { state.user = null; state.email = ''; return { error: null }; },
      onAuthStateChange: (fn) => { state.onChange = fn; return { data: { subscription: { unsubscribe() {} } } }; }
    }
  };
}

export function createClient(_url, _key) {
  window.__T = window.__T || makeDb();
  window.__S = window.__S || { user: null, email: '', users: [] };
  return createFakeClient(window.__T, window.__S);
}
