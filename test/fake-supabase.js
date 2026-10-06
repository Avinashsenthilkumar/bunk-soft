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
  /* Matches reading_sold() and trg_reading_stock() in supabase/fixes.sql:
     a totalizer wrap is carried as litres, not floored away. */
  const sold = r => Math.max(0, (+r.closing_reading || 0) + (+r.rollover_add || 0)
                              - (+r.opening_reading || 0) - (+r.test_litres || 0));
  /* trg_reading_sane(): a reading that cannot be true is refused. */
  const saneReading = r => {
    const moved = (+r.closing_reading || 0) + (+r.rollover_add || 0) - (+r.opening_reading || 0);
    if (moved < 0) throw new Error('Closing reading is below the opening reading. Correct it, or record a meter rollover.');
    if ((+r.test_litres || 0) < 0) throw new Error('Test litres cannot be negative.');
    if ((+r.test_litres || 0) > moved) throw new Error('Test litres (' + r.test_litres +
      ') exceed the ' + moved + ' litres that passed this meter.');
  };
  const bumpTank = (id, delta) => {
    const t = T.tanks.find(x => x.id === id);
    if (t) t.current_stock = Math.round((+t.current_stock + delta) * 100) / 100;
  };

  const BEFORE_WRITE = { readings: saneReading };
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
  /* Mirrors is_bunk_member in admin.sql: membership AND an enabled bunk.
     A disabled bunk hides every row from everyone on it. */
  const bunkLive = id => { const b = T.bunks.find(x => x.id === id); return !!b && !b.disabled_at; };
  const myBunkIdsAny = () => T.memberships.filter(m => m.user_id === me()).map(m => m.bunk_id);
  const myBunkIds = () => myBunkIdsAny().filter(bunkLive);
  /* Mirrors profiles_read in admin.sql: yourself, and anyone on a bunk you
     belong to. Before that policy existed this was `r.id === me()`, which is
     why the team list could never show a colleague's name. */
  const sharesBunk = id => T.memberships.some(m =>
    m.user_id === id && myBunkIds().includes(m.bunk_id));
  const visible = (table, r) => {
    if (table === 'profiles') return r.id === me() || sharesBunk(r.id);
    /* bunks and memberships stay readable when disabled — see is_bunk_member_any */
    if (table === 'bunks') return myBunkIdsAny().includes(r.id);
    if (table === 'memberships') return myBunkIdsAny().includes(r.bunk_id);
    return !r.bunk_id || myBunkIds().includes(r.bunk_id);
  };
  const myRoleOn = b => (T.memberships.find(x => x.bunk_id === b && x.user_id === me()) || {}).role;
  const canWrite = (table, r) => {
    if (!myBunkIds().includes(r.bunk_id)) return false;
    if (['products', 'tanks', 'nozzles', 'bunks'].includes(table)) {
      const role = myRoleOn(r.bunk_id);
      return role === 'owner' || role === 'manager';
    }
    /* Mirrors can_manage_membership in admin.sql: an owner may do anything to
       the team; a manager may do anything that does not involve an owner. */
    if (table === 'memberships') {
      const role = myRoleOn(r.bunk_id);
      if (role === 'owner') return true;
      return role === 'manager' && r.role !== 'owner';
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
    const q = { _f: [], _sel: '*', _order: [], _limit: null, _single: 0, _range: null };
    const api = {
      select(sel) { q._sel = sel || '*'; return api; },
      eq(c, v) { q._f.push([c, '=', v]); return api; },
      in(c, vs) { q._f.push([c, 'in', (vs || []).map(String)]); return api; },
      gte(c, v) { q._f.push([c, '>=', v]); return api; },
      lte(c, v) { q._f.push([c, '<=', v]); return api; },
      order(c, o) { q._order.push([c, (o && o.ascending === false) ? -1 : 1]); return api; },
      limit(n) { q._limit = n; return api; },
      /* PostgREST pages with Range; db.js walks a report period with it */
      range(from, to) { q._range = [from, to]; return api; },
      single() { q._single = 1; return api; },
      maybeSingle() { q._single = 2; return api; },
      insert(rows) { q._op = 'insert'; q._rows = [].concat(rows); return api; },
      update(obj) { q._op = 'update'; q._patch = obj; return api; },
      upsert(rows, opt) { q._op = 'upsert'; q._rows = [].concat(rows); q._conflict = (opt && opt.onConflict) || ''; return api; },
      delete() { q._op = 'delete'; return api; },
      then(res, rej) { return exec().then(res, rej); }
    };

    const match = r => q._f.every(([c, op, v]) =>
      op === '='  ? String(r[c]) === String(v) :
      op === 'in' ? v.includes(String(r[c]))   :
      op === '>=' ? r[c] >= v : r[c] <= v);

    async function exec() {
      try {
        let data = null;
        if (!q._op) {
          data = rowsOf(table).filter(r => visible(table, r)).filter(match)
            .map(r => embed(table, r, q._sel));
          q._order.forEach(([c, dir]) => data.sort((a, b) =>
            a[c] === b[c] ? 0 : (a[c] > b[c] ? dir : -dir)));
          if (q._limit) data = data.slice(0, q._limit);
          if (q._range) data = data.slice(q._range[0], q._range[1] + 1);
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
            if (BEFORE_WRITE[table]) BEFORE_WRITE[table](row);
            if (existing) {
              /* an upsert over a reading moves stock twice unless the old
                 contribution is reversed first, as the real trigger does */
              if (table === 'readings' && AFTER_DELETE.readings) AFTER_DELETE.readings(existing);
              Object.assign(existing, row);
              if (table === 'readings' && AFTER_INSERT.readings) AFTER_INSERT.readings(existing);
              made.push(existing);
            }
            else {
              row.id = row.id || uuid();
              if (table === 'readings') row.rollover_add = row.rollover_add ?? 0;
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
          hit.forEach(r => {
            const next = { ...r, ...q._patch };
            if (BEFORE_WRITE[table]) BEFORE_WRITE[table](next);
            if (table === 'readings' && AFTER_DELETE.readings) AFTER_DELETE.readings(r);
            Object.assign(r, q._patch);
            if (table === 'readings' && AFTER_INSERT.readings) AFTER_INSERT.readings(r);
            /* shifts carry an updated_at the app uses to spot a second saver */
            if (table === 'shifts' && !('updated_at' in q._patch)) r.updated_at = new Date().toISOString();
          });
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
        return b ? { id: b.id, name: b.name, brand: b.brand, place: b.place,
                     role: m.role, disabled: !!b.disabled_at } : null;
      }).filter(Boolean),
    /* Since admin.sql, create_bunk() is not granted to a signed-in user.
       Fail the way Postgres does, so nothing in the app can quietly depend
       on a path that no longer exists in production. */
    create_bunk: () => { throw new Error('permission denied for function create_bunk'); },

    /* ---- supabase/fixes.sql ---- */
    /* The book figure is read on the server, so a stale browser cannot log the
       wrong gain or loss. */
    record_dip: ({ p_bunk, p_day, p_tank, p_dip }) => {
      if (!T.memberships.some(m => m.bunk_id === p_bunk && m.user_id === me()))
        throw new Error('You do not have permission to do that.');
      if (p_dip == null || +p_dip < 0) throw new Error('Enter the measured quantity.');
      const t = T.tanks.find(x => x.id === p_tank && x.bunk_id === p_bunk);
      if (!t) throw new Error('No such tank.');
      const book = +t.current_stock;
      const row = { id: uuid(), bunk_id: p_bunk, day: p_day, tank_id: p_tank,
        product_id: t.product_id, book_qty: book, dip_qty: +p_dip,
        taken_at: new Date().toISOString() };
      T.dip_readings.push(row);
      t.current_stock = +p_dip;
      return { id: row.id, book, dip: +p_dip, variation: +p_dip - book };
    },
    /* The closing each nozzle last carried before p_before, from the records. */
    last_closings: ({ p_bunk, p_before }) => {
      if (!T.memberships.some(m => m.bunk_id === p_bunk && m.user_id === me())) return [];
      const best = {};
      T.readings.filter(r => r.bunk_id === p_bunk).forEach(r => {
        const sh = T.shifts.find(x => x.id === r.shift_id);
        if (!sh || !(sh.day < p_before)) return;
        const key = sh.day + '\u0000' + (sh.closed_at || '') + '\u0000' + (sh.updated_at || '');
        const cur = best[r.nozzle_id];
        if (!cur || key > cur.key) best[r.nozzle_id] = { key, closing: +r.closing_reading, day: sh.day };
      });
      return Object.entries(best).map(([nozzle_id, v]) =>
        ({ nozzle_id, closing: v.closing, day: v.day }));
    },
    add_member: ({ p_bunk, p_email, p_role }) => {
      const u = state.users.find(x => x.email.toLowerCase() === String(p_email).toLowerCase());
      if (!u) throw new Error('no BunkSoft account for ' + p_email);
      const ex = T.memberships.find(m => m.bunk_id === p_bunk && m.user_id === u.id);
      if (ex) ex.role = p_role;
      else T.memberships.push({ bunk_id: p_bunk, user_id: u.id, role: p_role, created_at: new Date().toISOString() });
      return true;
    },

    /* ---------------------------------------------------------------------
       The platform administration layer, mirroring supabase/admin.sql.
       Every one of these begins with the same check the SQL does, so the
       tests can prove the refusal as well as the happy path.
       ------------------------------------------------------------------- */
    admin_whoami: () => {
      const u = state.users.find(x => x.id === me());
      return { user_id: me(), email: u ? u.email : null, name: u ? u.name : null,
               is_admin: isAdmin() };
    },

    admin_businesses: () => {
      if (!isAdmin()) return [];
      return T.bunks.map(b => {
        const own = T.memberships.find(m => m.bunk_id === b.id && m.role === 'owner');
        const u = own ? state.users.find(x => x.id === own.user_id) : null;
        return {
          bunk_id: b.id, name: b.name, brand: b.brand, place: b.place, created_at: b.created_at,
          owner_name: u ? u.name : null, owner_email: u ? u.email : null, owner_id: u ? u.id : null,
          owner_suspended: !!(u && u.suspended),
          disabled: !!b.disabled_at,
          staff_count: T.memberships.filter(m => m.bunk_id === b.id).length,
          days_recorded: T.business_days.filter(d => d.bunk_id === b.id).length,
          shifts_recorded: T.shifts.filter(s => s.bunk_id === b.id).length,
          last_activity: b.created_at
        };
      }).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    },

    admin_accounts: () => {
      if (!isAdmin()) return [];
      return state.users.map(u => ({
        user_id: u.id, email: u.email, full_name: u.name || null, phone: u.phone || null,
        created_at: u.created_at || new Date().toISOString(), last_sign_in_at: u.last_sign_in_at || null,
        confirmed: true, suspended: !!u.suspended, is_admin: state.admins.includes(u.id),
        bunks: T.memberships.filter(m => m.user_id === u.id).map(m => {
          const b = T.bunks.find(x => x.id === m.bunk_id);
          return b ? { bunk_id: b.id, name: b.name, role: m.role } : null;
        }).filter(Boolean)
      })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    },

    admin_stats: () => isAdmin() ? {
      businesses: T.bunks.length, accounts: state.users.length,
      suspended: state.users.filter(u => u.suspended).length,
      admins: state.admins.length,
      disabled_bunks: T.bunks.filter(b => b.disabled_at).length,
      active_this_week: new Set(T.shifts.map(s => s.bunk_id)).size,
      shifts_this_week: T.shifts.length, signed_up_today: 0
    } : null,

    admin_audit_log: ({ p_limit } = {}) => isAdmin()
      ? state.audit.slice().reverse().slice(0, p_limit || 200) : [],

    admin_create_login: ({ p_email, p_password, p_full_name, p_phone }) =>
      makeLogin(p_email, p_password, p_full_name, p_phone),

    admin_create_business: ({ p_bunk_name, p_email, p_password, p_owner_name, p_brand, p_place, p_phone, p_seed }) => {
      needAdmin();
      if (!String(p_bunk_name || '').trim()) throw new Error('The bunk needs a name.');
      const uid = makeLogin(p_email, p_password, p_owner_name, p_phone);
      const bunk = seedBunk(String(p_bunk_name).trim(), p_brand, p_place, uid, p_seed !== false);
      log('create_business', String(p_bunk_name).trim(), { owner: norm(p_email) });
      return { user_id: uid, bunk_id: bunk.id, email: norm(p_email), bunk: bunk.name };
    },

    admin_create_staff: ({ p_bunk, p_email, p_password, p_role, p_full_name, p_phone }) => {
      needAdmin();
      const b = T.bunks.find(x => x.id === p_bunk);
      if (!b) throw new Error('No such bunk.');
      const uid = makeLogin(p_email, p_password, p_full_name, p_phone);
      setMember(p_bunk, uid, p_role);
      log('create_staff', norm(p_email), { bunk: b.name, role: p_role });
      return { user_id: uid, email: norm(p_email), bunk: b.name, role: p_role };
    },

    admin_set_bunk_disabled: ({ p_bunk, p_disabled }) => {
      needAdmin();
      const b = T.bunks.find(x => x.id === p_bunk);
      if (!b) throw new Error('No such bunk.');
      b.disabled_at = p_disabled ? new Date().toISOString() : null;
      log(p_disabled ? 'disable_bunk' : 'enable_bunk', b.name, {});
      return true;
    },

    admin_set_password: ({ p_user, p_password }) => {
      needAdmin(); checkPassword(p_password);
      const u = state.users.find(x => x.id === p_user);
      if (!u) throw new Error('No such account.');
      if (state.admins.includes(p_user) && p_user !== me())
        throw new Error('Another administrator must change their own password.');
      u.password = p_password;
      log('set_password', u.email, {});
      return true;
    },

    admin_set_suspended: ({ p_user, p_suspended }) => {
      needAdmin();
      const u = state.users.find(x => x.id === p_user);
      if (!u) throw new Error('No such account.');
      if (p_user === me()) throw new Error('You cannot suspend your own account.');
      if (p_suspended && state.admins.includes(p_user))
        throw new Error('Remove administrator access before suspending that account.');
      u.suspended = !!p_suspended;
      log(p_suspended ? 'suspend' : 'reactivate', u.email, {});
      return true;
    },

    admin_delete_account: ({ p_user, p_confirm_email }) => {
      needAdmin();
      const u = state.users.find(x => x.id === p_user);
      if (!u) throw new Error('No such account.');
      if (norm(p_confirm_email) !== norm(u.email))
        throw new Error('Type the account email exactly to confirm deletion.');
      if (p_user === me()) throw new Error('You cannot delete your own account.');
      if (state.admins.includes(p_user))
        throw new Error('Revoke administrator access before deleting that account.');
      log('delete_account', u.email, {});
      state.users.splice(state.users.indexOf(u), 1);
      T.memberships = T.memberships.filter(m => m.user_id !== p_user);
      return true;
    },

    admin_set_member: ({ p_bunk, p_user, p_role }) => {
      needAdmin();
      const u = state.users.find(x => x.id === p_user), b = T.bunks.find(x => x.id === p_bunk);
      if (!u || !b) throw new Error('No such account or bunk.');
      setMember(p_bunk, p_user, p_role);
      log('set_member', u.email, { bunk: b.name, role: p_role });
      return true;
    },

    admin_remove_member: ({ p_bunk, p_user }) => {
      needAdmin();
      const u = state.users.find(x => x.id === p_user), b = T.bunks.find(x => x.id === p_bunk);
      T.memberships = T.memberships.filter(m => !(m.bunk_id === p_bunk && m.user_id === p_user));
      log('remove_member', u ? u.email : p_user, { bunk: b ? b.name : '' });
      return true;
    },

    admin_delete_bunk: ({ p_bunk, p_confirm_name }) => {
      needAdmin();
      const b = T.bunks.find(x => x.id === p_bunk);
      if (!b) throw new Error('No such bunk.');
      if (norm(p_confirm_name) !== norm(b.name))
        throw new Error('Type the bunk name exactly to confirm deletion.');
      log('delete_bunk', b.name, {});
      T.bunks.splice(T.bunks.indexOf(b), 1);
      ['memberships','products','tanks','nozzles','business_days','shifts','readings',
       'credit_customers','credit_txns','fuel_receipts','dip_readings','expenses','cash_deposits']
        .forEach(t => { T[t] = T[t].filter(r => r.bunk_id !== p_bunk); });
      return true;
    },

    admin_grant_admin: ({ p_email, p_note }) => {
      needAdmin();
      const u = state.users.find(x => norm(x.email) === norm(p_email));
      if (!u) throw new Error('No BunkSoft account for ' + norm(p_email) + '.');
      if (!state.admins.includes(u.id)) state.admins.push(u.id);
      log('grant_admin', u.email, { note: p_note || '' });
      return true;
    },

    admin_revoke_admin: ({ p_user }) => {
      needAdmin();
      if (p_user === me()) throw new Error('You cannot revoke your own administrator access.');
      if (state.admins.length <= 1) throw new Error('There must always be at least one administrator.');
      const u = state.users.find(x => x.id === p_user);
      state.admins = state.admins.filter(id => id !== p_user);
      log('revoke_admin', u ? u.email : p_user, {});
      return true;
    }
  };

  /* ---- shared by the admin RPCs above ---- */
  const norm = e => String(e || '').trim().toLowerCase();
  const isAdmin = () => !!me() && state.admins.includes(me());
  function needAdmin() {
    if (!me()) throw new Error('Sign in first.');
    if (!isAdmin()) throw new Error('Administrator access required.');
  }
  function checkPassword(p) {
    if (!p || String(p).length < 10) throw new Error('Password must be at least 10 characters.');
    if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p))
      throw new Error('Password must contain both letters and digits.');
  }
  function log(action, target, detail) {
    const u = state.users.find(x => x.id === me());
    state.audit.push({ at: new Date().toISOString(), actor_email: u ? u.email : null,
                       action, target, detail: detail || {} });
  }
  function makeLogin(email, password, name, phone) {
    needAdmin();
    const e = norm(email);
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e)) throw new Error('That is not a valid email address.');
    checkPassword(password);
    if (state.users.some(u => norm(u.email) === e)) throw new Error('An account already exists for ' + e + '.');
    const u = { id: uuid(), email: e, password, name: name || e.split('@')[0], phone: phone || null,
                created_at: new Date().toISOString(), suspended: false };
    state.users.push(u);
    T.profiles.push({ id: u.id, full_name: u.name });
    log('create_login', e, { name: name || '' });
    return u.id;
  }
  function setMember(bunkId, userId, role) {
    const ex = T.memberships.find(m => m.bunk_id === bunkId && m.user_id === userId);
    if (ex) ex.role = role;
    else T.memberships.push({ bunk_id: bunkId, user_id: userId, role,
                              created_at: new Date().toISOString() });
  }
  function seedBunk(name, brand, place, ownerId, seed) {
    const b = { id: uuid(), name, brand: brand || null, place: place || null, created_by: ownerId,
      shift_names: ['Morning', 'Evening'],
      expense_heads: ['Salaries', 'Electricity', 'Maintenance', 'Bank / POS charges', 'Transport', 'Misc'],
      created_at: new Date().toISOString() };
    T.bunks.push(b);
    setMember(b.id, ownerId, 'owner');
    if (seed) {
      const mk = (code, nm, short, sort) => {
        const p = { id: uuid(), bunk_id: b.id, code, name: nm, short_name: short,
          sell_rate: 0, buy_rate: 0, sort_order: sort, archived: false };
        T.products.push(p); return p;
      };
      const ms = mk('ms','Petrol','MS',1), hsd = mk('hsd','Diesel','HSD',2), xp = mk('xp','XP-95 Premium','XP95',3);
      const mt = (nm, p, cap, min, sort) => {
        const t = { id: uuid(), bunk_id: b.id, name: nm, product_id: p.id, capacity: cap,
          current_stock: 0, min_level: min, sort_order: sort, archived: false };
        T.tanks.push(t); return t;
      };
      const t1 = mt('Tank 1', ms, 12000, 1500, 1), t2 = mt('Tank 2', hsd, 20000, 2500, 2),
            t3 = mt('Tank 3', xp, 6000, 800, 3);
      [['DU-1 / N1', ms, t1], ['DU-1 / N2', hsd, t2], ['DU-2 / N3', ms, t1],
       ['DU-2 / N4', hsd, t2], ['DU-3 / N5', xp, t3]].forEach(([n, p, t], i) =>
        T.nozzles.push({ id: uuid(), bunk_id: b.id, name: n, product_id: p.id, tank_id: t.id,
                         sort_order: i + 1, archived: false }));
    }
    return b;
  }

  /* The harness navigates between the app and the admin console, which would
     otherwise wipe these in-memory tables. Park them in sessionStorage so one
     page's work is still there on the next.

     Defined and published BEFORE the return below — after it, the assignment
     would be unreachable and every write made through rpc() or from() would
     be lost on the next navigation. */
  function save() {
    try {
      sessionStorage.setItem('__fakedb', JSON.stringify(T));
      sessionStorage.setItem('__fakestate', JSON.stringify({
        users: state.users, admins: state.admins, audit: state.audit
      }));
    } catch {}
  }
  __save = save;

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
        const u = state.users.find(x => x.email === String(email).toLowerCase() && x.password === password);
        if (!u) return { data: {}, error: { message: 'Invalid login credentials' } };
        /* A suspended account is refused, the way GoTrue refuses a banned one. */
        if (u.suspended) return { data: {}, error: { message: 'User is banned' } };
        u.last_sign_in_at = new Date().toISOString();
        state.user = u.id; state.email = u.email;
        if (!T.profiles.find(p => p.id === u.id))
          T.profiles.push({ id: u.id, full_name: u.name || u.email.split('@')[0] });
        save();
        return { data: { session: { user: { id: u.id, email: u.email } } }, error: null };
      },
      /* No signUp(). Self sign-up is gone from the product, so the fake must
         not offer a door the real backend has bricked up. */
      updateUser: async ({ password }) => {
        const u = state.users.find(x => x.id === state.user);
        if (!u) return { data: {}, error: { message: 'Not signed in' } };
        if (!password || password.length < 10)
          return { data: {}, error: { message: 'Password should be at least 10 characters' } };
        u.password = password; save();
        return { data: { user: { id: u.id } }, error: null };
      },
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      signOut: async () => { state.user = null; state.email = ''; save(); return { error: null }; },
      onAuthStateChange: (fn) => { state.onChange = fn; return { data: { subscription: { unsubscribe() {} } } }; }
    }
  };

}

let __save = () => {};

/* One signed-in session per storageKey, the way two Supabase clients on the
   same origin behave. Without this the admin console and the bunk app would
   appear to share a login — exactly what the real build prevents, so the fake
   must not paper over it. */
function sessionSlot(key) {
  const k = '__fakesess:' + key;
  return {
    get() { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } },
    set(v) { try { v ? sessionStorage.setItem(k, JSON.stringify(v)) : sessionStorage.removeItem(k); } catch {} }
  };
}

export function createClient(_url, _key, opts) {
  const storageKey = (opts && opts.auth && opts.auth.storageKey) || 'sb-default';

  /* Tables and the account directory are shared — there is one database. */
  if (!window.__T) {
    let t = null, s = null;
    try {
      t = JSON.parse(sessionStorage.getItem('__fakedb') || 'null');
      s = JSON.parse(sessionStorage.getItem('__fakestate') || 'null');
    } catch {}
    window.__T = t || makeDb();
    window.__DIR = s || {};
    window.__DIR.users  = window.__DIR.users  || [];
    window.__DIR.admins = window.__DIR.admins || [];
    window.__DIR.audit  = window.__DIR.audit  || [];
  }
  const dir = window.__DIR;
  const slot = sessionSlot(storageKey);

  /* Shared directory, private session. */
  const state = { users: dir.users, admins: dir.admins, audit: dir.audit, onChange: null };
  Object.defineProperty(state, 'user', {
    get: () => (slot.get() || {}).id || null,
    set: v => { const s = slot.get() || {}; slot.set(v ? { id: v, email: s.email || '' } : null); }
  });
  Object.defineProperty(state, 'email', {
    get: () => (slot.get() || {}).email || '',
    set: v => { const s = slot.get() || {}; slot.set(s.id ? { id: s.id, email: v } : null); }
  });
  window.__S = state;

  const client = createFakeClient(window.__T, state);

  /* Persist after every call, so a navigation never loses a write. */
  const wrap = obj => new Proxy(obj, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      return (...a) => {
        const r = v.apply(t, a);
        __save();
        return (r && typeof r.then === 'function') ? r.then(x => { __save(); return x; }) : r;
      };
    }
  });
  return {
    ...client,
    auth: wrap(client.auth),
    rpc: (...a) => client.rpc(...a).then(r => { __save(); return r; }),
    from: (t) => {
      const bld = client.from(t);
      const th = bld.then.bind(bld);
      bld.then = (res, rej) => th(x => { __save(); return x; }, rej).then(res, rej);
      return bld;
    }
  };
}
