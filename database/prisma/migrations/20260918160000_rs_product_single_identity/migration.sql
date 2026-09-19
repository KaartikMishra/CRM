-- =============================================================================
--  One product identity: RsProduct.id, everywhere.
--
--  Sales, Procurement and allocation each named a product a different way. A
--  purchase line pointed at Product, an order line pointed at Product, and the
--  new RS Products catalogue pointed at neither — so reconciling a requirement
--  against purchased stock needed a bridge (RsProduct.productId) that stood at
--  NULL on all 502 rows. This replaces all of it with one key.
--
--    SalesOrderItem.rsProductId  ─┐
--                                 ├─→ RsProduct.id  ←── allocation compares these
--    PurchaseBillItem.rsProductId ┘
--
--  Product level, never variant: no ShopifyVariant reference is created here or
--  anywhere. SKU is not an identity either — it is nullable and legitimately
--  duplicated across products, so it is search and display only.
--
--  ORDER OF OPERATIONS. Every new column is added and populated BEFORE any old
--  column is dropped, in one transaction. Nothing is destroyed before its
--  replacement is verified, and a failure at any point rolls the whole thing
--  back rather than leaving half an identity.
--
--  THE MAPPING RULE, and its limits. A legacy Product is carried across only
--  when exactly one RsProduct has a byte-identical title. Not a fold, not a
--  prefix, not a similarity score, not a SKU: those would each be a guess, and
--  a purchase attached to the wrong goods cannot be untangled once its stock is
--  allocated. The `= 1` subquery is what makes it deterministic — RS titles are
--  not unique in general, so an ambiguous name maps to nothing rather than to
--  whichever row came first.
--
--  Rows that do not match are left NULL, on purpose, and are remapped by hand
--  through the RS Products picker. They are not lost: each keeps its own
--  productName, which is the wording actually written on the document.
--
--  WHAT THE UNMAPPED ROWS LOSE, checked rather than assumed. Every legacy link
--  that does not carry across was to a Product whose name is identical to the
--  productName already stored on the row itself, so dropping the column removes
--  no fact that is not still written down beside it. The one row whose legacy
--  product had a different name — a bill line reading "PAN" linked to
--  "10 Inch Pure Kansa Dinner Set – 5 Pieces" — is precisely the one that maps
--  deterministically, and is carried across above.
--
--  Product and InventoryItem are NOT dropped here. After this migration they
--  have no inbound foreign key and no code reads either of them, which is the
--  condition for removing them; doing it is a separate, deliberate act. The
--  prepared removal lives in database/prisma/drop-legacy-product.sql.
--
--  No DROP TABLE, no TRUNCATE, no DELETE.
-- =============================================================================

-- --------------------------------------------------------------------------
--  1. The new identity columns
-- --------------------------------------------------------------------------

ALTER TABLE "SalesOrderItem" ADD COLUMN     "rsProductId" TEXT;
ALTER TABLE "SalesItemChangeRequest" ADD COLUMN     "rsProductId" TEXT;

-- --------------------------------------------------------------------------
--  2. Carry the deterministic mappings across, before anything is dropped
--
--  One statement per table, all three using the same rule. Written as a
--  correlated subquery rather than a join so a row with no match, or with an
--  ambiguous one, is simply left NULL instead of being dropped from the update.
-- --------------------------------------------------------------------------

UPDATE "SalesOrderItem" si
SET "rsProductId" = (
  SELECT r."id" FROM "RsProduct" r
  JOIN "Product" p ON p."name" = r."title"
  WHERE p."id" = si."productId"
    AND (SELECT count(*) FROM "RsProduct" r2 WHERE r2."title" = p."name") = 1
)
WHERE si."productId" IS NOT NULL;

UPDATE "SalesItemChangeRequest" cr
SET "rsProductId" = (
  SELECT r."id" FROM "RsProduct" r
  JOIN "Product" p ON p."name" = r."title"
  WHERE p."id" = cr."productId"
    AND (SELECT count(*) FROM "RsProduct" r2 WHERE r2."title" = p."name") = 1
)
WHERE cr."productId" IS NOT NULL;

UPDATE "PurchaseBillItem" pbi
SET "rsProductId" = (
  SELECT r."id" FROM "RsProduct" r
  JOIN "Product" p ON p."name" = r."title"
  WHERE p."id" = pbi."productId"
    AND (SELECT count(*) FROM "RsProduct" r2 WHERE r2."title" = p."name") = 1
)
WHERE pbi."productId" IS NOT NULL AND pbi."rsProductId" IS NULL;

-- --------------------------------------------------------------------------
--  3. Flush the deferred constraint triggers before any further DDL
--
--  `sales_order_money_guard` is a DEFERRABLE constraint trigger: writing a
--  SalesOrderItem queues a check that would otherwise run at COMMIT, and
--  Postgres refuses DDL on a table with pending trigger events
--  ("cannot ALTER TABLE ... because it has pending trigger events").
--
--  Firing them here rather than suppressing them is deliberate. The updates
--  above touched only lines that carried a legacy product, and they changed no
--  quantity, price or payment — so the guard re-checks those orders and passes.
--  If one of them could not satisfy it, the whole migration rolls back and says
--  so, which is the outcome to want: it would mean an order's money is already
--  inconsistent, and that is not something to migrate silently past.
-- --------------------------------------------------------------------------

SET CONSTRAINTS ALL IMMEDIATE;

-- --------------------------------------------------------------------------
--  4. Indexes and foreign keys for the new identity
-- --------------------------------------------------------------------------

CREATE INDEX "SalesOrderItem_rsProductId_idx" ON "SalesOrderItem"("rsProductId");

ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_rsProductId_fkey" FOREIGN KEY ("rsProductId") REFERENCES "RsProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesItemChangeRequest" ADD CONSTRAINT "SalesItemChangeRequest_rsProductId_fkey" FOREIGN KEY ("rsProductId") REFERENCES "RsProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
--  5. Retire the legacy identity
--
--  Only now, with every replacement column populated and constrained.
--
--  EnquiryProduct."productId" is dropped rather than repointed: no schema ever
--  accepted it, no service ever set it, and it stood at NULL on every row. An
--  enquiry is a question about goods a customer described, which is why `name`
--  is free text; the module has never needed a catalogue identity to answer it.
--
--  RsProduct."productId" is the bridge that was never populated. With one
--  identity there is nothing left to bridge to.
-- --------------------------------------------------------------------------

ALTER TABLE "SalesOrderItem" DROP CONSTRAINT "SalesOrderItem_productId_fkey";
ALTER TABLE "SalesItemChangeRequest" DROP CONSTRAINT "SalesItemChangeRequest_productId_fkey";
ALTER TABLE "PurchaseBillItem" DROP CONSTRAINT "PurchaseBillItem_productId_fkey";
ALTER TABLE "EnquiryProduct" DROP CONSTRAINT "EnquiryProduct_productId_fkey";
ALTER TABLE "RsProduct" DROP CONSTRAINT "RsProduct_productId_fkey";

-- SalesItemChangeRequest has no index on productId — only the foreign key
-- above — so there is deliberately no DROP INDEX for it here.
DROP INDEX "SalesOrderItem_productId_idx";
DROP INDEX "PurchaseBillItem_productId_idx";
DROP INDEX "EnquiryProduct_productId_idx";
DROP INDEX "RsProduct_productId_idx";

ALTER TABLE "SalesOrderItem" DROP COLUMN "productId";
ALTER TABLE "SalesItemChangeRequest" DROP COLUMN "productId";
ALTER TABLE "PurchaseBillItem" DROP COLUMN "productId";
ALTER TABLE "EnquiryProduct" DROP COLUMN "productId";
ALTER TABLE "RsProduct" DROP COLUMN "productId";
