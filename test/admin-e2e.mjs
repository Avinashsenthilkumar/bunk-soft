/* ============================================================================
   BunkSoft — browser test of the admin console and the account it creates.
   Subsel Tech Solutions Pvt Ltd

     npm i playwright && node test/admin-e2e.mjs

   Drives the real pages against the in-memory backend in fake-supabase.js:
   an administrator signs in, creates a business, and the owner that was
   created signs into the bunk app with the credentials the console handed
   over. Then it proves the things that must NOT work: self sign-up, and a
   bunk owner reaching the console.

   The database's own guarantees are tested separately and for real, against
   Postgres, in supabase/test_admin.sql.
   ========================================================================== */
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

const ROOT = path.resolve('web'), TEST = path.resolve('test');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json',
  '.svg':'image/svg+xml', '.png':'image/png' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin/index.html';
  const file = p.startsWith('/__test/') ? path.join(TEST, p.slice(8)) : path.join(ROOT, p);
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(buf);
  });
});
await new Promise(r => server.listen(4174, r));
const BASE = 'http://127.0.0.1:4174';

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome']
  .find(fs.existsSync);
const b = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await b.newPage({ viewport: { width: 1420, height: 1000 } });

const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => {
  if (m.type() === 'error' && !/favicon|manifest|sw\.js|fonts\.googleapis|TUNNEL|net::ERR/i.test(m.text()))
    errs.push('console: ' + m.text());
});

/* The real config.js may hold a live project; the test must never reach it. */
await page.route('**/js/config.js', r => r.fulfill({ status: 200, contentType: 'text/javascript',
  body: `window.BUNKSOFT_CONFIG={supabaseUrl:'https://demo.supabase.co',supabaseAnonKey:'${'x'.repeat(60)}'};` }));
await page.route('**/@supabase/supabase-js**', r => r.fulfill({ status: 200,
  contentType: 'text/javascript', body: fs.readFileSync('test/fake-supabase.js', 'utf8') }));
await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

let pass = 0, fail = 0;
const ok = (label, v) => { v ? pass++ : fail++; console.log((v ? '  PASS  ' : '  FAIL  ') + label); };
const wait = ms => page.waitForTimeout(ms);
/* page.$ matches hidden nodes too; the shells here are only toggled with
   [hidden], so visibility is what the assertions must ask about. */
const shown = async sel => { const el = await page.$(sel); return !!el && await el.isVisible(); };

/* The console's session survives navigation inside the tab, which is correct
   but means each persona has to leave before the next arrives. */
async function adminSignedOut() {
  await page.goto(BASE + '/admin/'); await wait(700);
  for (let i = 0; i < 3 && !(await page.$('#ai_email')); i++) {
    /* #a_out lives inside the hidden shell when the refusal screen is up, so
       only a visible button is a real way out. */
    let clicked = false;
    for (const sel of ['#ar_out', '#a_out']) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.click(); clicked = true; break; }
    }
    if (!clicked) {
      /* Nothing visible to click: drop the console's session directly, the
         way closing the tab would. */
      await page.evaluate(() => {
        try { sessionStorage.removeItem('__fakesess:bunksoft-admin-auth'); } catch {}
      });
      await page.goto(BASE + '/admin/');
    }
    await wait(700);
  }
  return !!(await page.$('#ai_email'));
}
/* Same for the bunk app: leave before the next person arrives. */
async function appSignedOut() {
  await page.goto(BASE + '/'); await wait(700);
  for (let i = 0; i < 3 && !(await page.$('#au_email')); i++) {
    const el = await page.$('[data-act="signout"]');
    if (el && await el.isVisible()) { await el.click(); }
    else {
      await page.evaluate(() => {
        try {
          sessionStorage.removeItem('__fakesess:bunksoft-app-auth');
          localStorage.removeItem('bunksoft.bunk');
        } catch {}
      });
      await page.goto(BASE + '/');
    }
    await wait(800);
  }
  return !!(await page.$('#au_email'));
}
async function appSignIn(email, pw) {
  await appSignedOut();
  await page.fill('#au_email', email);
  await page.fill('#au_pass', pw);
  await page.click('#au_go'); await wait(1500);
}

async function adminSignIn(email, pw) {
  await adminSignedOut();
  await page.fill('#ai_email', email);
  await page.fill('#ai_pass', pw);
  await page.click('#ai_go'); await wait(1000);
}

/* Seed one administrator, the way bootstrap_platform_admin() does in SQL. */
async function seedAdmin() {
  await page.evaluate(() => {
    const T = JSON.parse(sessionStorage.getItem('__fakedb') || 'null') || {
      bunks: [], memberships: [], profiles: [], products: [], tanks: [], nozzles: [],
      business_days: [], shifts: [], readings: [], credit_customers: [], credit_txns: [],
      fuel_receipts: [], dip_readings: [], expenses: [], cash_deposits: [] };
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const S = { user: null, email: '', admins: [id], audit: [],
      users: [{ id, email: 'admin@subsel.in', password: 'Subsel2026Admin', name: 'Avinash S',
                created_at: new Date().toISOString(), suspended: false }] };
    T.profiles.push({ id, full_name: 'Avinash S' });
    sessionStorage.setItem('__fakedb', JSON.stringify(T));
    sessionStorage.setItem('__fakestate', JSON.stringify(S));
  });
}

console.log('\n1. The bunk app no longer offers to create an account');
await page.goto(BASE + '/'); await wait(500);
await seedAdmin();
await page.goto(BASE + '/'); await wait(600);
ok('sign-in screen shown', !!(await page.$('#au_email')));
ok('no "create an account" link anywhere on it',
  !/create (an )?account|sign ?up/i.test(await page.textContent('body')));
ok('it says who to ask for an account',
  /contact your bunksoft administrator/i.test(await page.textContent('body')));
ok('the sign-up swap button is gone', !(await page.$('#au_swap')));

console.log('\n2. A stranger cannot reach the admin console');
await page.goto(BASE + '/admin/'); await wait(700);
ok('admin console shows its own sign-in', !!(await page.$('#ai_email')));
ok('it is branded as the admin console',
  /admin console/i.test(await page.textContent('body')));
ok('the console page is marked noindex',
  !!(await page.$('meta[name="robots"][content*="noindex"]')));
await page.fill('#ai_email', 'nobody@example.com');
await page.fill('#ai_pass', 'WrongPassword123');
await page.click('#ai_go'); await wait(500);
ok('a wrong password is refused', /do not match/i.test(await page.textContent('body')));

console.log('\n3. The administrator signs in and creates a business');
await page.fill('#ai_email', 'admin@subsel.in');
await page.fill('#ai_pass', 'Subsel2026Admin');
await page.click('#ai_go'); await wait(900);
ok('the console opened', await shown('#atabs'));
ok('it greets the administrator by email',
  (await page.textContent('#awho')).includes('admin@subsel.in'));
ok('the overview shows the statistics row', (await page.$$('.stat')).length >= 6);
ok('it states that admins cannot read customer figures',
  /cannot read a customer|keeps every bunk sealed/i.test(await page.textContent('body')));

const genPass = await page.inputValue('#nb_pass');
ok('a strong password is suggested', genPass.length >= 14 && /[A-Z]/.test(genPass)
  && /[a-z]/.test(genPass) && /[0-9]/.test(genPass));

await page.fill('#nb_bunk', 'Sri Balaji Fuels');
await page.fill('#nb_brand', 'Indian Oil');
await page.fill('#nb_place', 'Thanjavur, Tamil Nadu');
await page.fill('#nb_name', 'R Balaji');
await page.fill('#nb_email', 'balaji@example.com');
await page.click('[data-act="createbusiness"]'); await wait(900);

ok('a handover card appears', !!(await page.$('.handover')));
const handover = await page.textContent('.handover');
ok('it shows the username', handover.includes('balaji@example.com'));
ok('it shows the password to hand over', handover.includes(genPass));
ok('it shows where the customer signs in', /sign in at/i.test(handover));
ok('it warns the password is shown once', /shown once|cannot be read back/i.test(handover));

await page.click('[data-tab="business"]'); await wait(500);
ok('the business is listed', (await page.textContent('#btbody')).includes('Sri Balaji Fuels'));
ok('the owner is named against it', (await page.textContent('#btbody')).includes('balaji@example.com'));
ok('it is flagged as not started yet', /not started/i.test(await page.textContent('#btbody')));

console.log('\n4. Weak input is refused by the console');
await page.click('[data-tab="accounts"]'); await wait(400);
await page.fill('#nl_email', 'weak@example.com');
await page.fill('#nl_pass', 'short1');
await page.click('[data-act="createlogin"]'); await wait(600);
ok('a short password is refused', /at least 10 characters/i.test(await page.textContent('#atoast')));
await page.fill('#nl_email', 'balaji@example.com');
await page.fill('#nl_pass', 'PerfectlyFine2026');
await page.click('[data-act="createlogin"]'); await wait(600);
ok('a duplicate email is refused', /already exists/i.test(await page.textContent('#atoast')));

console.log('\n5. The owner signs in to the bunk app with those credentials');
await appSignIn('balaji@example.com', genPass);
ok('the app opened straight into the bunk', await shown('[data-tab="dash"]'));
ok('the header carries the bunk name',
  (await page.textContent('#hdName')).includes('Sri Balaji'));
ok('three tanks were seeded for them',
  (await page.evaluate(() => window.BunkSoft.S.tanks.length)) === 3);
ok('no "add another bunk" button exists',
  !/add another bunk|add a bunk/i.test(await page.textContent('body')));

console.log('\n6. A bunk owner who finds the console URL is refused');
ok('the administrator can sign out of the console', await adminSignedOut());
await page.fill('#ai_email', 'balaji@example.com');
await page.fill('#ai_pass', genPass);
await page.click('#ai_go'); await wait(900);
ok('the console refuses them', /not an administrator/i.test(await page.textContent('body')));
ok('the console itself is never rendered for them', !(await shown('#atabs')));
ok('it points them back to the bunk app', !!(await page.$('a[href="../"]')));

/* The interface refusing them proves little on its own. Call the admin
   functions directly, as that signed-in owner, and check the backend refuses
   each one — this is what stops a patched page or a hand-made request. */
const refusals = await page.evaluate(async pw => {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient('https://demo.supabase.co', 'x'.repeat(60),
    { auth: { storageKey: 'probe' } });
  await sb.auth.signInWithPassword({ email: 'balaji@example.com', password: pw });
  const calls = {
    admin_create_business: { p_bunk_name: 'Pirate Fuels', p_email: 'pirate@example.com',
                             p_password: 'Pirate123456', p_owner_name: 'P' },
    admin_create_login:    { p_email: 'x@example.com', p_password: 'Sneaky123456' },
    admin_set_password:    { p_user: '00000000-0000-4000-8000-000000000000', p_password: 'Hijack123456' },
    admin_grant_admin:     { p_email: 'balaji@example.com' },
    admin_delete_bunk:     { p_bunk: '00000000-0000-4000-8000-000000000000', p_confirm_name: 'x' }
  };
  const out = {};
  for (const [fn, args] of Object.entries(calls)) {
    const r = await sb.rpc(fn, args);
    out[fn] = !!(r.error && /Administrator access required/i.test(r.error.message));
  }
  const reads = {};
  for (const fn of ['admin_businesses', 'admin_accounts', 'admin_audit_log']) {
    const r = await sb.rpc(fn, {});
    reads[fn] = Array.isArray(r.data) && r.data.length === 0;
  }
  const st = await sb.rpc('admin_stats', {});
  reads.admin_stats = st.data === null;
  return { out, reads };
}, genPass);
Object.entries(refusals.out).forEach(([fn, v]) =>
  ok(`the backend refuses ${fn}() to a bunk owner`, v));
Object.entries(refusals.reads).forEach(([fn, v]) =>
  ok(`${fn}() returns nothing to a bunk owner`, v));

console.log('\n7. Suspending a business blocks the sign-in but keeps the records');
await adminSignIn('admin@subsel.in', 'Subsel2026Admin');
await page.click('[data-tab="business"]'); await wait(500);
await page.click('#btbody [data-act="suspend"]'); await wait(400);
ok('suspending asks for confirmation', !!(await page.$('#cf_txt')));
await page.fill('#cf_txt', 'balaji@example.com');
await page.click('#cf_do'); await wait(900);
ok('the business shows as suspended', /suspended/i.test(await page.textContent('#btbody')));
ok('the bunk itself survived', (await page.textContent('#btbody')).includes('Sri Balaji Fuels'));

await appSignIn('balaji@example.com', genPass);
ok('the suspended owner cannot sign in', !(await shown('[data-tab="dash"]')));
ok('and is told the account is suspended',
  /suspended/i.test(await page.textContent('#gate')));

console.log('\n8. Reactivating, and the audit trail');
await adminSignIn('admin@subsel.in', 'Subsel2026Admin');
await page.click('[data-tab="business"]'); await wait(500);
await page.click('#btbody [data-act="suspend"]'); await wait(800);
ok('reactivating needs no confirmation', !(await page.$('#cf_txt')));
ok('the business is active again', !/suspended/i.test(await page.textContent('#btbody')));

await page.click('[data-tab="activity"]'); await wait(500);
const audit = await page.textContent('body');
ok('the audit log records the business being created', /Created business/i.test(audit));
ok('the audit log records the suspension', /Suspended/i.test(audit));
ok('the audit log records the reactivation', /Reactivated/i.test(audit));
ok('the audit log names the administrator', audit.includes('admin@subsel.in'));
ok('the log is described as unalterable', /cannot be edited or deleted/i.test(audit));

console.log('\n9. Staff, roles and access');
await page.click('[data-tab="business"]'); await wait(400);
await page.click('#btbody [data-act="team"]'); await wait(500);
ok('the team dialog opens', !!(await page.$('.modal')));
await page.click('.modal [data-act="addstaff"]'); await wait(500);
ok('the add-staff dialog opens from it', !!(await page.$('#as_email')));
const staffPass = await page.inputValue('#as_pass');
await page.fill('#as_name', 'M Raja');
await page.fill('#as_email', 'raja@example.com');
await page.selectOption('#as_role', 'operator');
await page.click('[data-act="dostaff"]'); await wait(900);
ok('the staff login is created', /Staff login created/i.test(await page.textContent('#atoast')));
await page.click('[data-tab="business"]'); await wait(400);
ok('the staff count went up', /Team \(2\)/.test(await page.textContent('#btbody')));

await page.click('#btbody [data-act="team"]'); await wait(500);
const team = await page.textContent('.modal');
ok('the team dialog lists both people',
  team.includes('balaji@example.com') && team.includes('raja@example.com'));
await page.click('[data-act="closemodal"]'); await wait(200);

console.log('\n10. The operator signs in and gets operator powers only');
await appSignIn('raja@example.com', staffPass);
ok('the operator reaches the bunk', await shown('[data-tab="dash"]'));
ok('their role shows as Operator', (await page.textContent('#storageDot')).trim() === 'Operator');
await page.click('[data-tab="setup"]'); await wait(600);
ok('Settings is read-only for them',
  !(await page.$('[data-act="savecfg"]')) || /read-only|operator/i.test(await page.textContent('#view')));

console.log('\n11. Page errors');
ok('no uncaught JavaScript errors anywhere', errs.length === 0);
if (errs.length) errs.slice(0, 8).forEach(e => console.log('        ' + e));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await b.close(); server.close();
process.exit(fail ? 1 : 0);
