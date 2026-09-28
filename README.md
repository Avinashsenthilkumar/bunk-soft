# BunkSoft — Petrol Bunk Management Software

**Subsel Tech Solutions Pvt Ltd** · Powering petrol bunks. Driving growth.

A multi-tenant web application for running a petrol bunk: shift-wise meter
readings, tank stock, credit book, expenses, cash reconciliation and PDF
reports. Each bunk's data is isolated at the database level, and staff get
roles — the owner sees profit, the operator runs the forecourt.

- **Frontend** — static HTML/CSS/JS. No build step, no framework, no bundler.
- **Backend** — Supabase (PostgreSQL + Auth). Row-level security does the
  tenant isolation; triggers own tank stock so it cannot drift.
- **Hosting** — any static host. Netlify, Vercel, Cloudflare Pages, S3,
  Nginx, or a folder on your own server.

---

## 1. Create the database (5 minutes)

1. Go to [supabase.com](https://supabase.com) → **New project**.
   Pick a region close to your customers (Mumbai or Singapore for India).
   Save the database password somewhere safe.
2. Open **SQL Editor** → **New query**.
3. Paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and press **Run**.
   It creates every table, view, trigger, function and security policy.
   Running it twice is safe.
4. Open **Project Settings → API** and copy two values:
   - **Project URL** — `https://xxxxxxxx.supabase.co`
   - **anon public** key — a long `eyJ…` string

### About that anon key

It is *designed* to be public and sits in the browser of every web app built
on Supabase. What protects your data is row-level security, which `schema.sql`
sets up: a signed-in user can only read or write rows belonging to a bunk they
are a member of. **Never put the `service_role` key in the frontend** — it
bypasses all of that.

### Email settings

By default Supabase asks new users to confirm their email. For a pilot you may
want that off: **Authentication → Providers → Email → Confirm email**. For
production, leave it on and set your own SMTP under **Project Settings → Auth**
so mail comes from your domain rather than Supabase's shared sender.

---

## 2. Configure the app

Edit `web/js/config.js`:

```js
window.BUNKSOFT_CONFIG = {
  supabaseUrl:     'sb_publishable_-XTDhRbOWpe_vQ8H3fL_Hg_PPgD0_Kq',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2bHFycWpjYmllY3ljcHVybnN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1ODkyMjYsImV4cCI6MjEwNjE2NTIyNn0.K_Hhiqz5ZB8oWfC6wASoD9uwOzCaswmfhmUOG37Usvs'
};
```

That is the only file you change to point a build at a database.

> If you deploy without filling this in, the app shows a **Connect your
> database** screen where a tester can paste the two values, stored in that
> browser only. Handy for QA; fill in `config.js` for anything real.

---

## 3. Deploy

The `web/` folder *is* the site. Nothing to compile.

**Fastest, no account needed** — go to [app.netlify.com/drop](https://app.netlify.com/drop)
and drag the `web` folder onto the page. You get a public HTTPS URL in about
ten seconds. Good enough to hand to QA.

**Netlify or Cloudflare Pages, from Git**
- Build command: *(leave empty)*
- Publish directory: `web`

**Vercel** — `vercel --prod` from the repo root; `vercel.json` already points
at `web/`.

**Your own Nginx**

```nginx
server {
  listen 443 ssl http2;
  server_name bunksoft.subsel.com;
  root /var/www/bunksoft/web;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
  location ~* \.(?:css|js|svg|png|webmanifest)$ { expires 7d; }
}
```

**Custom domain** — point `bunksoft.subsel.com` at the host and add the domain
in its dashboard. Then add that origin under Supabase **Authentication → URL
Configuration → Site URL / Redirect URLs**, or password-reset links will
bounce.

HTTPS is required — the service worker and installable-app behaviour only
work over TLS.

---

## 4. First run

1. Open the site → **Create an account**.
2. Name the bunk, the oil company and the town. You get three tanks and five
   nozzles seeded; rename them under **Settings**.
3. Set your selling and purchase rates under **Settings → Products & rates**.
   Nothing computes a margin until you do.
4. **Settings → Team**: staff sign up themselves first, then you add them by
   the email they used.
5. Start the day: **Sales Entry** → closing meter readings → collections →
   *Save & close shift*. The closing report opens automatically.

---

## Roles

| | Operator | Manager | Owner |
|---|---|---|---|
| Shifts, readings, credit slips, expenses, stock, cash | yes | yes | yes |
| Reports and PDFs | yes | yes | yes |
| Rates, products, tanks, nozzles, bunk settings | **no** | yes | yes |
| Add and remove staff | no | yes | yes |
| Delete the bunk | no | no | yes |

Enforced in the database, not just hidden in the interface — an operator
calling the API directly still cannot change a rate.

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
  schema.sql              run this once on a new project
  test_rls.sql            proves tenant isolation, triggers and roles
  _local_auth_stub.sql    lets the tests run on a plain Postgres
web/
  index.html              the app shell
  css/app.css             all styling, light and dark
  js/config.js            your Supabase URL and anon key
  js/main.js              sign-in, bunk selection, routing
  js/db.js                Supabase client and the data repository
  js/app.js               domain logic, rendering, reports, PDFs
  sw.js                   offline shell
  manifest.webmanifest    installable app metadata
test/
  e2e.mjs                 browser test of the whole flow
  fake-supabase.js        in-memory stand-in used by that test
```

`js/app.js` never touches SQL — it calls the repository in `db.js`. If you
move off Supabase later, `db.js` is the only file that changes.

---

## Testing

**Database** — on any Postgres 15+:

```bash
createdb bunksoft_test
psql -d bunksoft_test -f supabase/_local_auth_stub.sql
psql -d bunksoft_test -f supabase/schema.sql
psql -d bunksoft_test -f supabase/test_rls.sql
```

Confirms a second tenant sees zero rows, cross-tenant writes are refused,
stock triggers arithmetic, the balance view, and that an operator's rate
change affects 0 rows.

**Frontend** — `npm i playwright && node test/e2e.mjs`. Drives sign-up,
bunk creation, rates, a full shift, decantation, credit, payment, expenses,
the cash book and reports against an in-memory backend.

---

## QA checklist

- [ ] Sign up, confirm email, sign in
- [ ] Create a bunk; three tanks and five nozzles appear
- [ ] Set rates; the rate board reflects them
- [ ] Enter a shift; sold litres and amount compute live
- [ ] Short/excess reacts to the collection figures
- [ ] Save & close → report opens → PDF downloads
- [ ] Decantation raises tank stock; a dip sets it and logs the variation
- [ ] Add a credit customer, issue a slip, receive a payment, check the ledger
- [ ] Cash book: opening + sales + recovery − expenses − deposits = closing
- [ ] Day report PDF carries readings, sales, credit, stock, expenses, tally
- [ ] Add an operator; confirm Settings is read-only for them
- [ ] Second owner with their own bunk sees none of the first bunk's data
- [ ] Works at phone width; installs to the home screen
- [ ] Dark mode is legible throughout

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
- `jsPDF` loads from cdnjs on first report, then caches.
- Adding a column: add it to `schema.sql`, to the mapping in `db.js`, and to
  the fake in `test/fake-supabase.js` so the tests stay honest.
