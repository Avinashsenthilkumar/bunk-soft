# BunkSoft — October 2026 review: what was wrong and what changed

Subsel Tech Solutions Pvt Ltd · version 1.1.0

An end-to-end review of the trading logic found eighteen defects. Four of them
were producing wrong money silently — no error, no warning, just a figure that
did not match the forecourt. This file is the record of each one: what it did,
what it does now, and where the proof lives.

**Before you deploy this release, run [`supabase/fixes.sql`](supabase/fixes.sql)
in the Supabase SQL editor.** The web app expects the columns and functions it
adds; without them, saving a shift fails. It is safe to run on an existing
database and safe to run twice.

---

## The four that lost money

### 1. A totalizer that wrapped past all nines erased the sale

Sold litres were `closing − opening − test`, floored at zero. When an
eight-digit meter head rolls over — opening 99,999,000, closing 500 — that
arithmetic gives a negative number, the floor turns it into zero, and a real
1,500-litre sale disappeared from the books with the cash still in the drawer.
Tank stock did not move either, so the next dip showed a 1,500-litre "gain"
that nobody could explain.

Readings now carry `rollover_add`: the litres the wrap swallowed. When a
closing is below its opening, the entry form offers to record the rollover and
shows the litres it would produce; the operator confirms or corrects the
reading. `reading_sold()`, the stock trigger, the shift report, the day PDF and
the day-book CSV all read the same formula, so stock and sales cannot disagree.

### 2. Retiring a nozzle or product erased every day it had worked

`loadConfig()` filtered archived rows out, and historic readings were then
joined against the current nozzle list. Retire a dispenser and its sales
vanished from every day it had ever run — including closed months and the P&L
for last financial year.

Archived rows are now loaded and carry an `archived` flag. The entry forms,
Settings and the rate card show only live rows; anything that reads the past
resolves against every nozzle that has a reading, labelled "retired".

### 3. The opening meter fell back to zero outside the loaded window

A nozzle's opening was worked out from whatever days happened to be in the
browser's memory. Open a date outside that window and it fell back to 0 — and a
shift saved that way booked the meter's entire lifetime total as one day's sale.
On a meter reading 1.2 crore litres that is a day's sale of about ₹120 crore.

A new `last_closings()` function answers the question from the records. The app
asks the server for the previous closings every time the date changes, and uses
the in-memory answer only when it has one.

### 4. A dip was compared against a stale book figure

The app sent `book_qty` from the tank figure held in that browser. If another
device had sold fuel since the page loaded, the gain or loss logged was wrong —
and because a dip *sets* stock, that error was then baked into the tank.

`record_dip()` reads the book figure on the server, under a row lock, inside the
same statement that writes the dip. The browser no longer sends it at all.

---

## Readings and rates

### 5. A closing below its opening was silently zeroed
Nothing warned, on screen or in the database. The entry form now flags it as
you type, the save offers the rollover or refuses, and `trg_reading_sane()`
refuses it in the database as well.

### 6. Test litres could exceed what passed the meter
10 litres through the nozzle with 50 claimed as test was accepted, and 40 litres
left the tank unaccounted. Refused now in the form and in the database.

### 7. A shift could be closed against an unset selling rate
500 litres were booked as a ₹0 sale, and the cash collected showed as excess.
Closing now refuses, naming the product whose rate is missing.

### 8. A missing purchase rate was reported as 100% profit
The margin treated unset cost as zero cost. The dashboard and the P&L now say
the margin is unavailable and name the cause, rather than printing a profit.

### 9. Revising a rate restated shifts already closed and signed
Shift value was recomputed from the day's rates on every render. The rate card
is now frozen onto the shift as it closes (`shifts.rates_at_close`); the app
values a closed shift at its frozen rates and an open one at the live rates,
and says which on the report.

---

## Cash, credit and expenses

### 10. A credit limit was recorded but never enforced
A slip that takes a customer past their limit now shows what the outstanding
would become and by how much it breaches, and is issued only on a confirmation.

### 11. Negative amounts were accepted
A negative expense quietly raised the day's profit; a negative deposit, payment
or credit slip did the equivalent elsewhere. All four now require an amount
above zero.

### 12. A deposit could exceed the cash in hand
Banking more than the drawer holds now states the shortfall and asks first.

### 13. A payment could exceed the outstanding without comment
Legitimate as an advance, but usually a mistyped figure. It now says what the
advance would be and asks.

### 14. A decantation larger than the tank was accepted
80,000 litres into an 8,000-litre tank. It now says how much will fit and asks.

### 15. A credit slip orphaned by a cleared shift was adopted by shift one
`credit_txns.shift_id` is `on delete set null`, so clearing a shift leaves its
slips behind. They were being handed to whichever shift happened to be first,
inflating that shift's credit and throwing its short/excess out. They now sit in
the day's own list, counted in the day's credit, named on the shift screen and
on the day PDF as belonging to no shift.

### 16. Expense heads were case-sensitive
"Diesel", "diesel" and "Diesel " were three separate heads in every report.
They are one head now, displayed with the spelling first used.

---

## Reports and concurrency

### 17. A report could be computed from part of the period
PostgREST caps a response at 1,000 rows. A year of a four-nozzle, two-shift bunk
is past that on the readings alone, so the P&L was computed from however much
fitted — and days never read look exactly like days with no trade. Every table
is now walked in pages until exhausted, the app tracks which dates it has
actually read, and a report over a period with gaps says so, offers to load the
rest, and puts the warning in the exported CSV too.

### 18. Two people saving the same shift: last write won, silently
The shift was written with a blind upsert. Two operators on two phones, and
whoever pressed Save second erased the other's entries with no indication that
anything had been lost. The save is now conditional on the `updated_at` the
browser last read; if somebody else has saved in the meantime it is refused, the
other person's entries are loaded onto the screen, and the message says so.

**Also found while fixing this:** every message raised inside a save — including
every error — was being destroyed by the re-render that followed it, because
toasts lived in the container `render()` rewrites. They now have their own
container, and an error stays on screen longer than a confirmation.

---

## Proving it

| Suite | Checks | Covers |
|---|---|---|
| `psql -f supabase/test_fixes.sql` | 20 | rollover arithmetic, reading validation, `record_dip()`, `last_closings()`, the shift delete policy, the anon role |
| `npm run test:domain` | 32 | one case per finding, against the real application |
| `npm test` | 20 | a full day at a bunk, unchanged |
| `npm run test:admin` | 73 | the administration console, unchanged |
| `npm run test:headers` | 42 | the security headers and the CSP, unchanged |
| `psql -f supabase/test_admin.sql` | 83 | the administration rules, unchanged |
| `psql -f supabase/test_rls.sql` | — | tenant isolation and triggers, unchanged |

`npm run test:all` runs the four browser suites in order.

---

## Files changed

```
supabase/fixes.sql          NEW — run this in Supabase before deploying
supabase/test_fixes.sql     NEW — 20 checks on the above
test/domain-e2e.mjs         NEW — 32 checks, one per finding
web/js/db.js                archived reference data, lastClosings, paged
                            loadRange, stale-write guard, record_dip,
                            backwards-walking ledger, unassignedCredit
web/js/app.js               rollover entry and confirm flow, meter validation,
                            frozen rates, archived-aware helpers, amount and
                            limit guards, head normalisation, period-gap
                            warning, toast container
web/index.html              a toast container outside the re-rendered layer
web/css/app.css             styling for it
test/fake-supabase.js       rollover, the sanity trigger, record_dip,
                            last_closings, range() paging, shift updated_at
test/e2e.mjs                sets a rate for every product, since a shift can no
                            longer be closed without one
README.md                   fixes.sql in the install order, the new suites
package.json                version 1.1.0, test:domain
```

---

# 13 October — the deployment failure, and what changed because of it

Version 1.1.1.

The 1.1.0 web app went live before `supabase/fixes.sql` had been run on the
database. Every shift save then failed with:

> Could not find the 'rates_at_close' column of 'shifts' in the schema cache

Three things were wrong with that, and all three are fixed.

### 19. A missing migration stopped the forecourt

The app assumed its columns existed. If they did not, saving a shift failed
outright — an operator with a drawer full of cash and a sheet of meter
readings could not record them, and the message told them nothing they could
act on.

The app now asks the database once at startup whether the migration is there,
and works either way. Without it, the shift, the readings, the stock movement,
the credit and the cash all save exactly as before; only the four things that
genuinely need the new schema are switched off — meter rollover, the frozen
closing rates, the server-side dip and the server-side opening reading. Every
write is also attempted a second time without the new fields if the database
rejects them mid-flight, so a stale PostgREST cache cannot lose a shift
either.

The owner sees a plain banner naming the file to run. The operator sees
nothing broken.

### 20. The API did not know about the new columns

PostgREST serves Supabase's REST API from a cached copy of the schema, so a
column added a moment ago is still missing as far as the app is concerned.
`fixes.sql` now ends with `notify pgrst, 'reload schema'`, so the app works
the moment the file finishes rather than several minutes later.

### 21. Every field on the sign-in screen was unstyled

The stylesheet listed `input[type=text]`, `number`, `date` and `tel` — and
nothing else. `email`, `password`, `url` and a bare `<input>` all fell through
to the browser's default narrow box, which is why the Email and Password
boxes sat visibly short of the Sign in button beneath them. The rule now works
by exclusion, naming only the few controls that must *not* be full width, so a
type nobody thought of can never be missed again. Focus rings were added to
match the admin console.

The sign-in card is also centred in the window now rather than sitting at the
top with a large empty area beneath it — using `margin:auto` on a flex child,
which, unlike `align-items:center`, still scrolls properly when the card is
taller than the window.

### Proving it

`npm run test:nomigration` — 16 checks against a database where `fixes.sql`
was never run: the app opens, the banner names the file, the shift saves, the
litres and the value are right, stock moves, the dip records against a freshly
read book figure, and once the migration is applied the banner disappears and
the full feature set returns.

---

# 14 October — three reported issues

Version 1.2.0. No database change; web files only.

### 22. A credit slip was counted as money received

The shift meter had one figure labelled **Received**, and it was
`cash + card + UPI + bank + credit`. Issue a ₹3,715 credit slip against an
empty drawer and the screen reported ₹3,715 received, when nothing had come
in. The number was right for the short/excess calculation — fuel sold on
credit is part of the amount due, so it has to be matched by the slips or
every credit sale would look like a shortage — but it was being shown under a
label that said something else entirely.

They are now two figures:

- **Collected** — cash, card, UPI, bank transfer. Money.
- **Credit** — the slips.
- **Accounted** — the two added together, which is what the amount due is
  compared against.

The shift report, the WhatsApp summary and the shift PDF all read the same
way: *Collected in money*, then the slips, then *Total accounted*. The PDF's
"Collected" card also used to leave bank transfer out of its total; it does
not now.

### 23. Settings → Team is hidden

Hidden at the customer's request until the invite flow is settled. One
constant controls it — `SHOW_TEAM` at the top of `web/js/app.js`. Setting it
to `true` brings the panel and its two actions straight back; nothing else
needs changing, and the membership API underneath is untouched. Staff are put
on a bunk from the administration console in the meantime.

The API is still exercised by the test suites while the panel is hidden, so
turning it back on cannot find it quietly broken.

### 24. The two rate screens disagreed

**Revise rates** writes the rate for one date, into `business_days.rates`.
**Settings → Products** holds the standing rate on the product row — what a
new day starts from, and what values the stock. Revising a rate never touched
the standing one, so the two drifted apart: Settings kept showing a figure
nobody had used for weeks, the stock valuation used that stale figure while
the P&L used the day's, and every new day opened on the old rate.

Revising rates for today or any later date now moves the standing rate with
it, because that is the owner saying what the rate *is*. Back-dating a
correction to an earlier day still changes that day alone. Editing the
standing rate in Settings while standing on today does the reverse — today
moves too.

Settings also gained a **Today** column showing what the open date is actually
set to, with a warning mark when it differs from the standing rate, so the two
can never silently disagree again.

### Proving it

Three new cases in `npm run test:domain` (45 checks now): a credit slip is not
collected money, Settings does not offer the Team panel, and the two rate
screens agree in both directions.

---

# 14 October, later — the blank page

Version 1.2.1. Web and hosting config only; no database change.

A refresh of the live site showed nothing but the blue background. Two
fallbacks had lined up, and each one is a defect on its own.

### 25. The host answered a missing asset with the HTML shell

`vercel.json`, `netlify.toml` and `deploy/nginx.conf` all ended with a
catch-all that sends any unmatched path to `index.html` — the normal
arrangement for a single-page app. But it applied to `/js/app.js` too. When
that file was missing from a deployment, the browser asked for a JavaScript
module and was handed a page of HTML with a perfectly valid `200 OK`. It threw
`Unexpected token '<'`, nothing rendered, and the page gave no clue at all —
no error on screen, and a 200 in the network tab.

All three configs now exclude `/js/`, `/css/`, `/icons/`, `sw.js` and the
manifest from the catch-all. A missing asset 404s honestly and the console
names the file.

### 26. The service worker did the same thing, and cached the result

On a network failure the worker returned `index.html` for *any* request it
could not satisfy, scripts included — the same blank page, but reached from
the other direction. Worse, because the host's rewrite returned a valid 200,
the worker happily cached that HTML against the `/js/app.js` key. From then on
the app stayed blank even after the real file was deployed, until the cache
name changed.

Now: the shell stands in only for a navigation; anything else gets an honest
`504`. And HTML is never cached against a `.js`, `.mjs`, `.css`, `.json` or
`.webmanifest` url, whatever status it arrives with. The cache name is bumped
to `bunksoft-v6` to clear any entry an earlier build poisoned.

### Proving it

`npm run test:sw` — 8 checks driving the real `web/sw.js` in a stubbed worker
scope: a host that rewrites a missing asset to the shell is passed through but
not cached; a genuine module still is; an offline script request gets a 504
rather than HTML; an offline page still gets the shell; a cached module is
still served; and the admin console is never intercepted.

### 27. A comment in vercel.json failed the deployment

The exclusion added for #25 carried a `"//"` key holding the explanation.
Vercel validates every rewrite entry against a strict schema and rejects any
property it does not know, so the build failed and production went red. JSON
has no comments; the reasoning lives in this file instead.

The pattern was also simplified to directories alone —
`/((?!admin|js/|css/|icons/).*)` — so there are no backslash escapes for
path-to-regexp to trip on.

`npm run test:sw` now also validates `vercel.json`: that it parses, that no
entry carries a key Vercel would reject, that there is no unknown top-level
key, and that the catch-all does not match `/js/`, `/css/` or `/icons/` paths
while still matching an ordinary route. That check fails on exactly the
mistake that broke this deployment.

---

# 14 October, evening — three more from testing

Version 1.3.0. **`supabase/fixes.sql` must be run again** — it has gained a
trigger. It is safe to run on a database that already has it.

### 28. The opening meter reading could be typed over

It is carried from the previous shift's closing, and it decides how many
litres the shift is credited with. Any operator could edit it: lower the
opening and the shift shows more litres sold than passed the meter; raise it
and fuel disappears. Nothing on screen discouraged it.

The field is read-only now. An owner or manager can unlock it deliberately —
a button, a confirmation naming what unlocking changes — for the one case
that needs it, a meter reset or swapped. The unlock lasts until the shift is
saved or the date or shift changes, then it locks again on its own.

### 29. A tank accepted more than it could hold

A decantation larger than the room left was a confirmation, so a mis-keyed
80,000 for 8,000 went through on a reflex OK and left the tank holding more
than its capacity. This is not a judgement call — the fuel will not go in —
so it is refused outright, and the message says how much will fit. The one
legitimate escape is named: if the book figure itself is wrong, record a dip
first and it corrects with a trail. A load that fits is unaffected.

A dip larger than the tank's capacity is refused the same way.

### 30. Deleting a dip left the stock where the dip put it

`dips_stock` fired on INSERT only. A dip SETS stock, so recording 7,180 L
against a book figure of 8,000 moved the tank to 7,180 — and deleting that
dip, a mis-keyed figure say, left the tank standing at 7,180 with nothing on
record to explain it. The 820 L never came back.

`trg_dip_undo()` now fires on DELETE and gives it back as an adjustment, not
a reset, so sales and decantation since the dip survive. If a *later* dip has
been taken on the same tank, that one already decides the figure and deleting
the older one correctly changes nothing.

### Proving it

Twelve new checks in `npm run test:domain` (57 now): the opening is read-only
and a scripted edit does not survive, the unlock round-trips, an over-capacity
load and an over-capacity dip are both refused while a load that fits is
accepted, and deleting a dip restores the tank. The trigger's three cases —
undo, a sale surviving the undo, and an older dip under a newer one — are
proved directly against Postgres.

`test/headers.mjs` now reads `vercel.json` as JSON rather than by regex; a
reflow of that file's whitespace had made the policy comparison silently find
nothing.
