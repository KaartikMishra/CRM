# HR Phase 5 — what was specified, and what was decided

Following the precedent of `TESTING-NOTES.md` and `services/SCHEDULING.md`: a short
decision record kept beside the code, so the next person can tell a requirement from
an implementation choice without reconstructing a conversation.

## The requirements boundary

**There is no requirements document in this repository.** The tree was searched at
the start of Phase 5: it holds `README.md` and two Next.js-generated
`AGENTS.md`/`CLAUDE.md` files, and no `docs/`, specification or requirements file of
any kind. Every HR phase's scope has arrived as a prompt in conversation.

So Phase 5 was built to an **agreed scope** — the capability list given when the
phase was opened:

- performance dashboard and review-cycle management
- employee and department goals
- measurable KPIs, targets and progress tracking
- self-assessments and manager reviews
- competency ratings and structured feedback
- review submission, approval and finalisation workflows
- performance history and reports
- improvement/development plans

That list is what the code implements. It is the authority this module was written
against, and nothing beyond it was invented.

Independently, the repository's own recorded intent for the `HR_PERFORMANCE`
namespace agrees with that reading. The same sentence appears in four places —
`shared/src/enums.ts`, `database/prisma/schema.prisma`, the Phase 4 migration, and
`frontend/components/layout/nav-items.ts` — describing it as the *appraisal*
namespace: "a trainer who builds a course and signs off a practical has no business
reading appraisals, and an appraiser has no reason to edit the catalogue."

## Implementation decisions, not requirements

Each of the following was a judgement call made to fill a gap the agreed scope did
not settle. **None is a business rule handed down.** If an authoritative requirement
says otherwise, these are the places to change, and each is deliberately isolated
so that changing it is a small edit rather than a rewrite.

### The 1–5 rating scale

`COMPETENCY_RATINGS = [1,2,3,4,5]`, with `MIN_COMPETENCY_RATING` and
`MAX_COMPETENCY_RATING` in `shared/src/enums.ts`, mirrored by CHECK constraints
(`competency_rating_range`, `performance_review_*_rating_range`).

Chosen to **match what HR already uses**: Phase 3's `InterviewFeedback.rating` and
`ProbationReview.rating` are both 1–5 integers with a CHECK. Two HR scales differing
by a point would make interview, probation and appraisal ratings mutually
incomparable for no benefit.

Not specified anywhere. A business that rates 1–10, or on named bands with no
numbers, would need the constants, the CHECKs and the UI changed together.

Overall ratings are `Decimal(4,2)` on the same 1–5 range rather than integers,
because an overall figure is often a weighted mean of competencies and forcing it to
a whole number throws that away. Also a decision.

### Review cadence

`REVIEW_CYCLE_CADENCES = ['MONTHLY','QUARTERLY','HALF_YEARLY','ANNUAL','AD_HOC']`.

**Descriptive only.** Nothing in the module schedules anything: no cycle is created
automatically, no reminder fires on a cadence, and no service branches on the value.
It records the intended rhythm so a report can say "quarterly" without inferring it
from two dates.

Deliberately not a scheduler. Generating the next cycle automatically would need a
stated answer to "what happens to the one still open", and that answer was not
given. See `services/SCHEDULING.md` for why this codebase does not add background
schedulers speculatively.

### The three goal outcomes

`ACHIEVED`, `PARTIALLY_MET`, `MISSED` (plus `CANCELLED` for a goal that stopped
mattering).

Three rather than two because forcing a 70%-of-target result to be called either a
success or a failure produces a number worth nothing. The thresholds that separate
them are **per cycle** — `goalAchievementThreshold` and `goalPartialThreshold`,
defaulting to 100 and 50 — so a business that disagrees configures it rather than
editing code. `suggestGoalOutcome` takes both as arguments and reads no constant.

The *number* of outcomes is still a decision. A business wanting five bands would
need the enum, the CHECK and the suggestion function changed.

### Other decisions in the same category

- **Competency sheets belong to a cycle**, not to a global library. A shared library
  would mean either editing the definition a past review was judged against —
  rewriting history — or accumulating retired competencies forever.
- **`reviewerId` is captured at generation time**, not read live from
  `Employee.managerId`. Somebody who changes manager mid-cycle is still reviewed by
  whoever actually managed them over the period.
- **KPI attainment measures from the baseline where one is set.** A goal moving
  20% → 30% that reached 25% is half done, not 83% done. See `performance.calc.ts`.
- **Unmeasured KPIs are excluded from a goal's roll-up, not counted as zero.** One
  KPI at 100% with three unmeasured reports 100%, because "barely started" is the
  wrong thing to say about work that is on track and unmeasured.
- **LOWER_IS_BETTER caps at 100%**, while HIGHER_IS_BETTER does not. Driving handling
  time to zero is the goal met, not 200% of it.
- **No path out of `FINALIZED`.** Not to `PENDING_APPROVAL`, not anywhere. The
  performance history is built from finalized reviews, so reopening one would change
  a trend line retroactively.

## What is a hard rule, and where it is enforced

These are not decisions. They were stated as requirements, and each is enforced in
more than one layer on purpose.

**Employees must not edit finalised reviews.** `isReviewSettled` is consulted before
anything else in every write check; the state machine offers no transition out of
`FINALIZED`; and `performance_review_approver_only_when_finalized` plus
`performance_review_finalized_has_approver` make the stamps consistent at the
database level.

**Nobody approves their own review.** The subject is refused **first**, before any
permission is consulted, in `mayFinalizeReview`, `mayWriteManagerAssessment`,
`mayCancelReview`, `mayRateAsHr`, `mayCloseGoal` and `mayManageDevelopmentPlan`. The
ordering is the substance: an HR colleague being appraised holds `APPROVE`, and
checking the grant first would let them close their own appraisal. Pinned by tests
that pass an actor with `role: 'ADMIN'` and every grant.

Additionally `performance_review_reviewer_not_subject` makes a review whose reviewer
is its own subject impossible for any code path, and
`CompetencyRating(reviewId, competencyId, source)` is unique so an employee cannot
file a second MANAGER-sourced opinion alongside their manager's.

## Where the enforcement is split, and why

A CHECK is right when the rule is a property of one row and must hold however the row
was written. Everything needing to compare rows — is this actor the subject, is this
person a manager, has this reviewer already rated this competency — cannot be
expressed row-locally and lives in `performance-access.ts`, where it is pure and
testable.

The database answers "is this finalized review missing an approver". It cannot answer
"is that approver the person being appraised". The service answers the second. Neither
is sufficient alone, which is why both exist.

## A defect the browser-driven test found, and what it changed

The review page originally answered "is this reader the subject" by comparing the
session's `employeeId` against `review.employee.employeeId`. **Those are different
columns**: `User.employeeId` is a login-side staff code, `Employee.employeeId` is the
HR code. They are drawn from one allocation series — `allocateEmployeeId` seeds from
both tables precisely so an HR record is never given a number a user account already
holds — so for a linked person they usually agree.

But nothing enforces it. `linkUser` sets `Employee.userId` and does **not** sync the
codes, so an account created outside the HR flow can be linked to an employee whose
code differs. The comparison then returns false for the actual subject, who sees:

- the page titled with their own name in the third person rather than "Your review"
- no self-assessment form at all
- no explanation of why there is no approve control

Caught by `performance-ui-workflow.test.ts`, which renders the page with a real
session and asserts the HTML. The unit tests had asserted the comparison *existed*,
not that it resolved — which is the difference between testing a line and testing a
behaviour.

**Fixed** by adding `PerformanceReviewView.viewerIsSubject`, answered server-side from
`Employee.userId` against the actor's id. The review page reads it.

**Still outstanding:** the goal and plan detail pages keep the code comparison,
because their views carry no equivalent flag. On those pages it is a courtesy rather
than a boundary — the API refuses an owner editing their own target or authoring
their own plan before consulting any permission — so a false comparison shows a
control that then 403s. Worse experience, not a security failure. Phase 3's probation
page has the same shape and documents the same caveat.
