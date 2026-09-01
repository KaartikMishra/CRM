-- =============================================================================
--  Revert the Sales date change-request workflow.
--
--  Date edits go back to being applied directly by whoever may already edit the
--  order, so the DATE request type and its two proposal columns are removed.
--
--  Safe to run: verified before writing that the table holds 0 rows of type
--  DATE and 0 non-null values in either dropped column, so nothing is lost. The
--  three surviving ADD/EDIT/REMOVE requests are untouched.
--
--  Postgres has no ALTER TYPE ... DROP VALUE, so the enum is rebuilt. Every
--  CHECK that names an enum literal is dropped first and restored afterwards to
--  its original, pre-DATE predicate.
-- =============================================================================

-- 1. The DATE-only rules go first: they name a value that is about to vanish.
ALTER TABLE "SalesItemChangeRequest" DROP CONSTRAINT "sales_change_date_proposes_a_date";
ALTER TABLE "SalesItemChangeRequest" DROP CONSTRAINT "sales_change_only_date_proposes_dates";
DROP INDEX "sales_change_one_pending_date_per_order";

-- 2. The three CHECKs that reference the enum, dropped so the type can change.
ALTER TABLE "SalesItemChangeRequest" DROP CONSTRAINT "sales_change_add_has_no_item";
ALTER TABLE "SalesItemChangeRequest" DROP CONSTRAINT "sales_change_edit_remove_have_item";
ALTER TABLE "SalesItemChangeRequest" DROP CONSTRAINT "sales_change_add_edit_have_values";

-- 3. The proposal columns. Both confirmed entirely null before this ran.
ALTER TABLE "SalesItemChangeRequest" DROP COLUMN "proposedOrderDate";
ALTER TABLE "SalesItemChangeRequest" DROP COLUMN "proposedToBeDispatchedBy";

-- 4. Rebuild the enum without DATE. The cast succeeds because no row holds it.
ALTER TYPE "SalesChangeType" RENAME TO "SalesChangeType_old";
CREATE TYPE "SalesChangeType" AS ENUM ('ADD', 'EDIT', 'REMOVE');
ALTER TABLE "SalesItemChangeRequest"
  ALTER COLUMN "type" TYPE "SalesChangeType" USING "type"::text::"SalesChangeType";
DROP TYPE "SalesChangeType_old";

-- 5. Restore the original predicates, exactly as they stood before DATE existed.
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_add_has_no_item"
    CHECK ("type" <> 'ADD' OR "itemId" IS NULL);

ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_edit_remove_have_item"
    CHECK ("type" = 'ADD' OR "itemId" IS NOT NULL);

ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_add_edit_have_values"
    CHECK ("type" = 'REMOVE'
           OR ("productName" IS NOT NULL AND "quantity" IS NOT NULL AND "price" IS NOT NULL));
