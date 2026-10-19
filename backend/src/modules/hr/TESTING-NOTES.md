# HR test-suite characteristics, and one open caveat

Following the precedent of `services/SCHEDULING.md`: a short decision record kept
beside the code rather than in a conversation, so the next person reads it before
re-diagnosing something already understood.

## The open caveat: `recruitment.test.ts` has never passed 68/68 in one run

Two complete runs, each 67 passed / 1 timed out at 60 s — and **a different test
timed out each time**, which is itself the strongest evidence that neither is a
defect in the test that happened to fail.

| Run | Result | Timed-out test | Duration |
|---|---|---|---|
| Phase 3 | 67/68, exit 1 | `onboarding > writes a JOINED history entry in the same transaction` | 1252 s |
| Phase 5 "Gate 1" | 67/68, exit 1 | `offers > refuses an expiry after the proposed start date` | 897.27 s |

Both recorded as **suspected infrastructure, not confirmed code defects**.

### Evidence for the Phase 3 run

- The same assertion **passed** in an earlier run of the same file.
- The path is exercised end to end by the live walkthrough — employment record
  created, number allocated, placement carried from the onboarding record.
- `Error: Test timed out in 60000ms`, no assertion message. The run also logged one
  `P2024` (connection-pool timeout, limit 17): Neon dropping pooled connections
  during a long run rather than a stuck query.

### Evidence for the Gate 1 run, which was investigated in depth

The failing test's setup contains one `POST /applications/:id/stage` that took
**151,223 ms and returned HTTP 200**. Body-size fingerprinting of the four stage
calls (23/25/29/22 bytes) identifies it as the `FINAL_INTERVIEW` transition — the
one stage with a notification side-effect ([recruitment.service.ts:1229]).

It is nonetheless **not that code path being slow**:

- **23 `FINAL_INTERVIEW` calls in the same run: one at 151,223 ms, the other 22
  between 1,600 and 2,537 ms** (median 1,649 ms).
- The server was **not blocked** — 37 other requests completed normally (1.6–5.0 s)
  *during* the 151 s window.
- It cannot have stalled inside a transaction: the `$transaction` closes before the
  notification work and `TX_OPTIONS = { timeout: 15_000 }` would have thrown
  **P2028** at 15 s. Zero P2028 in the run.
- It was not a notification *failure*: `raise()` and `deliver()` both catch and log
  at **error** level, and the run logged **zero** level-50 lines. The path waited.
- The same client connection served 1.1–1.7 s requests immediately before and
  **1,654 ms on the very next request**.
- 84 seconds of total log silence; throughput collapsed from ~40 req/min to 2.
- Zero `P2024`/`P1017`/`ECONNRESET` and **zero 5xx** across all 443 requests.

Reruns of that single test: **exit 0 twice** (45.93 s, 40.81 s), with
`FINAL_INTERVIEW` at 1,718 ms and 1,661 ms. Not reproducible.

The reading is a Neon compute suspend/resume mid-run. `vitest.global-setup.ts`
records that "a cold resume has been observed to take about a minute"; 151 s is
roughly 2.5× that.

**One latent fragility this exposed, not yet changed:** `deliver()` awaits
`repo.findByEntity` with **no timeout** and swallows its own errors, so a stalled
connection on that path becomes an invisible hang rather than a fast failure. A
bounded timeout there would turn this class of stall into a logged error.

**What has NOT been established:** that the full 68-test file passes in a single
run. Both complete runs were 67/68 with a timeout. The targeted reruns above cover
one test, not all 68. Anybody claiming "the backend suite is green" should run it
first — this note exists so that claim is not inherited on trust.

## Why these suites are slow, and what was already done about it

Every HR suite runs real HTTP against the real Express app and a remote Neon
database. `vitest.config.ts` already sets `fileParallelism: false` and
`sequence: { concurrent: false }`, so the cost is volume rather than contention: a
single test that walks an application to an accepted offer is ten or more sequential
round-trips.

Phase 3's file was shortened once for exactly this reason. One shared published
requisition (`sharedPublishedJob`) now serves the twenty tests that need only *a*
vacancy, which removed about forty round-trips. That is safe because an application
is unique per (candidate, job) and every test mints its own candidate, so two tests
on one requisition cannot collide. The tests whose subject *is* the requisition —
publish, pause, close, scope isolation, one candidate across two roles — still build
their own.

If the suite needs shortening again, extend that pattern. Do **not** raise
`testTimeout` to hide a pool timeout: that converts a visible infrastructure fault
into a slow suite that still fails intermittently.

## Two traps this module has already fallen into

**1. Never pipe vitest through `tail` or `head`.** It truncates the failure reports
and — worse — the shell reports *the pipe's* exit code, so a failing suite reads as
exit 0. This happened twice here; the second time it hid ten of fourteen failures.
Redirect to a file and capture `$?` explicitly.

**2. Fixture ownership must trace a column the service actually writes.** Teardown
originally matched job requisitions on `code: startsWith 'ZZT'`, but the service
allocates its own codes as `JOB-<year>-<n>` — the ZZT prefix is on the *department*
code and never reaches the requisition. Every test requisition survived teardown
silently until a manual row count found 142 of them. Teardown now traces
`createdById` against this run's own users, and `residualTestRows` counts
requisitions so the same class of leak fails the suite's own assertion instead of
accumulating.

`RecruitmentCodeCounter` rows are deliberately **not** deleted by teardown. They are
keyed by series and period ("JOB-2026"), not by run — shared infrastructure rather
than fixtures. Deleting one would reset the sequence and let a later run reissue a
reference an earlier run already used, which is precisely what the counter exists to
prevent.

## A standing requirement, not a test issue

`npm start` runs `node dist/server.js` — a fixed snapshot, not a watcher. A rebuild
does **not** reach the running process. This project has been bitten six times, and
twice the misleading signal was a `401`: `requireAuth` sits on the whole `/api/hr`
router, so a deliberately nonexistent path also returns 401. A 401 therefore proves
nothing about whether a route is loaded.

After any backend change: build, restart, then verify with an **authenticated**
request. The session JWT needs issuer `royalstuffs-crm` and audience
`royalstuffs-crm-api` (`shared/src/constants/index.ts`) — a mismatched audience
yields 401 and looks exactly like a missing route.

## Test evidence, by phase

Recorded here so a reviewer can tell what was actually run from what was merely
written. Every figure below is an exit code captured from a direct run, never from
output piped through `tail` — see the trap note above for why that distinction is in
this file at all.

### Phases 1–3 and the cross-cutting foundation

One serial 11-file run, **exit 0, 334/334 passed, 621.80 s**:

| Suite | Result |
|---|---|
| `__tests__/leave.test.ts` (HTTP, real Neon) | 55 passed (247.40 s) |
| `__tests__/hr.test.ts` (HTTP, real Neon) | 51 passed (157.39 s) |
| `__tests__/attendance.test.ts` (HTTP, real Neon) | 42 passed (136.94 s) |
| `__tests__/attendance-calc.test.ts` (unit, pure) | 43 passed (1.15 s) |
| `__tests__/leave-calc.test.ts` (unit, pure) | 40 passed (0.79 s) |
| `__tests__/hr-access.test.ts` (unit, pure) | 24 passed (0.81 s) |
| `services/__tests__/approval-foundation.test.ts` (HTTP) | 20 passed (34.36 s) |
| `services/__tests__/secure-document.test.ts` (HTTP) | 20 passed (13.14 s) |
| `services/__tests__/hr-setting.test.ts` (HTTP) | 15 passed (22.06 s) |
| `policies/__tests__/approval-foundation.test.ts` (pure) | 14 passed (0.77 s) |
| `policies/__tests__/approval.test.ts` (pure) | 10 passed (0.80 s) |

Zero timeouts, zero `P2024`/`P1017`/`P2028`/`P2002`/`P2003`/`P2025`, zero
`ECONNRESET`/`ETIMEDOUT`, zero connection-pool errors, **zero 5xx** across 355
requests; slowest 7,505 ms, median 1,303 ms. The 4xx responses in that run are all
intentional negative-path assertions.

Note `approval-foundation.test.ts` exists in **two** directories — `policies/`
(pure) and `services/` (HTTP) — and both are in the figures above.

`services/__tests__/hr-permissions.test.ts`: **14 passed, exit 0**, after the two
stale count assertions were corrected. See the targeted-regression section below.

### Phase 4 — Training & Learning Management

| Suite | Result |
|---|---|
| `__tests__/training-calc.test.ts` (unit, pure) | 45 passed, exit 0 |
| `__tests__/training-onboarding.test.ts` (HTTP, real Neon) | 5 passed, exit 0 (312 s) |
| `frontend/__tests__/training.test.ts` | 44 passed, exit 0 |

The onboarding integration test covers what the earlier walkthrough had skipped: the
first link creates and attaches the right enrollment, a repeat is idempotent (one row
counted in the database, not inferred from the response), a cross-employee link is
refused, linking before the employment record exists is refused, and completing the
training settles the checklist task unattended.

### Phase 5 — Performance Management

| Suite | Result |
|---|---|
| `__tests__/performance-calc.test.ts` (unit, pure) | 111 passed, exit 0 |
| `__tests__/performance-review.test.ts` (HTTP, real Neon) | 30 passed, exit 0 (542 s) |
| `__tests__/performance-ui-workflow.test.ts` (rendered pages) | 15 passed, exit 0 (141 s) |
| `frontend/__tests__/performance.test.ts` | 58 passed, exit 0 |

`performance-review.test.ts` and `performance-calc.test.ts` were re-run together after
the late `viewerIsSubject` change: 141 passed, exit 0.

### Phase 6 — Payroll & Compensation

| Suite | Result |
|---|---|
| `__tests__/payroll-calc.test.ts` (unit, pure) | 70 passed, exit 0 (3.7 s) |
| `services/__tests__/…` n/a — payroll has no separate service suite | — |
| `__tests__/payroll.test.ts` (HTTP, real Neon) | see the caveat below |
| `frontend/__tests__/payroll.test.ts` | 56 passed, exit 0 (0.4 s) |
| `frontend/__tests__/navigation.test.ts` | 42 passed, exit 0 (3 updated for the new Payroll row) |

The 70 unit tests are where the arithmetic guarantees live: proration under all
three divisor bases (which disagree — 15,000 / 15,500 / 17,884.62 on the same
salary and day count), unpaid-leave proration, all three rounding modes at the
half-paisa boundary, single-rounding proration (`prorate(10000, 15, 31)` is
4838.71, where `dailyRate × 15` gives 4838.70), overtime valued only when both
policy inputs are configured, deductions counted exactly once, employer
contributions excluded from net pay, negative net detected rather than clamped,
zero-value and empty component sets, eligibility in all six cases, and FINALIZED
terminal in every direction.

### The payroll HTTP suite is latency-sensitive, and that is documented not hidden

`payroll.test.ts` drives 50 tests over real HTTP against remote Neon. Four
consecutive runs of **identical application code** gave four different results:

| Run | Result | Duration | Failure kind |
|---|---|---|---|
| 4 | 48 passed / 2 failed | 820 s | 2 timeouts (fixture bugs, since fixed) |
| 5 | 46 passed / 4 failed | 2926 s | **4 timeouts, 0 assertions** |
| 6 | 36 passed / 0 failed / **14 skipped** | 1206 s | Neon closed the connection in a `beforeAll` |
| 7+8 | the 14 skipped, run alone: **14 passed** | 238 s | — |

**Across all runs, every one of the 50 tests has passed, and no failure has ever
been an assertion about payroll behaviour.**

Run 5's four failures were all `Error: Test timed out in 60000ms` with zero
AssertionErrors; three failed at exactly 60,010 ms — the timeout, not the
assertion — and all four had passed in run 4.

Run 6 produced no assertion failures at all. Its single reported failure was a
`beforeAll` hitting **"Server has closed the connection"** — four such errors in
that run, located in `middleware/requireAuth.ts`,
`services/permission.service.ts` and the fixture cleanup, and **none in payroll
code**. That cascaded into 14 skips across two `describe` blocks. Re-run on their
own against a warm database, those 14 passed (runs 7 and 8), including the two
that matter most for confidentiality: "returns 404 — not 403 — for another
employee's payslip" and "refuses a reader who holds VIEW but whose EXPORT is
revoked".

Run 5 also produced the module's only P2028:

> Transaction already closed … The timeout for this transaction was 15000 ms,
> however 15127 ms passed since the start of the transaction.

on `POST /payroll/periods`, which is **two statements** — allocate a code, insert
a row. Nothing was doing too much work; each round trip had taken seconds.

**What was changed as a result:** `TX_OPTIONS_CRITICAL` (45 s) now covers period
creation and finalisation, the two transactions where failing is worse than being
slow. It is deliberately *not* applied to the per-employee calculation loop,
where a tight budget is what stops one pathological row stalling a whole run. A
transaction that commits in 200 ms is unaffected by its ceiling.

**What this does and does not establish.** It establishes that every assertion in
the suite holds — each has been observed passing against the real database. It
does **not** establish that the suite passes 50/50 in a single run; that has not
yet been observed, and the obstacle each time has been Neon's responsiveness
rather than the code.

Anybody reading a result here should check the duration first: around 820 s is a
healthy run, and anything near 3000 s is not — its failures should be re-examined
as latency before being believed as defects. A `beforeAll` failure skipping a
whole block is the signature of a dropped connection, not of broken logic.

An end-to-end walkthrough (`PAYROLL-SCOPE.md`, deployment section) additionally
exercises the whole lifecycle against the live API with three separate
authenticated sessions — components through finalisation, payslip self-service,
cross-employee denial and export authorisation — and passed 26/26 on a warm
database.

### Phase 6 fixture note

`PayrollPeriod` is uniquely keyed on `(year, month)` — the duplicate-run
guarantee the suite exists to test. That makes a fixed test year self-defeating:
the second execution finds the first's periods and every `openPeriod` returns
409. Periods also carry no name for `RUN_PREFIX` to match, so the sweep cannot
reach them by ownership.

The suite therefore takes a **per-run base year** derived from the process id and
bounded into 2100-2199, and `fixtures.ts` was extended to sweep payroll rows:
items and adjustments by the employee's `RUN_PREFIX` work email, assignments
after them, then emptied periods within that year band, then unused structures
and components. The order matters because payroll uses `Restrict` on the two
links that explain a historical figure.

### What the UI workflow suite needs, and what it does not prove

`performance-ui-workflow.test.ts` requires **both servers running from current
builds** — Express on :4000 and Next.js on :3000. It checks for them in `beforeAll`
and fails with an instruction rather than skipping, because a suite that silently
skipped would report green while proving nothing.

It renders real pages with two separate sessions and asserts the HTML. What it does
**not** cover is client-side interaction: no Playwright or Puppeteer is installed, so
submit buttons are exercised through their server actions' underlying API rather than
by clicking. Hydration errors and client-only validation would not be caught.

### What has NOT been run

**The full backend regression — roughly 1h53m against remote Neon — has not been
run on this work.** It was deliberately skipped each time, by instruction, because
the cost is an hour and fifty minutes per attempt against a remote database. What
*has* been run is every HR suite plus the full frontend suite.

So the accurate statement is: **the HR suites are green, a targeted cross-module
regression is green, and the whole-repository backend regression is unverified.**
Anybody about to describe the backend as "fully green" should run it first.

### What a targeted regression did verify (Phase 5)

A 15-file run chosen for the shared surfaces HR touched — 373 tests, 995.01 s,
**exit 1 solely from two stale assertions in `hr-permissions.test.ts`**, since
corrected and re-verified at exit 0 (14/14). Every other file passed:

- representative suites for all six modules at risk: Sales, Procurement, Dispatch,
  Lead, Post Sales, RS Products
- all seven existing test files touched by the `TEST_PREFIX` → `RUN_PREFIX` fixture
  rename, which was the likeliest place for a regression
- `fixture-cleanup-scope` and `fixture-notification-cleanup`, covering the
  run-ownership sweep itself

A separate 11-file HR run then covered every HR suite that lacked first-hand
evidence: **exit 0, 334/334, 621.80 s**, zero timeouts, zero Prisma errors, zero
5xx, slowest request 7,505 ms.

The two stale assertions are worth recording because neither was an HR defect: one
counted "nine pre-existing modules" when `RS_PRODUCTS` had shipped as a tenth
(commit `e375902`, before HR Phase 4), and one omitted `HR_TRAINING` from the
no-top-level-navigation list. Literal counts in a vocabulary test go stale on
correct work; both are now partition and by-name assertions instead.

Specifically still unverified:

- the other backend test files, which no run in this work has executed. The
  Phase 5 targeted run covered 15 of 74; Phase 6 added two files and did not
  re-run the rest.
- `recruitment.test.ts` in a single complete run. See the open caveat above: both
  complete runs were 67 passed / 1 timed out, and the Phase 5 reruns covered only
  the one failing test.

### One thing the unit tests missed, and why it matters here

The frontend unit tests asserted that the "am I the subject" comparison *existed*.
They could not tell that it never *resolved* — `User.employeeId` and
`Employee.employeeId` are different columns. The browser-driven suite caught it on
the first run. That is the whole argument for keeping a rendered-page test in this
module: a structural assertion tests a line, not a behaviour.

See `PERFORMANCE-SCOPE.md` for the defect, the fix and what remains outstanding.
