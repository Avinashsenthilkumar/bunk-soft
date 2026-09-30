/* ============================================================================
   BunkSoft Admin Console
   Subsel Tech Solutions Pvt Ltd

   A separate page from the bunk application, with a separate session. This is
   where Subsel creates the login for each bunk that buys the software.

   Security notes, since this is the sensitive page in the project:

   - There is no secret in this file. Creating a login would normally need the
     Supabase `service_role` key; that key bypasses every policy and must never
     be served to a browser. Instead the work happens in `security definer`
     functions in the database (supabase/admin.sql), each of which checks
     `is_platform_admin()` first. The worst an attacker can do with this file
     is call functions that refuse them.

   - The gate below is convenience, not protection. A bunk owner who finds this
     URL and signs in sees a refusal because admin_whoami() says they are not
     an administrator — but even if they patched this JavaScript to skip that
     check, every call would still fail in the database. The interface hides
     nothing that the server does not also refuse.

   - The session lives in sessionStorage under its own key, so closing the tab
     ends it, and an admin session can never be confused with a bunk session
     in the same browser.
   ========================================================================== */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const cfg = window.BUNKSOFT_CONFIG || {};
const URL_OK = /^https:\/\/[a-z0-9-]{1,64}\.supabase\.(co|in)$/i;
const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && URL_OK.test(cfg.supabaseUrl));

/* Sign the administrator out after this long without a click or a keystroke. */
const IDLE_LIMIT_MS = 20 * 60 * 1000;

const gate  = document.getElementById('gate');
const shell = document.getElementById('shell');
const view  = document.getElementById('aview');
const layer = document.getElementById('alayer');
const toastEl = document.getElementById('atoast');

let sb = null;
let me = null;                       /* {user_id, email, name, is_admin} */
let tab = 'overview';
let data = { stats: null, businesses: [], accounts: [], audit: [] };
let busy = false;
/* Set by a create/reset, read once by the next render(). */
let pendingHandover = null;

/* ------------------------------------------------------------- helpers -- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function toast(msg, bad) {
  toastEl.textContent = msg;
  toastEl.className = 'atoast' + (bad ? ' bad' : '');
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, bad ? 6500 : 3800);
}

function dmy(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return String(d.getDate()).padStart(2, '0') + ' ' +
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' +
    d.getFullYear();
}
function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (isNaN(s)) return '—';
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' hr ago';
  if (s < 2592000) return Math.round(s / 86400) + ' days ago';
  return dmy(iso);
}

/* Readable words for the messages the database and auth service return. */
function human(e) {
  const m = String((e && e.message) || e || '');
  if (/Administrator access required/i.test(m)) return 'Administrator access required.';
  if (/invalid login credentials/i.test(m)) return 'That email and password do not match.';
  if (/banned|blocked/i.test(m)) return 'That account is suspended.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
  if (/failed to fetch|network/i.test(m)) return 'No connection to the server.';
  if (/JWT|session/i.test(m)) return 'Your session expired. Sign in again.';
  return m || 'Something went wrong.';
}

/* A password worth handing over: long, mixed, and free of the characters
   people misread when copying it off a slip of paper. */
function suggestPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   /* no I, O */
  const lower = 'abcdefghijkmnopqrstuvwxyz';   /* no l */
  const digit = '23456789';                    /* no 0, 1 */
  const all = upper + lower + digit;
  const pick = set => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const out = [pick(upper), pick(lower), pick(digit), pick(digit)];
  while (out.length < 14) out.push(pick(all));
  /* Fisher-Yates with real randomness, so the fixed positions above do not
     make the first four characters predictable in shape. */
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast((label || 'Copied') + ' copied.'); }
  catch { toast('Could not reach the clipboard — select and copy by hand.', true); }
}

/* Wrap every mutating call: one at a time, refresh after, report clearly. */
async function act(fn, okMsg) {
  if (busy) return;
  busy = true;
  $$('.btn, .abtn').forEach(b => b.disabled = true);
  try {
    await fn();
    await load();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(human(e), true);
  } finally {
    busy = false;
    $$('.btn, .abtn').forEach(b => b.disabled = false);
    render();
  }
}

/* ---------------------------------------------------------------- rpc --- */
async function rpc(name, args) {
  const { data: d, error } = await sb.rpc(name, args || {});
  if (error) throw new Error(error.message);
  return d;
}

/* --------------------------------------------------------------- theme -- */
try {
  const t = localStorage.getItem('bunksoft.theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
} catch {}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
    : (matchMedia('(prefers-color-scheme:dark)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('bunksoft.theme', next); } catch {}
}

/* =========================== sign-in screens ============================ */
const authCard = (title, sub, body, foot) => `
  <div class="authwrap">
    <div class="authbrand">
      <span class="amark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l7.5 3.5v5c0 4.3-3.1 8.2-7.5 9.5-4.4-1.3-7.5-5.2-7.5-9.5v-5z"/><path d="M9.3 12.2l1.9 1.9 3.6-3.7"/>
        </svg>
      </span>
      <span class="atitle">Bunk<i>Soft</i><b>Admin Console</b></span>
    </div>
    <div class="authcard">
      <h1>${title}</h1>
      ${sub ? `<p class="authsub">${sub}</p>` : ''}
      ${body}
    </div>
    ${foot ? `<div class="authfoot">${foot}</div>` : ''}
    <div class="authcredit">Subsel Tech Solutions Pvt Ltd · staff access only</div>
  </div>`;

function showGate(html) { shell.hidden = true; gate.hidden = false; gate.innerHTML = html; }

function screenNotConfigured() {
  showGate(authCard('Not configured',
    'This deployment has no database details baked in.',
    `<p class="authnote">Fill in <code>web/js/config.js</code> with the Supabase project URL and anon
     key, then deploy again. The admin console deliberately will not accept them typed in here —
     an administration page should never be pointed at an arbitrary database.</p>`));
}

function screenSignIn(message) {
  showGate(authCard('Administrator sign-in',
    'For Subsel Tech Solutions staff. Bunk owners and operators sign in on the main app.',
    `${message ? `<div class="autherr">${esc(message)}</div>` : ''}
     <label class="f"><span>Email</span><input type="email" id="ai_email" autocomplete="username"
       inputmode="email" autocapitalize="none" spellcheck="false"></label>
     <label class="f"><span>Password</span><input type="password" id="ai_pass" autocomplete="current-password"></label>
     <button class="btn wide" id="ai_go">Sign in</button>`,
    'This page is not indexed and is not linked from the app.'));

  const go = async () => {
    const email = $('#ai_email').value, pass = $('#ai_pass').value;
    if (!email || !pass) return screenSignIn('Enter your email and password.');
    const b = $('#ai_go'); b.disabled = true; b.textContent = 'Signing in…';
    try {
      const { error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password: pass });
      if (error) return screenSignIn(human(error));
    } catch (e) { return screenSignIn(human(e)); }
    boot();
  };
  $('#ai_go').onclick = go;
  $('#ai_email').onkeydown = e => { if (e.key === 'Enter') $('#ai_pass').focus(); };
  $('#ai_pass').onkeydown = e => { if (e.key === 'Enter') go(); };
}

/* Signed in, but not an administrator. Say so plainly and end the session —
   leaving it open on this page invites someone to keep poking at it. */
function screenRefused(email) {
  showGate(authCard('Not an administrator',
    `The account <b>${esc(email || '')}</b> is signed in, but it is not a BunkSoft administrator.`,
    `<p class="authnote">This console manages BunkSoft accounts for Subsel Tech Solutions.
     If you run a petrol bunk, your records are in the main app, not here.</p>
     <a class="btn wide" href="/" style="display:block;text-align:center;text-decoration:none">Go to the BunkSoft app</a>
     <button class="linkbtn" id="ar_out">Sign out of this account</button>`));
  $('#ar_out').onclick = async () => { await sb.auth.signOut(); screenSignIn(''); };
  /* Drop the session after a moment so a walk-away does not leave it live. */
  setTimeout(() => { sb.auth.signOut().catch(() => {}); }, 30000);
}

/* ============================== idle timeout ============================ */
let idleAt = Date.now(), idleTimer = null, idleBound = false;
function bumpIdle() { idleAt = Date.now(); }
function startIdleWatch() {
  /* Signing out and back in must not stack another set of listeners. */
  if (!idleBound) {
    ['click', 'keydown', 'pointerdown', 'wheel'].forEach(ev =>
      addEventListener(ev, bumpIdle, { passive: true }));
    idleBound = true;
  }
  clearInterval(idleTimer);
  idleTimer = setInterval(async () => {
    const left = IDLE_LIMIT_MS - (Date.now() - idleAt);
    const el = $('#a_idle');
    if (left <= 0) {
      clearInterval(idleTimer);
      await sb.auth.signOut().catch(() => {});
      me = null;
      screenSignIn('Signed out after 20 minutes of inactivity.');
      return;
    }
    if (el) el.textContent = left < 5 * 60 * 1000
      ? `signing out in ${Math.ceil(left / 60000)} min without activity`
      : 'auto sign-out after 20 min idle';
  }, 15000);
}

/* ================================ loading =============================== */
async function load() {
  const [stats, businesses, accounts, audit] = await Promise.all([
    rpc('admin_stats'),
    rpc('admin_businesses'),
    rpc('admin_accounts'),
    rpc('admin_audit_log', { p_limit: 250 })
  ]);
  data = {
    stats: stats || {},
    businesses: businesses || [],
    accounts: accounts || [],
    audit: audit || []
  };
}

/* ================================ views ================================= */
const TABS = [
  ['overview',  'Overview'],
  ['business',  'Businesses'],
  ['accounts',  'Accounts'],
  ['admins',    'Administrators'],
  ['activity',  'Activity']
];

function render() {
  if (!me || !me.is_admin) return;
  gate.hidden = true; gate.innerHTML = '';
  shell.hidden = false;

  $('#atabs').innerHTML = TABS.map(([k, label]) =>
    `<button class="atab" data-tab="${k}" aria-current="${k === tab}">${esc(label)}
      ${k === 'business' ? `<span class="pill ac">${data.businesses.length}</span>` : ''}</button>`).join('');
  $('#awho').textContent = (me.name ? me.name + ' · ' : '') + (me.email || '');

  view.innerHTML =
      tab === 'overview' ? vOverview()
    : tab === 'business' ? vBusinesses()
    : tab === 'accounts' ? vAccounts()
    : tab === 'admins'   ? vAdmins()
    :                      vActivity();

  /* A handover card outlives the re-render that follows creating an account —
     the administrator still has to read the password off it. */
  if (pendingHandover) {
    const host = $('#' + pendingHandover.into) || view;
    host.innerHTML = handover(pendingHandover.title, pendingHandover.rows);
    host.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pendingHandover = null;
  }

  wire();
}

/* --------------------------------------------------------- overview ----- */
function vOverview() {
  const s = data.stats || {};
  const recent = data.businesses.slice(0, 6);
  return `
  <div class="stats">
    ${stat('Businesses', s.businesses ?? 0, 'bunks on the platform')}
    ${stat('Active this week', s.active_this_week ?? 0, 'entered a shift in 7 days')}
    ${stat('Accounts', s.accounts ?? 0, 'logins in total')}
    ${stat('Suspended', s.suspended ?? 0, 'blocked from signing in')}
    ${stat('Shifts this week', s.shifts_this_week ?? 0, 'across every bunk')}
    ${stat('Administrators', s.admins ?? 0, 'Subsel staff with access')}
  </div>

  <div class="p">
    <div class="ph"><h2>Add a business</h2><span class="hint">creates the owner's login and their bunk in one step</span></div>
    <div class="pb">${formNewBusiness()}</div>
  </div>

  <div class="p">
    <div class="ph"><h2>Newest businesses</h2><span class="grow"></span>
      <button class="linkbtn" data-tab="business">See all ${data.businesses.length}</button></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Bunk</th><th>Owner</th><th>Added</th><th>Last used</th></tr></thead>
      <tbody>${recent.map(b => `<tr>
        <td><div class="name">${esc(b.name)}</div><div class="sub">${esc([b.brand, b.place].filter(Boolean).join(' · ') || '—')}</div></td>
        <td><div>${esc(b.owner_name || '—')}</div><div class="sub">${esc(b.owner_email || '—')}</div></td>
        <td class="sub">${dmy(b.created_at)}</td>
        <td class="sub">${ago(b.last_activity)}</td></tr>`).join('')
        || `<tr><td colspan="4" class="empty">No businesses yet. Add the first one above.</td></tr>`}
      </tbody></table></div></div>
  </div>

  <div class="note">
    Being an administrator does not let you read a customer's sales, cash, credit or expense figures —
    row-level security keeps every bunk sealed, including from this console. What you see here is who the
    customers are and how much they use the software.
  </div>`;
}

const stat = (k, v, s) => `<div class="stat"><div class="k">${esc(k)}</div>
  <div class="v">${esc(String(v))}</div><div class="s">${esc(s)}</div></div>`;

function formNewBusiness() {
  return `
  <div class="fr">
    <label class="f"><span>Bunk name</span><input type="text" id="nb_bunk" placeholder="Sri Balaji Fuels"></label>
    <label class="f"><span>Oil company</span><input type="text" id="nb_brand" placeholder="Indian Oil / BPCL / HPCL"></label>
    <label class="f"><span>Location</span><input type="text" id="nb_place" placeholder="Thanjavur, Tamil Nadu"></label>
  </div>
  <div class="fr" style="margin-top:12px">
    <label class="f"><span>Owner's name</span><input type="text" id="nb_name" placeholder="R Balaji"></label>
    <label class="f"><span>Owner's email — this is their username</span>
      <input type="email" id="nb_email" placeholder="balaji@example.com" inputmode="email"
             autocapitalize="none" spellcheck="false"></label>
    <label class="f"><span>Phone <i class="sub">(optional)</i></span><input type="text" id="nb_phone" placeholder="98765 43210"></label>
  </div>
  <div class="fr" style="margin-top:12px">
    <label class="f"><span>Password to hand over</span>
      <input type="text" id="nb_pass" value="${esc(suggestPassword())}" spellcheck="false">
      <span class="sub">At least 10 characters, with letters and digits. They can change it after signing in.</span></label>
    <div class="row">
      <button class="btn ghost sm" data-act="regen">New password</button>
      <button class="btn" data-act="createbusiness">Create the business</button>
    </div>
  </div>
  <div id="nb_out" style="margin-top:14px"></div>`;
}

/* The one moment the password is visible. Shown until dismissed, because the
   administrator has to get it to the customer before it disappears. */
function handover(title, rows, note) {
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return `<div class="handover">
    <h3>${esc(title)}</h3>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="row">
      <button class="btn sm" data-act="copyblock" data-text="${esc(text)}">Copy all</button>
      <button class="btn ghost sm" data-act="dismiss">Done</button>
    </div>
    <div class="sub">${esc(note || 'This password is shown once. It is stored only as a hash, so it cannot be read back — if it is lost, set a new one.')}</div>
  </div>`;
}

/* -------------------------------------------------------- businesses --- */
function vBusinesses() {
  return `
  <div class="p">
    <div class="ph"><h2>Businesses</h2><span class="hint">${data.businesses.length} on the platform</span>
      <span class="grow"></span>
      <input type="search" id="bq" placeholder="Search name, owner, town…" style="padding:7px 11px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel)">
    </div>
    <div class="pb tight"><div class="tw"><table class="t-bus">
      <thead><tr><th>Bunk</th><th>Owner</th><th class="r">Staff</th><th class="r">Days</th>
        <th>Last used</th><th>Status</th><th class="r">Actions</th></tr></thead>
      <tbody id="btbody">${rowsBusinesses(data.businesses)}</tbody>
    </table></div></div>
  </div>

  <div class="p">
    <div class="ph"><h2>Add a business</h2></div>
    <div class="pb">${formNewBusiness()}</div>
  </div>`;
}

function rowsBusinesses(list) {
  if (!list.length) return `<tr><td colspan="7" class="empty">No businesses match.</td></tr>`;
  return list.map(b => `<tr>
    <td><div class="name">${esc(b.name)}</div>
        <div class="sub">${esc([b.brand, b.place].filter(Boolean).join(' · ') || '—')}</div></td>
    <td><div>${esc(b.owner_name || '—')}</div><div class="sub">${esc(b.owner_email || 'no owner')}</div></td>
    <td class="r num">${b.staff_count ?? 0}</td>
    <td class="r num">${b.days_recorded ?? 0}</td>
    <td class="sub">${ago(b.last_activity)}</td>
    <td>${b.owner_suspended
          ? '<span class="pill bad">suspended</span>'
          : (b.days_recorded > 0 ? '<span class="pill ok">active</span>' : '<span class="pill wr">not started</span>')}</td>
    <td class="r"><div class="acts">
      <button class="btn ghost sm" data-act="team" data-id="${esc(b.bunk_id)}">Team (${b.staff_count ?? 0})</button>
      ${b.owner_id ? `<button class="btn ghost sm" data-act="resetpw" data-id="${esc(b.owner_id)}"
          data-email="${esc(b.owner_email || '')}">Reset password</button>
        <button class="btn ghost sm" data-act="suspend" data-id="${esc(b.owner_id)}"
          data-email="${esc(b.owner_email || '')}" data-on="${b.owner_suspended ? '0' : '1'}">
          ${b.owner_suspended ? 'Reactivate' : 'Suspend'}</button>` : ''}
      <button class="btn danger sm" data-act="delbunk" data-id="${esc(b.bunk_id)}" data-name="${esc(b.name)}">Remove</button>
    </div></td></tr>`).join('');
}

/* ---------------------------------------------------------- accounts --- */
function vAccounts() {
  return `
  <div class="p">
    <div class="ph"><h2>Accounts</h2><span class="hint">every login on the platform</span>
      <span class="grow"></span>
      <input type="search" id="aq" placeholder="Search email or name…" style="padding:7px 11px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel)">
    </div>
    <div class="pb tight"><div class="tw"><table class="t-acct">
      <thead><tr><th>Account</th><th>Bunks</th><th>Added</th><th>Last sign-in</th>
        <th>Status</th><th class="r">Actions</th></tr></thead>
      <tbody id="atbody">${rowsAccounts(data.accounts)}</tbody>
    </table></div></div>
  </div>

  <div class="p">
    <div class="ph"><h2>Add a login on its own</h2>
      <span class="hint">for staff you will attach to a bunk afterwards</span></div>
    <div class="pb">
      <div class="fr">
        <label class="f"><span>Name</span><input type="text" id="nl_name" placeholder="M Raja"></label>
        <label class="f"><span>Email — their username</span><input type="email" id="nl_email"
          inputmode="email" autocapitalize="none" spellcheck="false" placeholder="raja@example.com"></label>
        <label class="f"><span>Password</span><input type="text" id="nl_pass" spellcheck="false"
          value="${esc(suggestPassword())}"></label>
        <label class="f"><span>Attach to a bunk</span><select id="nl_bunk">
          <option value="">— not yet —</option>
          ${data.businesses.map(b => `<option value="${esc(b.bunk_id)}">${esc(b.name)}</option>`).join('')}
        </select></label>
        <label class="f"><span>Role on that bunk</span><select id="nl_role">
          <option value="operator">Operator</option>
          <option value="manager">Manager</option>
          <option value="owner">Owner</option>
        </select></label>
        <div class="row">
          <button class="btn ghost sm" data-act="regen2">New password</button>
          <button class="btn" data-act="createlogin">Create the login</button>
        </div>
      </div>
      <div id="nl_out" style="margin-top:14px"></div>
    </div>
  </div>`;
}

function rowsAccounts(list) {
  if (!list.length) return `<tr><td colspan="6" class="empty">No accounts match.</td></tr>`;
  return list.map(a => {
    const bunks = Array.isArray(a.bunks) ? a.bunks : [];
    return `<tr>
    <td><div class="name">${esc(a.full_name || '—')}</div><div class="sub">${esc(a.email || '')}</div></td>
    <td>${bunks.length
          ? bunks.map(b => `<div class="sub">${esc(b.name)} · <b>${esc(b.role)}</b></div>`).join('')
          : '<span class="pill wr">no bunk</span>'}</td>
    <td class="sub">${dmy(a.created_at)}</td>
    <td class="sub">${ago(a.last_sign_in_at)}</td>
    <td>${a.is_admin ? '<span class="pill ac">administrator</span> ' : ''}
        ${a.suspended ? '<span class="pill bad">suspended</span>'
          : a.confirmed ? '<span class="pill ok">active</span>' : '<span class="pill wr">unconfirmed</span>'}</td>
    <td class="r"><div class="acts">
      <button class="btn ghost sm" data-act="resetpw" data-id="${esc(a.user_id)}" data-email="${esc(a.email || '')}">Reset password</button>
      <button class="btn ghost sm" data-act="attach" data-id="${esc(a.user_id)}" data-email="${esc(a.email || '')}">Bunks</button>
      ${a.user_id === me.user_id ? '' : `
        <button class="btn ghost sm" data-act="suspend" data-id="${esc(a.user_id)}"
          data-email="${esc(a.email || '')}" data-on="${a.suspended ? '0' : '1'}">
          ${a.suspended ? 'Reactivate' : 'Suspend'}</button>
        <button class="btn danger sm" data-act="delacct" data-id="${esc(a.user_id)}" data-email="${esc(a.email || '')}">Delete</button>`}
    </div></td></tr>`;
  }).join('');
}

/* ------------------------------------------------------------ admins --- */
function vAdmins() {
  const admins = data.accounts.filter(a => a.is_admin);
  return `
  <div class="p">
    <div class="ph"><h2>Administrators</h2><span class="hint">Subsel staff who can use this console</span></div>
    <div class="pb tight"><div class="tw"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Last sign-in</th><th class="r">Actions</th></tr></thead>
      <tbody>${admins.map(a => `<tr>
        <td><div class="name">${esc(a.full_name || '—')}</div></td>
        <td class="sub">${esc(a.email || '')}${a.user_id === me.user_id ? ' <span class="pill ac">you</span>' : ''}</td>
        <td class="sub">${ago(a.last_sign_in_at)}</td>
        <td class="r"><div class="acts">${a.user_id === me.user_id
          ? '<span class="sub">you cannot revoke your own access</span>'
          : `<button class="btn danger sm" data-act="revokeadmin" data-id="${esc(a.user_id)}"
               data-email="${esc(a.email || '')}">Revoke access</button>`}</div></td>
      </tr>`).join('') || `<tr><td colspan="4" class="empty">No administrators.</td></tr>`}
      </tbody></table></div></div>
  </div>

  <div class="p">
    <div class="ph"><h2>Grant administrator access</h2>
      <span class="hint">the login must exist first</span></div>
    <div class="pb">
      <div class="fr" style="max-width:720px">
        <label class="f"><span>Email of an existing BunkSoft login</span>
          <input type="email" id="ga_email" inputmode="email" autocapitalize="none" spellcheck="false"
            placeholder="colleague@subsel.in"></label>
        <label class="f"><span>Note <i class="sub">(optional)</i></span>
          <input type="text" id="ga_note" placeholder="support desk"></label>
        <button class="btn" data-act="grantadmin">Grant access</button>
      </div>
      <div class="note warn" style="margin-top:14px">
        An administrator can create, suspend and delete every account on the platform, and read the
        audit trail. Grant it only to Subsel staff. They still cannot read any bunk's trading figures.
      </div>
    </div>
  </div>

  <div class="p">
    <div class="ph"><h2>Your own password</h2></div>
    <div class="pb">
      <div class="fr" style="max-width:540px">
        <label class="f"><span>New password</span><input type="password" id="mp_pass" autocomplete="new-password"></label>
        <label class="f"><span>Type it again</span><input type="password" id="mp_pass2" autocomplete="new-password"></label>
        <button class="btn" data-act="mypassword">Change it</button>
      </div>
      <div class="sub" style="margin-top:8px">One administrator cannot change another's password — each of you sets your own.</div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------- activity --- */
const ACTION_LABEL = {
  create_business: 'Created business', create_login: 'Created login', create_staff: 'Created staff login',
  set_password: 'Reset password', suspend: 'Suspended', reactivate: 'Reactivated',
  delete_account: 'Deleted account', delete_bunk: 'Removed bunk', set_member: 'Changed bunk access',
  remove_member: 'Removed bunk access', grant_admin: 'Granted admin', revoke_admin: 'Revoked admin',
  bootstrap_admin: 'First administrator created'
};
function vActivity() {
  return `
  <div class="p">
    <div class="ph"><h2>Activity</h2>
      <span class="hint">every administrative action, newest first — this log cannot be edited or deleted</span></div>
    <div class="pb tight"><div class="tw"><table class="t-audit">
      <thead><tr><th>When</th><th>Administrator</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
      <tbody>${data.audit.map(r => `<tr>
        <td class="sub" title="${esc(r.at || '')}">${ago(r.at)}</td>
        <td class="sub">${esc(r.actor_email || '—')}</td>
        <td><b>${esc(ACTION_LABEL[r.action] || r.action)}</b></td>
        <td class="sub">${esc(r.target || '—')}</td>
        <td class="sub mono" style="font-size:11.5px">${esc(detailLine(r.detail))}</td>
      </tr>`).join('') || `<tr><td colspan="5" class="empty">Nothing recorded yet.</td></tr>`}
      </tbody></table></div></div>
  </div>`;
}
function detailLine(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d)
    .filter(([k]) => !/^(user_id|bunk_id)$/.test(k))
    .map(([k, v]) => `${k}=${v}`).join('  ') || '';
}

/* ================================ modals ================================ */
function modal(title, body, onOpen) {
  /* A modal opened from inside another one would otherwise strand the first
     Escape handler on window, and every modal after it would add one more. */
  if (modal._esc) removeEventListener('keydown', modal._esc);
  layer.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="ph"><h2>${esc(title)}</h2><span class="grow"></span>
      <button class="btn ghost sm" data-act="closemodal">Close</button></div>
    <div class="pb">${body}</div></div>`;
  layer.onclick = e => { if (e.target === layer) closeModal(); };
  const esckey = e => { if (e.key === 'Escape') closeModal(); };
  addEventListener('keydown', esckey);
  modal._esc = esckey;
  wire();
  if (onOpen) onOpen();
  const first = layer.querySelector('input,select,button');
  if (first) first.focus();
}
function closeModal() {
  layer.innerHTML = '';
  if (modal._esc) { removeEventListener('keydown', modal._esc); modal._esc = null; }
}

function modalTeam(bunkId) {
  const b = data.businesses.find(x => x.bunk_id === bunkId);
  if (!b) return;
  const team = data.accounts
    .filter(a => (a.bunks || []).some(x => x.bunk_id === bunkId))
    .map(a => ({ ...a, role: (a.bunks || []).find(x => x.bunk_id === bunkId).role }));
  modal(b.name + ' — team', `
    <div class="tw"><table>
      <thead><tr><th>Person</th><th>Role</th><th class="r"></th></tr></thead>
      <tbody>${team.map(t => `<tr>
        <td><div class="name">${esc(t.full_name || '—')}</div><div class="sub">${esc(t.email)}</div></td>
        <td><select data-role-for="${esc(t.user_id)}">
          ${['operator','manager','owner'].map(r =>
            `<option value="${r}"${r === t.role ? ' selected' : ''}>${r}</option>`).join('')}
        </select></td>
        <td class="r"><div class="acts">
          <button class="btn ghost sm" data-act="saverole" data-bunk="${esc(bunkId)}" data-id="${esc(t.user_id)}">Save</button>
          <button class="btn danger sm" data-act="unassign" data-bunk="${esc(bunkId)}" data-id="${esc(t.user_id)}"
            data-email="${esc(t.email)}">Remove</button>
        </div></td></tr>`).join('') || `<tr><td colspan="3" class="empty">Nobody is attached to this bunk.</td></tr>`}
      </tbody></table></div>
    <div class="row">
      <button class="btn" data-act="addstaff" data-id="${esc(bunkId)}">Add someone to this bunk</button>
    </div>
    <div class="note">Removing someone takes away their access to this bunk. Their login stays, so they can
      still be attached to another bunk.</div>`);
}

function modalAddStaff(bunkId) {
  const b = data.businesses.find(x => x.bunk_id === bunkId);
  if (!b) return;
  modal('Add staff to ' + b.name, `
    <label class="f"><span>Name</span><input type="text" id="as_name" placeholder="M Raja"></label>
    <label class="f"><span>Email — their username</span><input type="email" id="as_email"
      inputmode="email" autocapitalize="none" spellcheck="false" placeholder="raja@example.com"></label>
    <label class="f"><span>Role</span><select id="as_role">
      <option value="operator">Operator — runs shifts, stock, credit</option>
      <option value="manager">Manager — also edits rates and setup</option>
      <option value="owner">Owner — full control of this bunk</option>
    </select></label>
    <label class="f"><span>Password to hand over</span>
      <input type="text" id="as_pass" spellcheck="false" value="${esc(suggestPassword())}"></label>
    <div class="row">
      <button class="btn ghost sm" data-act="regen3">New password</button>
      <button class="btn" data-act="dostaff" data-bunk="${esc(bunkId)}">Create the login</button>
    </div>
    <div id="as_out"></div>`);
}

function modalResetPw(userId, email) {
  modal('Reset password', `
    <p class="authsub">A new password for <b>${esc(email)}</b>. The old one stops working at once,
      and any device already signed in stays signed in until its session expires.</p>
    <label class="f"><span>New password</span>
      <input type="text" id="rp_pass" spellcheck="false" value="${esc(suggestPassword())}"></label>
    <div class="row">
      <button class="btn ghost sm" data-act="regen4">Another</button>
      <button class="btn" data-act="doreset" data-id="${esc(userId)}" data-email="${esc(email)}">Set it</button>
    </div>
    <div id="rp_out"></div>`);
}

function modalAttach(userId, email) {
  const acct = data.accounts.find(a => a.user_id === userId);
  const has = new Set((acct?.bunks || []).map(b => b.bunk_id));
  modal('Bunk access for ' + email, `
    <div class="tw"><table>
      <thead><tr><th>Bunk</th><th>Access</th><th class="r"></th></tr></thead>
      <tbody>${data.businesses.map(b => {
        const cur = (acct?.bunks || []).find(x => x.bunk_id === b.bunk_id);
        return `<tr>
          <td><div class="name">${esc(b.name)}</div><div class="sub">${esc(b.place || '')}</div></td>
          <td><select data-att-for="${esc(b.bunk_id)}">
            <option value=""${cur ? '' : ' selected'}>— none —</option>
            ${['operator','manager','owner'].map(r =>
              `<option value="${r}"${cur && cur.role === r ? ' selected' : ''}>${r}</option>`).join('')}
          </select></td>
          <td class="r"><button class="btn ghost sm" data-act="doattach" data-bunk="${esc(b.bunk_id)}"
            data-id="${esc(userId)}">Apply</button></td></tr>`;
      }).join('') || `<tr><td colspan="3" class="empty">No businesses yet.</td></tr>`}
      </tbody></table></div>
    ${has.size ? '' : '<div class="note">This login is not attached to any bunk, so the app will tell them to contact their administrator.</div>'}`);
}

function modalConfirm(title, bodyHtml, confirmLabel, expected, onConfirm) {
  modal(title, `
    ${bodyHtml}
    <label class="f"><span>Type <code>${esc(expected)}</code> to confirm</span>
      <input type="text" id="cf_txt" spellcheck="false" autocomplete="off"></label>
    <div class="row">
      <button class="btn ghost" data-act="closemodal">Cancel</button>
      <button class="btn danger" id="cf_do">${esc(confirmLabel)}</button>
    </div>`, () => {
    $('#cf_do').onclick = () => {
      const typed = $('#cf_txt').value.trim();
      if (typed.toLowerCase() !== String(expected).toLowerCase())
        return toast('That does not match. Nothing was changed.', true);
      closeModal();
      onConfirm(typed);
    };
  });
}

/* ================================ wiring ================================ */
function wire() {
  $$('[data-tab]').forEach(el => el.onclick = () => { tab = el.dataset.tab; render(); });

  const bq = $('#bq');
  if (bq) bq.oninput = () => {
    const q = bq.value.trim().toLowerCase();
    $('#btbody').innerHTML = rowsBusinesses(!q ? data.businesses : data.businesses.filter(b =>
      [b.name, b.brand, b.place, b.owner_name, b.owner_email].some(v => String(v || '').toLowerCase().includes(q))));
    wire();
  };
  const aq = $('#aq');
  if (aq) aq.oninput = () => {
    const q = aq.value.trim().toLowerCase();
    $('#atbody').innerHTML = rowsAccounts(!q ? data.accounts : data.accounts.filter(a =>
      [a.email, a.full_name].some(v => String(v || '').toLowerCase().includes(q))));
    wire();
  };

  $$('[data-act]').forEach(el => { el.onclick = () => handle(el.dataset.act, el); });
}

function handle(action, el) {
  const H = {
    closemodal: closeModal,
    dismiss: () => { const p = el.closest('.handover'); if (p) p.remove(); },
    copyblock: () => copy(el.dataset.text, 'Details'),
    regen:  () => { $('#nb_pass').value = suggestPassword(); },
    regen2: () => { $('#nl_pass').value = suggestPassword(); },
    regen3: () => { $('#as_pass').value = suggestPassword(); },
    regen4: () => { $('#rp_pass').value = suggestPassword(); },

    /* ---- create a whole business ---- */
    createbusiness: () => {
      const v = id => ($('#' + id)?.value || '').trim();
      const bunk = v('nb_bunk'), email = v('nb_email'), pass = $('#nb_pass').value;
      if (!bunk) return toast('Give the bunk a name.', true);
      if (!email) return toast("Enter the owner's email — that is their username.", true);
      return act(async () => {
        const res = await rpc('admin_create_business', {
          p_bunk_name: bunk, p_email: email, p_password: pass,
          p_owner_name: v('nb_name') || null, p_brand: v('nb_brand') || null,
          p_place: v('nb_place') || null, p_phone: v('nb_phone') || null, p_seed: true
        });
        pendingHandover = {
          into: 'nb_out',
          title: 'Hand these over to ' + (v('nb_name') || bunk),
          rows: [['Bunk', res.bunk], ['Sign in at', new URL('../', location.href).href],
                 ['Username', res.email], ['Password', pass]]
        };
      }, 'Business created.');
    },

    /* ---- create a standalone login ---- */
    createlogin: () => {
      const name = ($('#nl_name')?.value || '').trim();
      const email = ($('#nl_email')?.value || '').trim();
      const pass = $('#nl_pass').value;
      const bunk = $('#nl_bunk').value, role = $('#nl_role').value;
      if (!email) return toast('Enter the email for the login.', true);
      return act(async () => {
        if (bunk) {
          await rpc('admin_create_staff', {
            p_bunk: bunk, p_email: email, p_password: pass, p_role: role,
            p_full_name: name || null, p_phone: null
          });
        } else {
          await rpc('admin_create_login', {
            p_email: email, p_password: pass, p_full_name: name || null, p_phone: null
          });
        }
        pendingHandover = {
          into: 'nl_out',
          title: 'Hand these over to ' + (name || email),
          rows: [['Sign in at', new URL('../', location.href).href],
                 ['Username', email.toLowerCase()], ['Password', pass]]
        };
      }, 'Login created.');
    },

    /* ---- staff, from the modal ---- */
    dostaff: () => {
      const email = ($('#as_email')?.value || '').trim();
      const pass = $('#as_pass').value, name = ($('#as_name')?.value || '').trim();
      const role = $('#as_role').value, bunk = el.dataset.bunk;
      if (!email) return toast('Enter their email.', true);
      return act(async () => {
        await rpc('admin_create_staff', {
          p_bunk: bunk, p_email: email, p_password: pass, p_role: role,
          p_full_name: name || null, p_phone: null
        });
        closeModal();
        pendingHandover = {
          into: tab === 'accounts' ? 'nl_out' : 'nb_out',
          title: 'Hand these over to ' + (name || email),
          rows: [['Sign in at', new URL('../', location.href).href],
                 ['Username', email.toLowerCase()], ['Password', pass], ['Role', role]]
        };
      }, 'Staff login created.');
    },

    /* ---- passwords ---- */
    resetpw: () => modalResetPw(el.dataset.id, el.dataset.email),
    doreset: () => {
      const pass = $('#rp_pass').value, id = el.dataset.id, email = el.dataset.email;
      return act(async () => {
        await rpc('admin_set_password', { p_user: id, p_password: pass });
        closeModal();
        pendingHandover = {
          into: tab === 'accounts' ? 'nl_out' : 'nb_out',
          title: 'New password for ' + email,
          rows: [['Sign in at', new URL('../', location.href).href],
                 ['Username', email], ['Password', pass]]
        };
      }, 'Password changed.');
    },
    mypassword: () => {
      const a = $('#mp_pass').value, b = $('#mp_pass2').value;
      if (!a) return toast('Enter a new password.', true);
      if (a !== b) return toast('The two passwords do not match.', true);
      return act(async () => {
        const { error } = await sb.auth.updateUser({ password: a });
        if (error) throw new Error(error.message);
        $('#mp_pass').value = ''; $('#mp_pass2').value = '';
      }, 'Your password has been changed.');
    },

    /* ---- suspend, delete ---- */
    suspend: () => {
      const on = el.dataset.on === '1', email = el.dataset.email, id = el.dataset.id;
      if (!on) return act(() => rpc('admin_set_suspended', { p_user: id, p_suspended: false }),
        email + ' can sign in again.');
      return modalConfirm('Suspend ' + email,
        `<div class="note warn">They will not be able to sign in. Every record stays exactly as it is,
          and you can reactivate the account at any time.</div>`,
        'Suspend the account', email,
        () => act(() => rpc('admin_set_suspended', { p_user: id, p_suspended: true }), email + ' suspended.'));
    },
    delacct: () => {
      const email = el.dataset.email, id = el.dataset.id;
      modalConfirm('Delete ' + email,
        `<div class="note bad">This removes the login for good. The bunk and its records survive, but
          this person loses access and the account cannot be recovered. Suspending is usually what you want.</div>`,
        'Delete the account', email,
        typed => act(() => rpc('admin_delete_account', { p_user: id, p_confirm_email: typed }), 'Account deleted.'));
    },
    delbunk: () => {
      const name = el.dataset.name, id = el.dataset.id;
      modalConfirm('Remove ' + name,
        `<div class="note bad">Every shift, reading, credit slip, expense and report belonging to this bunk
          is destroyed. There is no undo and no backup on this side. If the customer has simply stopped
          paying, suspend the owner's login instead.</div>`,
        'Remove the bunk and all its records', name,
        typed => act(() => rpc('admin_delete_bunk', { p_bunk: id, p_confirm_name: typed }), name + ' removed.'));
    },

    /* ---- membership ---- */
    team: () => modalTeam(el.dataset.id),
    addstaff: () => modalAddStaff(el.dataset.id),
    attach: () => modalAttach(el.dataset.id, el.dataset.email),
    saverole: () => {
      const role = layer.querySelector(`[data-role-for="${el.dataset.id}"]`)?.value;
      return act(() => rpc('admin_set_member', { p_bunk: el.dataset.bunk, p_user: el.dataset.id, p_role: role }),
        'Role changed to ' + role + '.');
    },
    unassign: () => act(async () => {
      await rpc('admin_remove_member', { p_bunk: el.dataset.bunk, p_user: el.dataset.id });
      closeModal();
    }, 'Removed from the bunk.'),
    doattach: () => {
      const role = layer.querySelector(`[data-att-for="${el.dataset.bunk}"]`)?.value;
      return act(async () => {
        if (role) await rpc('admin_set_member', { p_bunk: el.dataset.bunk, p_user: el.dataset.id, p_role: role });
        else await rpc('admin_remove_member', { p_bunk: el.dataset.bunk, p_user: el.dataset.id });
        closeModal();
      }, role ? 'Access set to ' + role + '.' : 'Access removed.');
    },

    /* ---- administrators ---- */
    grantadmin: () => {
      const email = ($('#ga_email')?.value || '').trim();
      if (!email) return toast('Enter the email of an existing login.', true);
      return modalConfirm('Grant administrator access',
        `<div class="note warn">${esc(email)} will be able to create, suspend and delete every account
          on the platform. Only grant this to Subsel staff.</div>`,
        'Grant it', email,
        () => act(() => rpc('admin_grant_admin', { p_email: email, p_note: ($('#ga_note')?.value || '').trim() || null }),
          email + ' is now an administrator.'));
    },
    revokeadmin: () => {
      const email = el.dataset.email, id = el.dataset.id;
      modalConfirm('Revoke administrator access',
        `<div class="note warn">${esc(email)} keeps their login but loses this console.</div>`,
        'Revoke it', email,
        () => act(() => rpc('admin_revoke_admin', { p_user: id }), 'Administrator access revoked.'));
    }
  };
  const fn = H[action];
  if (fn) fn();
}

/* ================================= boot ================================= */
async function boot() {
  let session = null;
  try { const { data: d } = await sb.auth.getSession(); session = d.session; } catch {}
  if (!session) return screenSignIn('');

  try { me = await rpc('admin_whoami'); }
  catch (e) { return screenSignIn(human(e)); }

  if (!me || me.is_admin !== true) return screenRefused(session.user.email);

  try { await load(); }
  catch (e) { return screenSignIn(human(e)); }

  bumpIdle();
  startIdleWatch();
  render();
}

if (!configured) {
  screenNotConfigured();
} else {
  sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      /* Its own key and its own storage: closing the tab ends the admin
         session, and it never collides with a bunk session in this browser. */
      storageKey: 'bunksoft-admin-auth',
      storage: (() => { try { sessionStorage.setItem('_t', '1'); sessionStorage.removeItem('_t'); return sessionStorage; } catch { return undefined; } })(),
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: false
    },
    global: { headers: { 'x-client-info': 'bunksoft-admin' } }
  });
  sb.auth.onAuthStateChange((_e, s) => { if (!s && me) { me = null; screenSignIn(''); } });
  document.getElementById('a_out').onclick = async () => {
    await sb.auth.signOut(); me = null; screenSignIn('');
  };
  document.getElementById('a_theme').onclick = toggleTheme;
  boot();
}
