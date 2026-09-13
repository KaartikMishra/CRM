-- =============================================================================
--  RS Products — the module value only.
--
--  Phase 1 of RS Products adds the module to the permission vocabulary and
--  nothing else: no table, no column, no data. The screen it unlocks is empty
--  until the data model lands in a later migration.
--
--  ALTER TYPE ... ADD VALUE stands alone deliberately. Postgres cannot use a
--  new enum value in the same transaction that adds it, so anything that wrote
--  'RS_PRODUCTS' into a row here would fail. Nothing does: permission rows are
--  written by the application, and the role default needs no row at all.
--
--  Purely additive. No existing value is renamed or removed, so every
--  UserModulePermission row already stored keeps its meaning.
-- =============================================================================

-- AlterEnum
ALTER TYPE "AppModule" ADD VALUE 'RS_PRODUCTS';
