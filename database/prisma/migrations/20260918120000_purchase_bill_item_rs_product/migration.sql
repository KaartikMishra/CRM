-- =============================================================================
--  Procurement → RS Products: the product-level mapping on a purchase line.
--
--  One nullable column, one index, one foreign key. Nothing else.
--
--  `rsProductId` references RsProduct — the product, never a ShopifyVariant.
--  Procurement maps at product level because the Procurement-facing RS Products
--  API exposes stock as a product-level aggregate over the variants; a variant
--  key would name something Procurement neither reads nor needs. SKU is not an
--  alternative identity either: it is nullable and legitimately duplicated
--  across variants, so it identifies nothing and is search and display only.
--
--  Nullable, with no backfill and no default. The existing purchase bill lines
--  keep `rsProductId` NULL and their `productId` exactly as it is: there is no
--  deterministic Product → RsProduct correspondence to derive one from — the
--  RsProduct.productId bridge is populated on no row — and guessing from a
--  title, a folded name or a SKU would silently attach a purchase to the wrong
--  product. Those lines are remapped by hand through the RS Products picker.
--
--  `productId` is deliberately left in place. Allocation reconciles a purchase
--  line against a SalesOrderItem by legacy Product identity, and Sales is not
--  migrated in this phase, so removing it would break allocation. The two keys
--  coexist until Sales is separately migrated.
--
--  ON DELETE SET NULL, matching how every other optional product reference in
--  this schema behaves: retiring a catalogue row must never delete a purchase
--  record. ON UPDATE CASCADE is Prisma's default for a relation whose
--  referenced field is an id.
--
--  Purely additive. No existing column is altered or dropped, no constraint is
--  changed, and Product, InventoryItem, PurchaseBill, PurchaseBillItem,
--  SalesOrderItem, EnquiryProduct, RsProduct and ShopifyVariant keep every row
--  and relation they had.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

-- AlterTable
ALTER TABLE "PurchaseBillItem" ADD COLUMN     "rsProductId" TEXT;

-- CreateIndex
CREATE INDEX "PurchaseBillItem_rsProductId_idx" ON "PurchaseBillItem"("rsProductId");

-- AddForeignKey
ALTER TABLE "PurchaseBillItem" ADD CONSTRAINT "PurchaseBillItem_rsProductId_fkey" FOREIGN KEY ("rsProductId") REFERENCES "RsProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
