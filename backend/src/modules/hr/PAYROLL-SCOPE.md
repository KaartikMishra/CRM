# HR Phase 6 — Payroll & Compensation: what was specified, decided, and deliberately not built

Following the precedent of `PERFORMANCE-SCOPE.md`, `TESTING-NOTES.md` and
`services/SCHEDULING.md`: a decision record kept beside the code, so the next
person can tell a requirement from an implementation choice without
reconstructing a conversation.

---

## THE HEADLINE: this is not compliance-certified payroll

**This module computes what it is configured to compute. It makes no statutory
claim in any jurisdiction, and it must not be represented as doing so.**

No provident-fund rate, no insurance threshold, no tax slab, no overtime
multiplier and no rounding policy appears anywhere in this codebase as a
constant, a column default, a CHECK constraint or a validator. Each is either a
configured `SalaryComponent` row or an `HRSetting` value.

That was a deliberate decision, taken explicitly, and the reasoning is:

- A rate written into a shipped binary is a legal claim the code cannot
  substantiate.
- It cannot be corrected without a deploy, and payroll errors are recovered from
  people's livelihoods.
- Statutory rules differ by jurisdiction, change by financial year, and depend on
  facts about the employer this system does not hold.

**Before this module is used to pay anybody**, somebody competent in the
applicable law must configure the components and verify the output. The UI says
so on every payroll surface (`NOT_STATUTORY_NOTICE`), the finalisation endpoint
*requires* an explicit `acknowledgeNotStatutory: true`, and every payslip carries
the same statement in its immutable snapshot.

### FINALIZED is not PAID

Nothing in this module moves money. There is no bank integration, no payment
file, no settlement status. `FINALIZED` means *the figures are locked and
payslips may be issued*. The UI label reads "Finalised — ready for payment", and
a frontend test asserts that no status label anywhere contains the word "paid".

Marking a row paid when no instruction has been issued would make the system
assert something untrue about an employee's livelihood.

---

## What was specified

The phase arrived as a prompt describing a Payroll & Compensation MVP:
configurable salary components, salary structures, effective-dated employee
assignments, compensation history, a monthly payroll lifecycle
(DRAFT → CALCULATED → SUBMITTED → APPROVED → FINALIZED), attendance/leave/overtime
integration "only where the existing data and explicit policy support the
calculation", immutable snapshots, transactional and idempotent processing,
approval and separation of duties, payslips with employee self-service,
authorized reporting and export.

**There is still no requirements document in this repository** — the same finding
`PERFORMANCE-SCOPE.md` records. Every HR phase's scope has arrived as a prompt.

The prompt was explicit about what *not* to invent: "Do not invent unpaid-leave
formulas, overtime multipliers, tax rates, PF/ESI/TDS rules, statutory thresholds
or rounding policies." That instruction shaped the whole module and is the reason
for the headline above.

## Three decisions escalated rather than assumed

Three questions changed the **data model** rather than a config value, so getting
them wrong would mean a migration rewrite. They were put to the project owner and
answered on 2026-10-17:

| Question | Decision |
|---|---|
| Per-day monetary basis | **Configurable per period.** Store both `calendarDays` and `workingDays` plus the resolved `payableDaysDivisor`; an HRSetting selects `CALENDAR_DAYS` / `WORKING_DAYS` / `FIXED_THIRTY`. Rejected hard-coding a 30-day divisor. |
| Statutory deductions | **Generic configurable components, no built-in statutory math.** PF/ESI/TDS are ordinary `SalaryComponent` rows. Rejected implementing Indian FY2026 rates. |
| Who may finalise | **APPROVE grant, and never for a run containing one's own salary.** The subject is refused *first*, before any permission check. The stricter two-person rule (calculator ≠ approver) was declined. |

---

## Implementation decisions, not requirements

Each of the following filled a gap the agreed scope did not settle. **None is a
business rule handed down.** Each is isolated so changing it is a small edit.

### Payable days include holidays and week-offs

`payableDaysFor` counts present + paid leave + holidays + week-offs. Unpaid leave
is the only thing that reduces pay.

Chosen because a monthly salary is a monthly salary: an employee is not docked
for a Sunday. A business paying only for days worked configures a different
divisor basis, which is why the basis is configurable.

**Unpaid leave is detected from data, not a formula.** `LeaveType.isPaid` already
existed from Phase 2; the repository reads it. The module does not decide which
leave is paid.

### The four-pass evaluation order

FIXED earnings → PERCENT_OF_BASE → FORMULA_BALANCE → PERCENT_OF_GROSS.

A `PERCENT_OF_GROSS` component is therefore never an input to another one. That
restriction is not a simplification: a percentage of a total that includes itself
is a fixed-point problem, and iterating to a figure nobody can reproduce by hand
is worse than refusing the configuration. `validateComponentSet` refuses it.

### Proration divides once

`prorateAmount(monthly, payableDays, divisor)` performs one division rather than
`dailyRate × days`. Rounding to a daily figure first magnifies the error by the
day count — at 30 days a half-paisa becomes fifteen. Asserted:
`prorate('10000.00', 15, 31)` is `4838.71`, where the naive route gives `4838.70`.

A full month short-circuits to the stated salary with **no rounding applied**, so
an employee present all month is paid precisely their figure.

### Employer contributions do not reduce net pay

`EMPLOYER_CONTRIBUTION` is a third component kind, separate from `DEDUCTION`.
Both are costs; only a deduction reduces net pay. An employer's share of a
retirement fund never passes through the employee's hands, and netting it off
their payslip would understate what they were paid. Net = gross − deductions.

A business that genuinely wants an employee-borne contribution configures it as a
`DEDUCTION`. That is the one explicit path.

### A negative net is reported, never clamped

Deductions exceeding earnings is a real condition. `calculateEmployeePay` returns
`isNegativeNet`, the service blocks submission *and* finalisation, the UI renders
the figure in the critical tone, and `PayrollItem.netPay` is deliberately **not**
CHECK-constrained — a constraint there would make the run fail instead of
reporting the problem.

### Overtime is valued only when fully configured

Both an `overtime.multiplier` and an `overtime.standard_day_minutes` HRSetting
must exist. With either missing, the approved minutes are reported in
`notApplied` — "120 approved overtime minutes were not valued: no overtime
multiplier is configured" — and no OVERTIME line is created.

There is no default. 1.0, 1.5 and 2.0 are all real policies, the applicable one
is frequently statutory, and a guessed multiplier would put a figure on a payslip
nobody configured.

### Other decisions in the same category

- **Salary assignments are append-only.** Changing pay inserts a row with a later
  `effectiveFrom` and closes the previous one's `effectiveTo`, in one
  transaction. There is no update endpoint, because a historical payslip must
  stay explicable from the assignment that produced it.
- **A structure with assignments cannot have its components replaced.** Doing so
  would silently restate what those employees earn. A changed structure is a new
  structure.
- **A component in use cannot be deleted**, only deactivated — a historical
  payslip line names it and the snapshot is keyed on its code.
- **One run per calendar month**, enforced by `@@unique([year, month])`.
- **No path out of FINALIZED.** Corrections are `PayrollAdjustment` rows against
  a later period, so the trail reads forwards.
- **An employee with no attendance records is costed as present for the full
  month**, with a warning saying so. That is the only defensible reading of a
  salaried employee with no attendance, and the warning is what stops it being
  silent.
- **Managers are not a payroll population.** A reporting line is a reason to read
  somebody's attendance or write their appraisal; it is not a reason to read their
  salary. Pay confidentiality runs across the hierarchy, not down it. This is the
  one HR module where `hr-access.ts`'s manager scope deliberately does not apply.

---

## What is a hard rule, and where it is enforced

### Nobody approves or finalises a run that pays them

`mayDecidePeriod` and `mayFinalizePeriod` refuse the subject **first**, before any
permission is consulted. The ordering is the substance: an HR colleague on the
payroll holds APPROVE, and checking the grant first would let them clear their
own pay. Pinned by tests that pass an ADMIN with every grant *and* an employee
record inside the run.

The same shape applies to `mayAssignSalary` (nobody sets their own salary) and
`mayRecordAdjustment` (nobody awards themselves an arrear).

### A finalised run is immutable to everybody

`isPeriodSettled` is consulted before the question of who is asking. The state
machine offers no transition out of FINALIZED. At the database level,
`payroll_item_finalized_has_snapshot` makes a finalised line without its
computation impossible, and
`payroll_period_finalized_has_finalizer` / `payroll_period_finalizer_only_when_finalized`
keep the stamps consistent.

### An employee reads their own pay and nobody else's

- `GET /payroll/mine` takes **no employee id at all**. There is no parameter to
  tamper with — a stronger guarantee than a scope check.
- `GET /payroll/payslips/:itemId` resolves ownership from `Employee.userId`
  against the actor and returns **404, not 403**, for anything else. Telling
  somebody "you may not read employee X's payslip" confirms X is paid and roughly
  when.
- `visiblePayrollItemFilter` returns `null` for a reader entitled to nothing, and
  callers must treat that as "return nothing". Returning `{}` there would be the
  difference between an empty list and the whole company's salaries.

**Ownership is resolved from `Employee.userId`, never by comparing employee
codes.** `User.employeeId` and `Employee.employeeId` are different columns that
usually agree and are not guaranteed to — a Phase 5 defect came from exactly that
comparison.

### Exporting is a separate privilege from reading

`GET /payroll/periods/:id/export` requires `HR_PAYROLL:EXPORT`, not VIEW. Reading
one payslip on screen and downloading every salary in the company are different
risks, and only the second leaves the building. Asserted by a test that revokes
EXPORT from an administrator and confirms they can still read payroll and can no
longer download it.

### No notification ever carries an amount

`payroll.notify.ts` calls `assertNoAmount` on every title and body and **throws
rather than sending**. A notice lands in a bell a colleague may glance at, is
often mirrored to email, and is retained in a table more people can read than can
read a payslip.

The assertion is deliberately broad — grouped thousands, bare two-decimal
figures, currency symbols and codes adjacent to digits. A false positive costs a
developer one rephrasing; a false negative puts somebody's salary in a shared
table.

### No bank credentials are stored

There is no account number, IFSC, sort code or payment-instrument column anywhere
in this module. `SecureDocumentKind.BANK_DETAIL` exists from Phase 1 for
documents, and payroll does not write it. Nothing is collected that the module
does not need.

---

## Idempotency, transactions and concurrency

Three independent mechanisms, because each covers a case the others do not:

1. **`@@unique([year, month])`** on `PayrollPeriod`. Two concurrent creates for
   March both pass the service pre-check; the database refuses the second, and
   the P2002 handler turns it into a readable 409.
2. **`@@unique([periodId, employeeId])`** on `PayrollItem`, reached through
   `upsertItem`. A calculation that runs twice *updates* rows rather than adding
   them — this is what makes recalculation idempotent.
3. **`transitionPeriod`**, a conditional `updateMany` with a status predicate. Two
   concurrent finalisations both pass the service status check; only one matches
   `status IN ('APPROVED')` at the moment of the write, and the second sees
   `count === 0` and is refused.

**Finalisation is one transaction** containing the period transition, every
snapshot write, and every item status change — the last as a single `updateMany`,
not a loop. A partial failure part-way through a loop would leave some lines
FINALIZED and some CALCULATED, which is exactly the partially-finalised state that
must be impossible.

**Calculation is one transaction per employee**, deliberately. Four hundred
employees inside one 15-second transaction would exceed the budget, and one
employee's failure should not stop the other 399. The period's own status and
totals are written in a final transaction once every line has settled, so a period
is never CALCULATED with half its lines missing.

---

## API surface

All paths are under `/api/hr`. **28 routes, every one permission-gated.**

| Method | Path | Permission |
|---|---|---|
| GET | `/payroll/overview` | `HR_PAYROLL:VIEW` **or** `HR_EMPLOYEE:VIEW` |
| GET | `/payroll/mine` | `HR_PAYROLL:VIEW` **or** `HR_EMPLOYEE:VIEW` |
| GET | `/payroll/payslips/:itemId` | `HR_PAYROLL:VIEW` **or** `HR_EMPLOYEE:VIEW` |
| GET | `/payroll/components` | `HR_PAYROLL:VIEW` |
| POST | `/payroll/components` | `HR_PAYROLL:CREATE` |
| PATCH | `/payroll/components/:id` | `HR_PAYROLL:EDIT` |
| DELETE | `/payroll/components/:id` | `HR_PAYROLL:EDIT` |
| GET | `/payroll/structures` | `HR_PAYROLL:VIEW` |
| POST | `/payroll/structures` | `HR_PAYROLL:CREATE` |
| GET | `/payroll/structures/:id` | `HR_PAYROLL:VIEW` |
| PATCH | `/payroll/structures/:id` | `HR_PAYROLL:EDIT` |
| GET | `/payroll/salaries` | `HR_PAYROLL:VIEW` **or** `HR_EMPLOYEE:VIEW` |
| POST | `/payroll/salaries` | `HR_PAYROLL:ASSIGN` |
| GET | `/payroll/adjustments` | `HR_PAYROLL:VIEW` **or** `HR_EMPLOYEE:VIEW` |
| POST | `/payroll/adjustments` | `HR_PAYROLL:APPROVE` |
| GET | `/payroll/periods` | `HR_PAYROLL:VIEW` |
| POST | `/payroll/periods` | `HR_PAYROLL:CREATE` |
| GET | `/payroll/periods/:id` | `HR_PAYROLL:VIEW` |
| PATCH | `/payroll/periods/:id` | `HR_PAYROLL:EDIT` |
| POST | `/payroll/periods/:id/calculate` | `HR_PAYROLL:EDIT` |
| POST | `/payroll/periods/:id/submit` | `HR_PAYROLL:EDIT` |
| POST | `/payroll/periods/:id/decide` | `HR_PAYROLL:APPROVE` + not paid by the run |
| POST | `/payroll/periods/:id/finalize` | `HR_PAYROLL:APPROVE` + not paid by the run |
| POST | `/payroll/periods/:id/cancel` | `HR_PAYROLL:APPROVE` |
| GET | `/payroll/periods/:id/summary` | `HR_PAYROLL:VIEW` |
| GET | `/payroll/periods/:id/export` | **`HR_PAYROLL:EXPORT`** |
| GET | `/payroll/periods/:id/items` | `HR_PAYROLL:VIEW` **or** `HR_EMPLOYEE:VIEW` (server-scoped) |
| POST | `/payroll/periods/:id/items/:itemId/exclude` | `HR_PAYROLL:EDIT` |

The three self-service routes sit on an employee floor because **everybody is
paid**: requiring a payroll grant would mean granting the module to the whole
company, at which point it stops distinguishing anybody. The service then narrows
each to the reader's own record.

`hrActor` in `hr.service.ts` resolves all six `HR_PAYROLL` pairs
(VIEW/CREATE/EDIT/ASSIGN/APPROVE/**EXPORT**). A pair missing from that list
resolves to `false` for everybody including an administrator — the Phase 4 defect,
and EXPORT is the first appearance of that action in the list.

---

## Migrations

Both additive. No existing table altered, no column dropped, zero DROP TABLE /
TRUNCATE / DELETE FROM.

| Migration | Contents |
|---|---|
| `20261017090000_hr_payroll_notification_types` | 4 `ALTER TYPE … ADD VALUE IF NOT EXISTS` on `NotificationType` |
| `20261017091000_hr_payroll_compensation` | 10 tables, 8 enums, 28 indexes, 21 FKs, **40 CHECK constraints** |

Separate migrations because PostgreSQL cannot use a newly added enum value in the
same transaction that adds it — the same split as Phases 3, 4 and 5.

### Six drift statements were stripped by hand

`prisma migrate diff` again emitted six statements unrelated to payroll that would
have converted three live Sales/Procurement foreign keys from `ON DELETE RESTRICT`
to `ON DELETE SET NULL`:
`PurchaseBill_reviewedById_fkey`, `PurchaseItemProductChange_reviewedById_fkey`,
`SalesOrder_cancelledById_fkey`.

**Both halves had to be removed, not just the DROPs.** Removing only the three
`DROP CONSTRAINT` lines would leave three `ADD CONSTRAINT … SET NULL` lines — the
precise opposite of preserving them. The stripped file was then grepped for any
surviving non-comment reference to those tables (none), and `pg_constraint` was
queried after applying to confirm all three remain `confdeltype = 'r'`.

This is long-standing drift between `schema.prisma` and the live database, present
since before Phase 5. Reconciling it is a separate change with its own review.

### Models

`SalaryComponent`, `SalaryStructure`, `SalaryStructureComponent`, `EmployeeSalary`,
`EmployeeSalaryComponent`, `PayrollPeriod`, `PayrollItem`, `PayrollItemLine`,
`PayrollAdjustment`, `PayrollCodeCounter`.

Enums: `SalaryComponentKind`, `SalaryCalculationKind`, `DailyRateBasis`,
`MonetaryRoundingMode`, `PayrollPeriodStatus`, `PayrollItemStatus`,
`PayrollExclusionReason`, `PayrollAdjustmentKind`.

All money is `Decimal(12,2)`, totals `Decimal(14,2)`, day counts `Decimal(5,2)`,
rates `Decimal(6,2)` — matching the existing schema's conventions.

---

## Configuration required before use

Nothing in the database is configured out of the box: the development database had
**0 HRSetting rows and 0 LeaveType rows** at the start of this phase.

| Setting | Key | Effect if absent |
|---|---|---|
| Daily-rate basis | `HR_PAYROLL` / `daily_rate.basis` | Defaults to `CALENDAR_DAYS` |
| Rounding mode | `HR_PAYROLL` / `rounding.mode` | Defaults to `HALF_UP` |
| Overtime multiplier | `HR_PAYROLL` / `overtime.multiplier` | **Overtime is not valued**, and the payslip says so |
| Standard working day | `HR_PAYROLL` / `overtime.standard_day_minutes` | Same |

Also required: at least one `SalaryComponent` set (and a `SalaryStructure`
assembling them), `LeaveType` rows with `isPaid` set correctly, and `Holiday` /
attendance data if the `WORKING_DAYS` basis is used — without it the divisor falls
back to calendar days **and reports the fallback as a blocker**.

---

## Known limitations and remaining work

1. **Not compliance-certified.** The headline. No statutory rule is implemented.
2. **No payslip PDF.** `PayrollItem.payslipDocumentId` and the `SecureDocument`
   wiring exist, but no document is generated — the payslip is a rendered page.
   Generating one is the natural next increment and needs no schema change.
3. **No bank payment file or integration.** Deliberate; see "FINALIZED is not
   PAID".
4. **The calculator is not excluded from approving.** The user declined the
   two-person rule, so the person who ran a calculation may approve it provided
   they are not paid by it. `mayFinalizePeriod` has the hook if that changes.
5. **Single currency per period.** `currency` is stored on the period, the
   assignment and the item, so multi-currency is a migration rather than a
   rewrite — but cross-currency runs are not supported.
6. **No year-to-date totals or tax projections.** Out of scope for an MVP, and
   both would imply statutory knowledge the module does not have.
7. **Adjustments are not auto-claimed by a future period.** They attach when a
   calculation runs and finds them; a period finalised before an adjustment is
   recorded does not pick it up retroactively, which is correct, but there is no
   queue view showing unclaimed adjustments.
8. **`PayrollPeriod` is outside the fixture sweep's name-based reach**, because
   its identity is `(year, month)` rather than a name. The test suite takes a
   per-run far-future base year instead; the sweep removes emptied periods in the
   2100–2199 band.
9. **The browser-driven workflow test from Phase 5 has no Phase 6 equivalent.**
   Coverage is HTTP-level plus structural frontend assertions. No Playwright is
   installed, so hydration errors and client-only validation would not be caught.

---

## Deployment and staging verification

**Production deployment is blocked** until the following are done, in order:

1. **Rehearse both migrations on a staging copy of production data.** They are
   additive, but the drift note above means staging must be checked for the same
   three `RESTRICT` constraints before and after — `confdeltype` must still be
   `'r'` for all three.
2. **Configure the four HRSettings and at least one component set**, then verify a
   calculation against hand-worked figures for two or three real employees.
3. **Confirm `LeaveType.isPaid` is correct for every leave type.** Unpaid-leave
   proration reads it directly; a type wrongly marked paid silently overpays.
4. **Have somebody competent in the applicable law verify the configured
   statutory components** before any run is finalised.
5. **Smoke-test the separation of duties with two real accounts** — one payroll
   administrator who is on the payroll, one approver who is not — and confirm the
   first cannot finalise.
6. **Verify an ordinary employee sees only their own payslip**, by signing in as
   one and attempting another employee's payslip id (expect 404).
7. Rebuild `backend/dist` and restart the API before verifying routes — new routes
   404 against a stale `dist`.
