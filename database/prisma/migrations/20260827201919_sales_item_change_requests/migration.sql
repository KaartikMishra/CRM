-- =============================================================================
--  Sales product change requests.
--
--  Purely additive: two new enums and one new table. No existing table, column,
--  constraint or row is altered, so applying this cannot affect existing sales
--  orders, their lines, payments, or anything in Product Enquiry.
--
--  This table is the single mechanism by which an order's products change after
--  creation. It is deliberately invisible to every total: order value sums
--  SalesOrderItem rows, so a pending request cannot move money.
-- =============================================================================

-- CreateEnum
CREATE TYPE "SalesChangeType" AS ENUM ('ADD', 'EDIT', 'REMOVE');

-- CreateEnum
CREATE TYPE "SalesChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "SalesItemChangeRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT,
    "type" "SalesChangeType" NOT NULL,
    "status" "SalesChangeStatus" NOT NULL DEFAULT 'PENDING',
    "productName" TEXT,
    "productImageId" TEXT,
    "quantity" INTEGER,
    "price" DECIMAL(12,2),
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "SalesItemChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesItemChangeRequest_orderId_status_idx" ON "SalesItemChangeRequest"("orderId", "status");

-- CreateIndex
CREATE INDEX "SalesItemChangeRequest_itemId_status_idx" ON "SalesItemChangeRequest"("itemId", "status");

-- AddForeignKey
ALTER TABLE "SalesItemChangeRequest" ADD CONSTRAINT "SalesItemChangeRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesItemChangeRequest" ADD CONSTRAINT "SalesItemChangeRequest_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "SalesOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesItemChangeRequest" ADD CONSTRAINT "SalesItemChangeRequest_productImageId_fkey" FOREIGN KEY ("productImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesItemChangeRequest" ADD CONSTRAINT "SalesItemChangeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesItemChangeRequest" ADD CONSTRAINT "SalesItemChangeRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
--  Business invariants — hand-written, following 20260825090309_business_invariants.
-- -----------------------------------------------------------------------------

-- An ADD invents a new line, so it points at none.
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_add_has_no_item"
    CHECK ("type" <> 'ADD' OR "itemId" IS NULL);

-- An EDIT or REMOVE is meaningless without the line it acts on.
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_edit_remove_have_item"
    CHECK ("type" = 'ADD' OR "itemId" IS NOT NULL);

-- ADD and EDIT carry the values being proposed; REMOVE proposes no values.
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_add_edit_have_values"
    CHECK ("type" = 'REMOVE'
           OR ("productName" IS NOT NULL AND "quantity" IS NOT NULL AND "price" IS NOT NULL));

-- Proposed numbers obey the same floor as a real line.
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_quantity_positive"
    CHECK ("quantity" IS NULL OR "quantity" > 0);

ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_price_positive"
    CHECK ("price" IS NULL OR "price" > 0);

-- A decision records both its author and its moment, or neither.
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_review_recorded_together"
    CHECK (("reviewedById" IS NULL) = ("reviewedAt" IS NULL));

-- Anything no longer pending has been decided by somebody.
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_decided_has_reviewer"
    CHECK ("status" = 'PENDING' OR "reviewedById" IS NOT NULL);

-- One open request per line, enforced by the database rather than the UI, so
-- two people cannot queue contradictory changes against the same product.
-- Partial: decided requests accumulate freely as history.
CREATE UNIQUE INDEX "sales_change_one_pending_per_item"
  ON "SalesItemChangeRequest" ("itemId")
  WHERE "status" = 'PENDING' AND "itemId" IS NOT NULL;
