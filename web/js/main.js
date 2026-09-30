/* ============================================================================
   BunkSoft — entry point: configuration check, sign-in, bunk selection.
   Subsel Tech Solutions Pvt Ltd

   There is no sign-up here, by design. Accounts and bunks are created by a
   platform administrator in the separate console at /admin/, which this file
   deliberately neither links to nor mentions. Nothing in this bundle can
   create a login even if someone reads it: the functions that do live behind
   an administrator check in the database.
   ========================================================================== */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as DB from './db.js';
import { startApp, setSessionEmail } from './app.js';

const gate = document.getElementById('gate');
const shell = document.getElementById('shell');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Who to ask when something needs an administrator. Change these two for a
   reseller; they are the only branding in the sign-in screens. */
const SUPPORT = { name: 'Subsel Tech Solutions Pvt Ltd', contact: 'your BunkSoft administrator' };

/* Remember the theme across visits. */
try {
  const t = localStorage.getItem('bunksoft.theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
} catch {}

function show(html) {
  shell.hidden = true;
  gate.hidden = false;
  gate.innerHTML = html;
}
function showApp() { gate.hidden = true; gate.innerHTML = ''; shell.hidden = false; }

const card = (title, sub, body, foot) => `
  <div class="authwrap">
    <div class="authbrand">
      <div class="brandmark">
        <svg viewBox="0 0 24 24" fill="none" stroke="#1565D8" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M2 21h14"/><path d="M4 11h10"/>
          <path d="M17 8l3 3v7a1.5 1.5 0 0 0 3 0v-9l-3-3"/>
        </svg>
      </div>
      <div><div class="blogo">Bunk<i>Soft</i></div><div class="btag">Petrol Bunk Management</div></div>
    </div>
    <div class="authcard">
      <h1>${title}</h1>
      ${sub ? `<p class="authsub">${sub}</p>` : ''}
      ${body}
    </div>
    ${foot ? `<div class="authfoot">${foot}</div>` : ''}
    <div class="authcredit">${esc(SUPPORT.name)} · Powering petrol bunks. Driving growth.</div>
  </div>`;

const err = m => `<div class="autherr">${esc(m)}</div>`;

/* Supabase's messages are written for developers. Say what an operator
   standing at the forecourt can act on instead. */
function readableAuthError(message) {
  const m = String(message || '');
  if (/invalid login credentials/i.test(m)) return 'That email and password do not match. Check both, then try again.';
  if (/email not confirmed/i.test(m)) return `This account is not active yet. Ask ${SUPPORT.contact} to activate it.`;
  if (/banned|blocked|suspend/i.test(m)) return `This account has been suspended. Contact ${SUPPORT.contact}.`;
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
  if (/failed to fetch|network/i.test(m)) return 'No connection to the server. Check the internet and try again.';
  return m;
}

/* ------------------------------------------------------- not configured -- */
function screenConfig(message) {
  show(card('Connect your database',
    'BunkSoft stores your records in your own Supabase project. Paste its details once to get started.',
    `${message ? err(message) : ''}
     <label class="f"><span>Supabase project URL</span>
       <input type="url" id="cf_url" placeholder="https://xxxxxxxx.supabase.co" autocomplete="off"></label>
     <label class="f"><span>Anon public key</span>
       <input type="text" id="cf_key" placeholder="eyJhbGciOi…" autocomplete="off"></label>
     <button class="btn wide" id="cf_go">Connect</button>
     <p class="authnote">Find both under <b>Project Settings → API</b> in Supabase. The anon key is safe in a
     browser — row-level security is what protects your data, and the schema sets it up for you.</p>`,
    'Deploying for real? Put these in <code>js/config.js</code> so every user gets them automatically.'));

  document.getElementById('cf_go').onclick = () => {
    const url = document.getElementById('cf_url').value.trim().replace(/\/+$/, '');
    const key = document.getElementById('cf_key').value.trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) return screenConfig('That does not look like a Supabase URL.');
    if (key.length < 40) return screenConfig('That anon key looks too short.');
    DB.saveOverride(url, key);
    location.reload();
  };
}

/* -------------------------------------------------------------- sign in -- */
function screenSignIn(message) {
  show(card('Sign in', 'Welcome back.',
    `${message ? err(message) : ''}
     <label class="f"><span>Email</span><input type="email" id="au_email" autocomplete="username"
       inputmode="email" autocapitalize="none" spellcheck="false"></label>
     <label class="f"><span>Password</span><input type="password" id="au_pass"
       autocomplete="current-password"></label>
     <button class="btn wide" id="au_go">Sign in</button>
     <button class="linkbtn" id="au_forgot">Forgot password?</button>`,
    `Need an account, or a password reset? Contact ${esc(SUPPORT.contact)}.`));

  const go = async () => {
    const email = document.getElementById('au_email').value;
    const pass = document.getElementById('au_pass').value;
    if (!email || !pass) return screenSignIn('Enter your email and password.');
    const btn = document.getElementById('au_go');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const { error } = await DB.auth.signIn(email, pass);
      if (error) return screenSignIn(readableAuthError(error.message));
    } catch (e) {
      return screenSignIn(readableAuthError(e.message));
    }
    route();
  };
  document.getElementById('au_go').onclick = go;
  document.getElementById('au_email').onkeydown = e => { if (e.key === 'Enter') document.getElementById('au_pass').focus(); };
  document.getElementById('au_pass').onkeydown = e => { if (e.key === 'Enter') go(); };

  document.getElementById('au_forgot').onclick = async () => {
    const email = document.getElementById('au_email').value;
    if (!email) return screenSignIn('Enter your email first, then press Forgot password.');
    try { await DB.auth.reset(email); } catch {}
    /* Never reveal whether an account exists for that address. */
    screenSignIn('If that email has an account, a reset link is on its way. If nothing arrives, ask your administrator to set a new password for you.');
  };
}

/* ---------------------------------------------------- no bunk yet ------- */
/* A real account with no bunk attached. Previously this offered to create
   one; now only an administrator can, so say who to ask. */
function screenNoBunk(email) {
  show(card('No bunk assigned yet',
    `Your account <b>${esc(email || '')}</b> works, but it is not attached to a bunk.`,
    `<p class="authnote">Ask ${esc(SUPPORT.contact)} to attach your account to your bunk.
     Once they do, sign in again and it will open here.</p>
     <button class="btn wide" id="nb_retry">Check again</button>`,
    `<button class="linkbtn" id="nb_out">Sign out</button>`));
  document.getElementById('nb_retry').onclick = () => screenBunks('');
  document.getElementById('nb_out').onclick = async () => { await DB.auth.signOut(); route(); };
}

/* ------------------------------------------------------ pick a bunk ---- */
async function screenBunks(message) {
  let bunks = [];
  try { bunks = await DB.repo.myBunks(); }
  catch (e) {
    show(card('Cannot reach the database', readableAuthError(e.message),
      `<button class="btn wide" id="bk_retry">Try again</button>
       <button class="linkbtn" id="bk_out">Sign out</button>
       <p class="authnote">If this keeps happening, contact ${esc(SUPPORT.contact)}.</p>`,
      ''));
    return wire();
  }

  if (!bunks.length) return screenNoBunk(DB.sessionEmail);

  /* One bunk and nothing to choose: open it. */
  if (bunks.length === 1) return open({ id: bunks[0].id, role: bunks[0].role });

  show(card('Choose a bunk', 'You have access to these.',
    `${message ? err(message) : ''}
     <div class="bunklist">
       ${bunks.map(b => `<button class="bunkrow" data-id="${esc(b.id)}" data-role="${esc(b.role)}">
          <span class="bn">${esc(b.name)}</span>
          <span class="bm">${esc([b.brand, b.place].filter(Boolean).join(' · ') || 'No location set')}</span>
          <span class="pill ${b.role === 'operator' ? 'wr' : 'ok'}">${esc(b.role)}</span>
        </button>`).join('')}
     </div>`,
    `<button class="linkbtn" id="bk_out">Sign out</button>`));

  gate.querySelectorAll('.bunkrow').forEach(el => {
    el.onclick = () => open({ id: el.dataset.id, role: el.dataset.role });
  });
  wire();

  function wire() {
    const o = document.getElementById('bk_out');
    if (o) o.onclick = async () => { await DB.auth.signOut(); route(); };
    const r = document.getElementById('bk_retry');
    if (r) r.onclick = () => screenBunks('');
  }
}

/* ------------------------------------------------------------- routing -- */
function open(bunk) {
  try { localStorage.setItem('bunksoft.bunk', JSON.stringify(bunk)); } catch {}
  showApp();
  startApp(bunk);
}

async function route() {
  if (!DB.configured) return screenConfig('');
  let session = null;
  try { session = await DB.auth.session(); } catch {}
  if (!session) return screenSignIn('');
  DB.setSessionEmail(session.user.email || '');
  setSessionEmail(session.user.email || '');

  /* Go straight back to the bunk this device used last. The role is re-read
     from the server every time — a stale role in localStorage must never be
     what decides whether Settings is editable. */
  let last = null;
  try { last = JSON.parse(localStorage.getItem('bunksoft.bunk') || 'null'); } catch {}
  if (last && last.id) {
    try {
      const mine = await DB.repo.myBunks();
      const found = (mine || []).find(b => b.id === last.id);
      if (found) return open({ id: found.id, role: found.role });
      /* Access was removed while this device was away. */
      try { localStorage.removeItem('bunksoft.bunk'); } catch {}
    } catch {}
  }
  screenBunks('');
}

window.addEventListener('bunksoft:signout', async () => {
  try { localStorage.removeItem('bunksoft.bunk'); } catch {}
  await DB.auth.signOut();
  route();
});
window.addEventListener('bunksoft:switchbunk', () => {
  try { localStorage.removeItem('bunksoft.bunk'); } catch {}
  screenBunks('');
});

/* ---------------------------------------------------------------- start -- */
if (DB.configured) {
  DB.initClient(createClient);
  DB.auth.onChange(s => { if (!s) route(); });
}
route();

/* Offline shell, so the forecourt keeps working on a weak signal. */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
}
