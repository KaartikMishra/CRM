-- =============================================================================
--  Notification types for the partial-dispatch conversation.
--
--  Four new members on an existing enum, and nothing else. Postgres has no way
--  to add an enum value without ALTER TYPE, which is the whole reason this
--  migration exists — the schema's own comment on AppModule records the same
--  cost for the same reason.
--
--  `IF NOT EXISTS` on each, so re-running this migration is a no-op rather than
--  an error.
--
--  AUTO_ALLOWED is a member in its own right rather than a flag on ALLOWED: a
--  shipment permitted because nobody answered within the deadline is a
--  different event from one somebody agreed to, and the notice has to be able
--  to say which without the reader inspecting a second field.
--
--  NOT TOUCHED: every existing Notification row keeps its type and its content.
--  No table is created, altered or dropped. No row is inserted, updated or
--  deleted. No stock figure is read or written. `_prisma_migrations` is not
--  modified by hand.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARTIAL_DISPATCH_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARTIAL_DISPATCH_ALLOWED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARTIAL_DISPATCH_DISALLOWED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARTIAL_DISPATCH_AUTO_ALLOWED';
