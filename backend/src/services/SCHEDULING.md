# Scheduled work in the RS CRM — the decision, and what HR must follow

**Status:** decision recorded in Phase 0.5. No scheduler code was written in this
phase; HR has no time-based work yet. This document exists so Phase 1 builds its
first scheduled job the same way the existing two are built, instead of choosing
again from scratch.

## The decision

**Boot sweep + `setInterval`, registered in `server.ts`, with correctness coming
from conditional database updates rather than from the timer firing.** No cron
daemon, no job queue, no new dependency.

This is not a new decision. It is the architecture the CRM already runs, and the
point of writing it down is that the next person adding scheduled work should
extend it rather than introduce a second mechanism alongside it.

## What already exists

Two scheduled jobs, both registered in [`server.ts`](../server.ts):

| Job | Interval | What it does |
|---|---|---|
| `purgeExpired` (notification) | 24 h | Removes notifications past the 30-day retention window |
| `sweepOverdueRequests` (dispatch) | 5 min | Allows partial-dispatch requests whose 24-hour deadline passed unanswered |

Both follow the same five rules, which are the actual substance of the decision.
`dispatch-sweep.service.ts` documents them at length; they are summarised here
because HR's jobs will need every one.

### 1. The deadline is a column, never a timer

A `setTimeout` for 24 hours dies with the process. Deploy, crash or restart inside
that window and the deadline is forgotten — the row sits pending forever.

So the deadline is stored, and a sweep asks the database which rows have passed
it. A process that was down across a deadline settles it on the next boot, which
is why there is a boot sweep as well as an interval.

### 2. The clock is the database's

`databaseNow()` inside the transaction, never `Date.now()`. A server with a skewed
clock must not be able to settle work early or leave it hanging.

### 3. Every write is conditional on the state it expects

`updateMany({ where: { id, status: 'PENDING' } })`, not `update({ where: { id } })`.
This is what makes the job safe, and it is worth being precise about why: it means
a human deciding the same row in the same second matches zero rows in the sweep
and their decision stands. It also means a second process, or the same process
after a restart, cannot double-process anything.

The in-memory `inFlight` flag in the dispatch sweep is an optimisation that stops
one process overlapping itself. **It is not the safety mechanism.** Anyone copying
this pattern must copy the conditional update, not the flag.

### 4. One row per transaction, and a bounded batch

A batch-wide transaction makes one contended row roll back everything else in the
pass. A `SWEEP_BATCH` cap stops a long backlog — a process down for a week —
turning one sweep into an unbounded run. Whatever is left is taken next pass; the
deadlines are already past, so ordering oldest-first is what matters.

### 5. `void` and `unref()`

`void sweepX()` so a slow first sweep never delays the port being served, and
`interval.unref()` so a pending tick cannot hold the process open during
shutdown. An interrupted sweep is simply redone, which rule 3 guarantees is safe.

## Why not cron, and why not a queue

**No cron daemon.** It lives outside the application, so it does not deploy with
the code, cannot be tested in the suite, and has no access to the typed service
layer — a cron entry invoking a script is a second entry point to the business
logic with its own connection handling and its own error reporting. The existing
jobs are plain exported functions, which is why
[`dispatch-sweep.test.ts`](../modules/dispatch/__tests__/dispatch-sweep.test.ts)
can call one directly and assert what it did.

**No job queue (BullMQ, Agenda).** A queue buys retries, backoff, concurrency
across workers and scheduled one-off jobs. All of it needs Redis, which this
deployment does not run, and none of it is needed for work that is idempotent by
construction: rule 3 makes a retry a no-op, so the retry machinery has nothing to
add. The honest trigger for revisiting this is a job that is *not* idempotent, or
one that must fan out across more than one process — neither of which HR has
described.

**No `node-cron`.** It is a `setInterval` with a crontab parser. If a job ever
genuinely needs "03:00 on the first of the month" rather than "every N minutes",
that is the moment to add it — one dependency, inside the same `server.ts`
registration. Payroll may well be that job (see below), and until its
requirements are written down, guessing at them would be inventing a schedule the
business then has to work around.

## What HR will need, and the one case that needs more thought

Phase 1 ships no scheduled work. These are the jobs the HR requirement implies,
with the rule that each one must satisfy:

| Likely job | Shape | Notes |
|---|---|---|
| Mark absent anyone with no attendance record for a closed day | Sweep on a date column | Straightforward rule-3 job. The "closed day" boundary must come from an `HRSetting`, not a constant |
| Accrue monthly leave balance | Sweep, idempotent per (employee, period) | Needs a stored "last accrued period" so a double run is a no-op. **Do not** derive it from the current date alone |
| Expire carried-forward leave at year end | Sweep on an expiry column | Same shape as the dispatch deadline |
| Auto-escalate an approval nobody decided | Sweep on `ApprovalRequest.requestedAt` | The table and its index `(status, module, requestedAt)` already support this. Escalation policy is deliberately not built yet |
| Probation-ending and document-expiry reminders | Sweep + notification | Reuses the existing `Notification` table |

**Payroll is the one that does not fit cleanly, and it should not be forced to
fit.** A payroll run is not idempotent in the way the jobs above are — it produces
money figures somebody is accountable for — and it is not obviously something a
timer should start at all. The likely right answer is that payroll is *initiated
by a person* and the scheduler's only role is to remind them, which keeps rule 3
intact because nothing irreversible happens on a tick. That is a business decision
and is explicitly left open here rather than settled by whoever writes the first
cron expression.

## Adding a job

1. Export a plain `async function` from the owning service. No timer inside it.
2. Give it a bounded batch and a conditional write, per rules 3 and 4.
3. Read its interval from a named constant in `server.ts`, with a comment saying
   why that number — the existing two both explain their choice against the
   deadline they serve.
4. Register it as `void job(); const t = setInterval(() => void job(), MS); t.unref();`
5. Test it by calling the function, not by waiting for a timer.
