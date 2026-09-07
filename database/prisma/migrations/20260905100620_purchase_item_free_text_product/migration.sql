-- =============================================================================
--  Purchase bill lines record what the vendor's bill says.
--
--  Two changes, both additive in effect:
--
--    productName  NEW. The supplier's own description of the goods, which is
--                 what makes a recorded bill checkable against the paper.
--    productId    now NULLABLE. A bill is typed from a document, often before
--                 anyone has decided which catalogue entry it corresponds to.
--
--  Allocation is unaffected: it still matches on productId and refuses a line
--  that has none. Relaxing entry does not relax matching.
--
--  ---------------------------------------------------------------------------
--  Why three steps rather than Prisma's generated one
--  ---------------------------------------------------------------------------
--  Prisma emits `ADD COLUMN "productName" TEXT NOT NULL` with no default, which
--  fails outright on a table that already holds rows. The column is therefore
--  added nullable, backfilled from each line's existing product, and only then
--  tightened — so no existing bill is lost or rewritten by hand.
-- =============================================================================

-- 1. Add permissively, so existing rows survive.
ALTER TABLE "PurchaseBillItem" ADD COLUMN "productName" TEXT;

-- 2. Backfill from the catalogue entry each line already points at. Every
--    existing row has one, because productId was mandatory until now.
UPDATE "PurchaseBillItem" AS i
   SET "productName" = p."name"
  FROM "Product" AS p
 WHERE i."productId" = p."id"
   AND i."productName" IS NULL;

-- 3. Belt and braces: any row the join somehow missed still gets a value, so
--    step 4 cannot fail and no row is silently dropped.
UPDATE "PurchaseBillItem"
   SET "productName" = 'Unnamed product'
 WHERE "productName" IS NULL;

-- 4. Now the constraint can be applied safely.
ALTER TABLE "PurchaseBillItem" ALTER COLUMN "productName" SET NOT NULL;

-- 5. productId becomes optional; the foreign key is recreated to match.
ALTER TABLE "PurchaseBillItem" DROP CONSTRAINT "PurchaseBillItem_productId_fkey";
ALTER TABLE "PurchaseBillItem" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "PurchaseBillItem"
  ADD CONSTRAINT "PurchaseBillItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A vendor's description is never blank.
ALTER TABLE "PurchaseBillItem"
  ADD CONSTRAINT "purchase_item_product_name_present"
  CHECK (length(btrim("productName")) > 0);
