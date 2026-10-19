-- HR Phase 6 — four payroll notification types.
--
-- A separate migration from the tables, deliberately: PostgreSQL cannot use a
-- newly added enum value in the same transaction that adds it, so the value and
-- its first use must be in different migrations. The same split was made in
-- Phases 3, 4 and 5 for the same reason.
--
-- `IF NOT EXISTS` because the Phase 4 and Phase 5 notification migrations
-- established that pattern, and because a partially applied enum addition
-- should be re-runnable rather than fatal.
--
-- **No notification in this module ever carries an amount.** A notice lands in a
-- bell a colleague may glance at, is often mirrored to email, and is retained in
-- a table more people can read than can read a payslip. See the comment on these
-- values in `shared/src/enums.ts` and the assertions in `payroll.notify.ts`.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_PAYROLL_APPROVAL_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_PAYSLIP_AVAILABLE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_PAYROLL_FINALIZED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_PAYROLL_ADJUSTMENT_RECORDED';
