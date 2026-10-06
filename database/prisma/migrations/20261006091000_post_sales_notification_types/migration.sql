-- =============================================================================
--  Post Sales & Grievance — the module's three notification types.
--
--  Its own migration rather than part of the table migration, for two reasons.
--  Postgres cannot use a new enum value in the same transaction that adds it, so
--  these have to be separate statements; and the table migration was already
--  applied, so appending to it would have edited applied history — which is never
--  safe, because the recorded checksum would no longer match the file.
--
--  Deliberately three, not fifteen: the bell groups by type, and a notice per
--  field edit would be spam. Assignment, a critical/high case and a reopen are the
--  three events somebody genuinely needs pushed at them.
--
--  "AppModule" needs NO change — POST_SALES was declared when that enum was first
--  written, and ROLE_DEFAULTS.ADMIN already grants it. This module therefore adds
--  no permission vocabulary at all.
--
--  Strictly additive. No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POST_SALES_CASE_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POST_SALES_CASE_CRITICAL';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POST_SALES_CASE_REOPENED';
