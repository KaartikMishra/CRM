-- =============================================================================
--  HR Phase 3 — five NotificationType values.
--
--  Its own migration, and one statement per value, because Postgres cannot use a
--  newly added enum value in the same transaction that adds it. Separate from the
--  Phase 3 table migration for the same reason the Phase 1 notification types were
--  separate: an ALTER TYPE and a CREATE TABLE have different transaction rules, and
--  mixing them is how a migration becomes unapplyable halfway.
--
--  IF NOT EXISTS so a re-run is a no-op rather than an error. Additive only — no
--  value is renamed or removed, which Postgres could not do anyway without
--  rewriting every row that holds it.
-- =============================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_INTERVIEW_SCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_APPLICATION_DECISION_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_ONBOARDING_TASK_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_PROBATION_REVIEW_DUE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_PROBATION_ENDING';
