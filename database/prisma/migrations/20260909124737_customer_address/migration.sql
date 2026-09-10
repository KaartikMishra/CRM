-- =============================================================================
--  Customer postal address.
--
--  Purely additive: one nullable column on an existing table. No constraint,
--  no default, no backfill — every existing customer simply reads NULL, which
--  is what "not recorded" already means for phone and email beside it.
-- =============================================================================

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "address" TEXT;
