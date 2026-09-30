# BunkSoft — Petrol Bunk Management Software

**Subsel Tech Solutions Pvt Ltd** · Powering petrol bunks. Driving growth.

A multi-tenant web application for running a petrol bunk: shift-wise meter
readings, tank stock, credit book, expenses, cash reconciliation and PDF
reports. Each bunk's data is isolated at the database level, and staff get
roles — the owner sees profit, the operator runs the forecourt.

BunkSoft is sold, not signed up for. Nobody creates their own login. Subsel
creates the account for each bunk that buys the software, from a separate
**admin console** that customers never see.

- **Frontend** — static HTML/CSS/JS. No build step, no framework, no bundler.
- **Backend** — Supabase (PostgreSQL + Auth). Row-level security does the
  tenant isolation; triggers own tank stock so it cannot drift.
- **Hosting** — any static host. Netlify, Vercel, Cloudflare Pages, S3,
  Nginx, or a folder on your own server.

```
/          the bunk application — owners, managers and operators sign in
/admin/    the administration console — Subsel staff only
```

---

## 1. Create the database

1. Go to [supabase.com](https://supabase.com) → **New project**.
   Pick a region close to your customers (Mumbai or Singapore for India).
   Save the database password somewhere safe.
2. Open **SQL Editor** → **New query** and run these three files, in order.
   Each one is safe to run again.

   | File | What it does |
   |---|---|
   | [`supabase/schema.sql`](supabase/schema.sql) | Tables, triggers, views and the tenant security policies |
   | [`supabase/admin.sql`](supabase/admin.sql) | The administration layer: who is an admin, and the functions that create accounts |
   | [`supabase/lock_signups.sql`](supabase/lock_signups.sql) | Optional but recommended — refuses any account not created by an administrator |

3. Create the first administrator. Run this once, with your own details:

   ```sql
   select public.bootstrap_platform_admin(
     'admin@subsel.in',      -- your email; this is your username
     'ChangeThisNow2026',    -- at least 10 characters, letters and digits
     'Avinash S');
   ```

   It refuses to run a second time, so nobody can use it to seize the console
   later. Sign in at `/admin/` afterwards and change that password under
   **Administrators → Your own password**.

4. Turn off self sign-up in the dashboard: **Authentication → Sign In / Providers
   → Email → Allow new users to sign up: off**. `lock_signups.sql` enforces this
   in the database as well, but the dashboard toggle is the setting people
   look at, so set both.

5. Open **Project Settings → API** and copy two values:
   - **Project URL** — `https://xxxxxxxx.supabase.co`
   - **anon public** key — a long `eyJ…` string

### About that anon key

It is *designed* to be public and sits in the browser of every web app built
on Supabase. What protects your data is row-level security, which `schema.sql`
sets up: a signed-in user can only read or write rows belonging to a bunk they
are a member of.

**Never put the `service_role` key anywhere in `web/`.** It bypasses every
policy. BunkSoft never needs it: creating logins happens inside the database,
in `security definer` functions that check who is calling. That is the whole
reason the admin console can be a static page.

---

## 2. Configure the app

Edit [`web/js/config.js`](web/js/config.js):

```js
window.BUNKSOFT_CONFIG = {
  supabaseUrl:     'https://xxxxxxxx.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi…'
};
```

That is the only file you change to point a build at a database, and both
pages read it.

Rather not commit it? Generate it at build time instead:

```
Build command:  node scripts/write-config.mjs
Environment:    SUPABASE_URL, SUPABASE_ANON_KEY
```

The script refuses to write a `service_role` key into a file served to
browsers, and refuses a URL that is not a Supabase project.

> On a build with `config.js` still unfilled, the app shows a **Connect your
> database** screen where a tester can paste the two values, stored in that
> browser only. Once `config.js` is filled in that override is ignored and
> cleared — otherwise anything able to write to `localStorage` could point a
> live deployment at someone else's database and harvest every password typed
> into it.

---

## 3. Deploy

The `web/` folder *is* the site, `/admin/` included. Nothing to compile.

**Netlify or Cloudflare Pages, from Git**
- Build command: *(leave empty, or `node scripts/write-config.mjs`)*
- Publish directory: `web`

Both read [`web/_headers`](web/_headers); Netlify also reads
[`netlify.toml`](netlify.toml). The two agree, so either route gives the same
security headers.

**Vercel** — `vercel --prod` from the repo root; [`vercel.json`](vercel.json)
points at `web/` and carries the same headers.

**Your own Nginx** — copy [`deploy/nginx.conf`](deploy/nginx.conf), adjust
`server_name` and `root`, then `nginx -t && systemctl reload nginx`.

**Custom domain** — point `bunksoft.subsel.in` at the host and add the domain
in its dashboard. Then add that origin under Supabase **Authentication → URL
Configuration → Site URL / Redirect URLs**, or password-reset links will
bounce.

HTTPS is required — the service worker and installable-app behaviour only
work over TLS.

> **Whichever host you pick, check the headers actually arrived.** A missing
> Content-Security-Policy is invisible until it matters. `curl -sI
> https://your-domain/ | grep -i content-security-policy` should print a long
> line. `node test/headers.mjs` checks the rules locally, including that all
> four copies of the policy still agree.

---

## 4. Running the business: the admin console

Go to `/admin/` and sign in with the administrator account you bootstrapped.
The console is not linked from the app, is marked `noindex`, is never cached,
and refuses any account that is not a platform administrator.

**A new customer**

*Overview → Add a business*: the bunk's name, oil company and town, then the
owner's name and email. The email is their username. Press **New password**
for a strong one, or type your own.

Creating it makes the login and the bunk together, seeded with three tanks and
five nozzles, and shows a card with the sign-in address, username and
password. **That card is the only time the password is visible** — it is
stored as a bcrypt hash and cannot be read back. Copy it, send it to the
customer, press Done. If it is lost, set a new one; you are not recovering the
old one.

**Their staff**

*Businesses → Team → Add someone to this bunk*. Operators run shifts, stock
and credit; managers also edit rates and setup; owners have full control. You
can also create a login with no bunk yet under *Accounts*, and attach it later.

The bunk's own owner can still grant and remove access to their own bunk under
**Settings → Team** in the app — but only for people whose login already
exists, because only you can create one.

**When someone stops paying**

*Suspend*, not *Remove*. Suspending blocks the sign-in and leaves every record
untouched; reactivating takes one click. **Remove** destroys the bunk and its
entire history, which is why it makes you type the name back first.

**Activity**

Every administrative action — accounts created, passwords reset, suspensions,
admin access granted — is recorded with who did it and when. The log cannot be
edited or deleted through the API by anyone, administrators included.

**What an administrator cannot see**

Deliberately: any bunk's sales, cash, credit or expense rows. Row-level
security still applies to you. The console shows who the customers are, who
their staff are, when they last used it and how many days they have recorded —
enough to run the business of selling the software, and no more. The test
suite checks this, so it stays true.

**More Subsel staff**

*Administrators → Grant administrator access*, by the email of a login that
already exists. An administrator cannot revoke their own access, cannot change
another administrator's password, and the last one cannot be removed.

---

## 5. First run, for the customer

1. They open the site and sign in with what you gave them.
2. **Settings → Products & rates** — selling and purchase rates.
   Nothing computes a margin until they do.
3. **Settings** — rename the seeded tanks and nozzles to match the forecourt.
4. **Settings → Team** — give their staff access, once you have created those
   logins.
5. Start the day: **Sales Entry** → closing meter readings → collections →
   *Save & close shift*. The closing report opens automatically.

---

## Roles

| | Operator | Manager | Owner | Platform admin |
|---|---|---|---|---|
| Shifts, readings, credit slips, expenses, stock, cash | yes | yes | yes | **no** |
| Reports and PDFs | yes | yes | yes | **no** |
| Rates, products, tanks, nozzles, bunk settings | no | yes | yes | no |
| Grant access to their own bunk | no | yes | yes | yes |
| Create a BunkSoft login | **no** | **no** | **no** | yes |
| Create or remove a bunk | no | no | no | yes |
| Suspend an account | no | no | no | yes |

Enforced in the database, not just hidden in the interface — an operator
calling the API directly still cannot change a rate, and a bunk owner calling
it cannot create an account.

---

## Security

What protects a BunkSoft deployment, and where each piece lives.

**Tenant isolation.** Every table is scoped to a bunk and guarded by row-level
security. A signed-in user reads and writes only rows belonging to a bunk they
are a member of. Platform administrators are not exempt. `supabase/schema.sql`,
proved by `supabase/test_rls.sql`.

**No self sign-up**, in three layers, because one is a setting somebody can
flip back:
1. The app has no sign-up screen, and `db.js` has no `signUp()` to call.
2. The Supabase dashboard toggle is off.
3. `lock_signups.sql` puts a trigger on `auth.users` that refuses any insert
   not made by `admin_create_login()`. A hand-made POST to `/auth/v1/signup`
   fails in the database, whatever the dashboard says.

**Account creation without a secret in the browser.** The admin console holds
no privileged key. Creating a login runs in `security definer` functions that
check `is_platform_admin()` before doing anything. Patching the console's
JavaScript to skip its own gate gains nothing — the refusal is on the server.

**Least privilege for the anonymous role.** Postgres grants `EXECUTE` on every
new function to `PUBLIC`, which on Supabase includes the anonymous role.
`admin.sql` revokes that across the whole schema and hands back only what each
role needs. `create_bunk()` is no longer callable by a signed-in user at all.

**Passwords.** Bcrypt at cost 10, matching what Supabase's own auth service
writes — pgcrypto's default of 6 would have been weaker than the hashes
alongside it. Minimum ten characters with letters and digits, enforced in the
database so it holds however the function is called. The generator avoids
`0/O` and `1/l/I`, because these get read off a slip of paper.

**Content-Security-Policy.** `default-src 'none'` and a named list of
everywhere the page may load code from or talk to. No inline script is
permitted, and `connect-src` reaches only Supabase — so a script injected by
any means cannot fetch a payload or post your customers' data anywhere. The
console gets a tighter policy again. Kept identical in `web/_headers`,
`netlify.toml`, `vercel.json` and `deploy/nginx.conf`, with a copy in each
page's `<meta>` so the policy survives a host that sends no headers.
`test/headers.mjs` checks all four still agree and that neither page trips its
own policy.

Also set: HSTS for a year, `X-Frame-Options: DENY` and `frame-ancestors 'none'`
(no clickjacking), `nosniff`, a `Permissions-Policy` that switches off camera,
microphone and location, `Cross-Origin-Opener-Policy`, and `no-store` plus
`noindex` on `/admin/`.

**Sessions.** The console keeps its session in `sessionStorage` under its own
key: closing the tab ends it, and an admin session can never be confused with
a bunk session in the same browser. It signs itself out after 20 minutes idle.

**The service worker** never caches `/admin/`, and only caches a good
same-origin response — an error page saved into the cache would be served for
as long as the cache lived.

**Fixed in the audit** — four defects found reading the code end to end, all
now covered by tests:

- A **manager could promote themselves to owner** with one direct API call.
  `add_member()` refused it, but the memberships policy granted managers `for
  all`, and a browser console is all it took to go around the function. A
  manager could then **delete the owner's membership** and lock the owner out
  of their own bunk. Both are closed: a manager can no longer create, edit or
  delete an owner's row, and a trigger keeps at least one owner on every bunk.
- **Settings → Team never showed anyone's name.** The profiles policy allowed
  reading only your own row, and the query embedded `profiles` across a
  foreign key that does not exist between `memberships` and `profiles`. You
  can now read the profile of anyone on a bunk you belong to — and nobody
  else — and the repository joins in JavaScript instead of relying on
  PostgREST to infer a relationship.
- **Book stock was editable in Settings and silently discarded.** The database
  owns tank stock, so the repository never sent the field. It is now shown
  read-only, pointing at the dip reading that is the real way to correct it.
- **Re-saving a closed shift moved its closing time** to the moment of the
  edit, because the original timestamp was not carried back from the database.

**What is still yours to do**
- Give the console a bookmark, not a link, and do not put the URL in email
  signatures or tickets. It is not a secret, but there is no reason to publish
  it either.
- If Subsel staff work from fixed addresses, uncomment the `allow`/`deny`
  block in `deploy/nginx.conf`, or use your host's access rules.
- Turn on MFA for administrator accounts in the Supabase dashboard when you
  are ready; the console does not implement it itself.
- Tighten `connect-src` from `https://*.supabase.co` to your exact project URL
  once it is settled. The four header files say where.
- Set your own SMTP under **Project Settings → Auth** so password-reset mail
  comes from your domain.

---

## What the database does for you

Two things are deliberately **not** the browser's job, because clients race
and phones lose signal mid-save:

- **Tank stock** is maintained by triggers. A reading reduces it, a
  decantation raises it, a dip sets it. Correct a closing reading and the
  stock corrects by the difference. Two operators saving at once cannot
  corrupt it.
- **Credit outstanding** is a view (`customer_balances`), computed from
  opening balance plus sales minus payments. There is no stored balance to
  drift out of step with the ledger.

---

## Repository layout

```
supabase/
  schema.sql              tables, triggers, views, tenant security
  admin.sql               the administration layer — run after schema.sql
  lock_signups.sql        optional hard lock on self sign-up
  test_rls.sql            proves tenant isolation, triggers and roles
  test_admin.sql          proves the administration rules
  _local_auth_stub.sql    lets the tests run on a plain Postgres
web/
  index.html              the bunk application
  css/app.css             its styling, light and dark
  js/config.js            your Supabase URL and anon key — shared by both pages
  js/config.example.js    a copy to start from
  js/main.js              sign-in, bunk selection, routing
  js/db.js                Supabase client and the data repository
  js/app.js               domain logic, rendering, reports, PDFs
  admin/index.html        the administration console
  admin/admin.css         its own styling — graphite, not the app's navy
  admin/admin.js          its own logic and its own session
  sw.js                   offline shell
  manifest.webmanifest    installable app metadata
  _headers                security headers (Cloudflare Pages, Netlify)
  robots.txt              keeps crawlers away
deploy/
  nginx.conf              the same headers for your own server
scripts/
  write-config.mjs        build config.js from environment variables
test/
  e2e.mjs                 browser test of a full day at a bunk
  admin-e2e.mjs           browser test of the console and what it refuses
  headers.mjs             checks the security headers and the CSP
  fake-supabase.js        in-memory stand-in used by the browser tests
```

`js/app.js` never touches SQL — it calls the repository in `db.js`. If you
move off Supabase later, `db.js` is the only file that changes. The console
shares no code with the application: the app's bundle contains no way to
create an account even if someone reads it.

---

## Testing

**Database** — on any Postgres 15+:

```bash
createdb bunksoft_test
psql -d bunksoft_test -f supabase/_local_auth_stub.sql
psql -d bunksoft_test -f supabase/schema.sql
psql -d bunksoft_test -f supabase/admin.sql
psql -d bunksoft_test -f supabase/test_rls.sql      # tenant isolation
psql -d bunksoft_test -f supabase/test_admin.sql    # administration rules
```

`test_rls.sql` confirms a second tenant sees zero rows, cross-tenant writes are
refused, stock trigger arithmetic, the balance view, and that an operator's
rate change affects 0 rows.

`test_admin.sql` runs 74 checks: that an administrator can create a business
whose owner then signs in; that a bunk owner cannot create an account, promote
themselves, reset anyone's password or read the audit log; that an
administrator cannot read a customer's cash figures; that suspension blocks a
sign-in and keeps the records; and that destructive actions need confirmation.

**Frontend** — `npm i playwright`, then:

```bash
npm test          # a full day at a bunk: shift, stock, credit, cash, reports
npm run test:admin   # the console: create, suspend, reset, refuse
npm run test:headers # the security headers and the CSP
```

`admin-e2e.mjs` signs a bunk owner into the console and checks it refuses
them — then calls the admin functions directly as that owner and checks the
backend refuses each one too, which is what stops a patched page.

---

## QA checklist

- [ ] Run all three SQL files, then bootstrap the first administrator
- [ ] `/admin/` refuses a wrong password, and refuses a bunk owner who signs in
- [ ] The app's sign-in page offers no way to create an account
- [ ] Add a business; the handover card shows username and password
- [ ] The owner signs in with them and lands in their bunk, three tanks seeded
- [ ] Set rates; the rate board reflects them
- [ ] Enter a shift; sold litres and amount compute live
- [ ] Short/excess reacts to the collection figures
- [ ] Save & close → report opens → PDF downloads
- [ ] Decantation raises tank stock; a dip sets it and logs the variation
- [ ] Add a credit customer, issue a slip, receive a payment, check the ledger
- [ ] Cash book: opening + sales + recovery − expenses − deposits = closing
- [ ] Day report PDF carries readings, sales, credit, stock, expenses, tally
- [ ] Add an operator from the console; confirm Settings is read-only for them
- [ ] A second owner with their own bunk sees none of the first bunk's data
- [ ] Suspend an owner; they cannot sign in; reactivate; they can
- [ ] The Activity log names you against everything you just did
- [ ] `curl -sI https://your-domain/` shows the Content-Security-Policy
- [ ] Works at phone width; installs to the home screen
- [ ] Dark mode is legible throughout, in both the app and the console

---

## Costs at pilot scale

Supabase free tier covers roughly 50k monthly active users and 500 MB of
database — a bunk generates a few MB a year. Static hosting is free on
Netlify, Vercel and Cloudflare Pages. Expect **₹0 until you have real
volume**; the first paid step is Supabase Pro at about $25/month.

---

## Notes for the next developer

- The business date is what the operator selects, not a rolling 24 hours. A
  night shift crossing midnight belongs to the date it started.
- Money is `numeric(14,2)`; litres `numeric(12,2)`; rates `numeric(10,3)`.
  Never hold money in a float.
- PDFs use "Rs." — the PDF standard fonts have no rupee glyph. Embedding a
  Unicode font would add roughly 300 KB to the page load.
- `jsPDF` loads from cdnjs on first report, then caches. If you move it, add
  the new origin to `script-src` in all four header files or reports will stop
  working with nothing in the interface to say why.
- Adding a column: add it to `schema.sql`, to the mapping in `db.js`, and to
  the fake in `test/fake-supabase.js` so the tests stay honest.
- Adding an admin function: guard it with `perform public.require_platform_admin();`
  as its first statement, log it with `public.admin_log(...)`, and grant
  `execute` to `authenticated` at the bottom of `admin.sql` — new functions are
  world-executable by default until that file's revoke loop runs.
- The console and the app share only `config.js`. Keep it that way; it is why
  the application bundle has no account-creation code in it to find.
