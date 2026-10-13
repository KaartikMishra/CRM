-- =============================================================================
--  Corrects leave_decision_consistency so an approved leave can be cancelled.
--
--  One CHECK constraint replaced on one table. No column, index, enum or row is
--  added, altered or removed; no data is touched.
--
--  ---------------------------------------------------------------------------
--  THE DEFECT
--
--  20261007140000 wrote the constraint by analogy with the Phase 0.5 approval
--  trail, where CANCELLED can only mean "withdrawn before anybody decided":
--
--    ("status" IN ('PENDING','CANCELLED') AND decidedById IS NULL AND decidedAt IS NULL)
--    OR ("status" IN ('APPROVED','REJECTED') AND decidedById IS NOT NULL AND decidedAt IS NOT NULL)
--
--  Leave has TWO cancellation paths, which that analogy missed:
--
--    PENDING  -> CANCELLED   the requester withdraws. Nobody decided. No decider.
--    APPROVED -> CANCELLED   a future-dated approved leave is called off. It WAS
--                            decided, by somebody, and that name must survive.
--
--  The old rule forced the second case to erase `decidedById` and `decidedAt` —
--  destroying the record of who approved the leave in the first place — or to fail
--  the constraint. It failed the constraint, which is the better of the two
--  outcomes and is how this was found: an integration test cancelling an approved
--  future leave got a 500 rather than silently losing the approver.
--
--  ---------------------------------------------------------------------------
--  THE CORRECTED RULE
--
--  The pairing that actually matters is about APPROVED and REJECTED: a decided
--  request must always be able to say who decided it and when. CANCELLED is
--  simply not constrained on those fields, because both states are legitimate —
--  null when withdrawn before a decision, populated when an approved leave was
--  later called off. `cancelledAt` is what marks a cancellation, and the separate
--  leave_cancelled_stamped CHECK already requires it.
--
--  Nothing is weakened for the states where the pairing is the point: PENDING
--  still cannot name a decider, and APPROVED/REJECTED still must.
--
--  No DROP TABLE, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

ALTER TABLE "LeaveRequest" DROP CONSTRAINT IF EXISTS "leave_decision_consistency";

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_decision_consistency" CHECK (
  -- Never decided: no decider, no decision moment.
  ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL)
  -- Decided: both present, always, so the trail can name who and when.
  OR ("status" IN ('APPROVED', 'REJECTED') AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
  -- Cancelled: unconstrained on the decision fields, deliberately. A withdrawal
  -- before a decision has none; an approved leave later called off keeps the
  -- approver's name, which is the whole reason this migration exists.
  OR ("status" = 'CANCELLED')
);
