-- =============================================================================
--  HR Phase 5 — Performance Management: notification vocabulary
-- =============================================================================
--
--  WHY THIS IS A SEPARATE MIGRATION FROM THE TABLES
--
--  Postgres cannot use a newly added enum value in the same transaction that adds
--  it. Nothing in Phase 5 uses one of these as a column default, so a single
--  migration would in fact have been safe — but Phases 3 and 4 both split theirs
--  for this reason, and a rule that is followed consistently is easier to keep
--  than one whose exceptions have to be remembered.
--
--  WHAT EACH OF THESE IS FOR
--
--  Five values, each passing the test the earlier HR phases set: does this tell
--  somebody something they must act on and could not otherwise know?
--
--    HR_REVIEW_CYCLE_OPENED      a cycle went live; everybody in scope now owes a
--                                self-assessment they did not know was coming.
--    HR_SELF_ASSESSMENT_DUE      a deadline the employee owns.
--    HR_MANAGER_REVIEW_DUE       a deadline the manager owns, on somebody else's
--                                behalf — the one most easily forgotten.
--    HR_REVIEW_FINALIZED         the employee's appraisal is locked. They must be
--                                told, precisely because they can no longer
--                                influence it.
--    HR_IMPROVEMENT_PLAN_OPENED  a formal improvement plan now exists about them.
--
--  Deliberately absent: saving a draft assessment, submitting one, rating a
--  competency, recording KPI progress. Each of those is an author acting on their
--  own work — the person already knows, and a notice nobody needs is how a bell
--  stops being read. That is the same line Phase 4 drew.
--
--  ADDITIVE ONLY. No value is renamed or removed: Postgres cannot drop an enum
--  value, and a renamed one would orphan every stored row referencing it.
-- =============================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_REVIEW_CYCLE_OPENED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_SELF_ASSESSMENT_DUE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_MANAGER_REVIEW_DUE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_REVIEW_FINALIZED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_IMPROVEMENT_PLAN_OPENED';
