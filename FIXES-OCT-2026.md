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
