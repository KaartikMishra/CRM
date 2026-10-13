-- =============================================================================
--  HR Phase 4 — five NotificationType values.
--
--  Its own migration, one statement per value, because Postgres cannot use a newly
--  added enum value in the same transaction that adds it. The same shape Phases 1
--  and 3 used for their notification types.
--
--  IF NOT EXISTS so a re-run is a no-op. Additive only: no value is renamed or
--  removed, which Postgres could not do anyway without rewriting every row.
-- =============================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_TRAINING_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_TRAINING_OVERDUE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_TRAINING_PRACTICAL_REVIEW_DUE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_TRAINING_SHADOWING_SIGNOFF_DUE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_TRAINING_QUALIFIED';
