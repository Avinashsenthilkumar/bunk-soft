/* ============================================================================
   BunkSoft — entry point: configuration check, sign-in, bunk selection.
   Subsel Tech Solutions Pvt Ltd
   ========================================================================== */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as DB from './db.js';
import { startApp, setSessionEmail } from './app.js';

const gate = document.getElementById('gate');
const shell = document.getElementById('shell');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    <div class="authcredit">Subsel Tech Solutions Pvt Ltd · Powering petrol bunks. Driving growth.</div>
  </div>`;

const err = m => `<div class="autherr">${esc(m)}</div>`;

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
    if (!/^https:\/\/.+\.supabase\.co$/.test(url)) return screenConfig('That does not look like a Supabase URL.');
    if (key.length < 40) return screenConfig('That anon key looks too short.');
    DB.saveOverride(url, key);
    location.reload();
  };
}

/* -------------------------------------------------------------- sign in -- */
function screenSignIn(message, mode = 'in') {
  const isUp = mode === 'up';
  show(card(isUp ? 'Create your account' : 'Sign in',
    isUp ? 'One account per person. Your owner adds you to a bunk afterwards.' : 'Welcome back.',
    `${message ? err(message) : ''}
     ${isUp ? `<label class="f"><span>Your name</span><input type="text" id="au_name" autocomplete="name"></label>` : ''}
     <label class="f"><span>Email</span><input type="email" id="au_email" autocomplete="email"></label>
     <label class="f"><span>Password</span><input type="password" id="au_pass"
       autocomplete="${isUp ? 'new-password' : 'current-password'}"></label>
     <button class="btn wide" id="au_go">${isUp ? 'Create account' : 'Sign in'}</button>
     ${!isUp ? `<button class="linkbtn" id="au_forgot">Forgot password?</button>` : ''}`,
    isUp ? `Already have an account? <button class="linkbtn" id="au_swap">Sign in</button>`
         : `New here? <button class="linkbtn" id="au_swap">Create an account</button>`));

  const go = async () => {
    const email = document.getElementById('au_email').value;
    const pass = document.getElementById('au_pass').value;
    const name = isUp ? document.getElementById('au_name').value : '';
    if (!email || !pass) return screenSignIn('Enter your email and password.', mode);
    if (isUp && pass.length < 8) return screenSignIn('Use at least 8 characters for the password.', mode);
    const btn = document.getElementById('au_go');
    btn.disabled = true; btn.textContent = isUp ? 'Creating…' : 'Signing in…';
    const { data, error } = isUp ? await DB.auth.signUp(email, pass, name) : await DB.auth.signIn(email, pass);
    if (error) return screenSignIn(error.message, mode);
     if (isUp && !data.session) {
      show(card('Check your email',
        `We sent a confirmation link to <b>${esc(email)}</b>. Open it, then come back and sign in.`,
        `<button class="btn wide" id="au_back">Back to sign in</button>`));
      document.getElementById('au_back').onclick = () => screenSignIn('', 'in');
      return;
    }
    route();
  };
  document.getElementById('au_go').onclick = go;
  document.getElementById('au_pass').onkeydown = e => { if (e.key === 'Enter') go(); };
  document.getElementById('au_swap').onclick = () => screenSignIn('', isUp ? 'in' : 'up');
  const f = document.getElementById('au_forgot');
  if (f) f.onclick = async () => {
    const email = document.getElementById('au_email').value;
    if (!email) return screenSignIn('Enter your email first, then press Forgot password.', mode);
    await DB.auth.reset(email);
    screenSignIn('If that email has an account, a reset link is on its way.', mode);
  };
}

/* ---------------------------------------------------------- pick a bunk -- */
async function screenBunks(message) {
  let bunks = [];
  try { bunks = await DB.repo.myBunks(); }
  catch (e) {
    return show(card('Cannot reach the database', e.message,
      `<button class="btn wide" id="bk_retry">Try again</button>
       <button class="linkbtn" id="bk_out">Sign out</button>
       <p class="authnote">If this persists, check that <b>schema.sql</b> has been run on this Supabase project.</p>`,
      ''), wire());
  }

  if (!bunks.length) return screenNewBunk('', true);

  show(card('Choose a bunk', 'You have access to these.',
    `${message ? err(message) : ''}
     <div class="bunklist">
       ${bunks.map(b => `<button class="bunkrow" data-id="${esc(b.id)}" data-role="${esc(b.role)}">
          <span class="bn">${esc(b.name)}</span>
          <span class="bm">${esc([b.brand, b.place].filter(Boolean).join(' · ') || 'No location set')}</span>
          <span class="pill ${b.role === 'operator' ? 'wr' : 'ok'}">${esc(b.role)}</span>
        </button>`).join('')}
     </div>
     <button class="btn ghost wide" id="bk_new">Add another bunk</button>`,
    `<button class="linkbtn" id="bk_out">Sign out</button>`));

  gate.querySelectorAll('.bunkrow').forEach(el => {
    el.onclick = () => open({ id: el.dataset.id, role: el.dataset.role });
  });
  document.getElementById('bk_new').onclick = () => screenNewBunk('', false);
  wire();

  function wire() {
    const o = document.getElementById('bk_out');
    if (o) o.onclick = async () => { await DB.auth.signOut(); route(); };
    const r = document.getElementById('bk_retry');
    if (r) r.onclick = () => screenBunks('');
  }
}

function screenNewBunk(message, first) {
  show(card(first ? 'Set up your bunk' : 'Add a bunk',
    first ? 'Two minutes now, and every shift afterwards is just meter readings and cash.' : '',
    `${message ? err(message) : ''}
     <label class="f"><span>Bunk name</span><input type="text" id="nb_name" placeholder="Sri Balaji Fuels"></label>
     <label class="f"><span>Oil company</span><input type="text" id="nb_brand" placeholder="Indian Oil / BPCL / HPCL"></label>
     <label class="f"><span>Location</span><input type="text" id="nb_place" placeholder="Town, State"></label>
     <button class="btn wide" id="nb_go">Create bunk</button>
     <p class="authnote">You get three tanks and five nozzles to start with — rename, add or remove them
     under Settings, and set your rates before the first shift.</p>`,
    first ? `<button class="linkbtn" id="nb_out">Sign out</button>`
          : `<button class="linkbtn" id="nb_back">Back</button>`));

  document.getElementById('nb_go').onclick = async () => {
    const name = document.getElementById('nb_name').value.trim();
    if (!name) return screenNewBunk('Give the bunk a name.', first);
    const btn = document.getElementById('nb_go');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const id = await DB.repo.createBunk(name,
        document.getElementById('nb_brand').value.trim(),
        document.getElementById('nb_place').value.trim());
      open({ id, role: 'owner' });
    } catch (e) { screenNewBunk(e.message, first); }
  };
  const back = document.getElementById('nb_back');
  if (back) back.onclick = () => screenBunks('');
  const out = document.getElementById('nb_out');
  if (out) out.onclick = async () => { await DB.auth.signOut(); route(); };
}

/* ------------------------------------------------------------- routing -- */
function open(bunk) {
  try { localStorage.setItem('bunksoft.bunk', JSON.stringify(bunk)); } catch {}
  showApp();
  startApp(bunk);
}

async function route() {
  if (!DB.configured) return screenConfig('');
  const session = await DB.auth.session();
  if (!session) return screenSignIn('', 'in');
  setSessionEmail(session.user.email || '');

  /* Go straight back to the bunk this device used last. */
  let last = null;
  try { last = JSON.parse(localStorage.getItem('bunksoft.bunk') || 'null'); } catch {}
  if (last && last.id) {
    try {
      const mine = await DB.repo.myBunks();
      const found = (mine || []).find(b => b.id === last.id);
      if (found) return open({ id: found.id, role: found.role });
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
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
