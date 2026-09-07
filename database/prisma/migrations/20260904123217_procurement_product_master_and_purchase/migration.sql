-- CreateEnum
CREATE TYPE "PurchaseBillType" AS ENUM ('CREDIT', 'PAID_UP');

-- CreateEnum
CREATE TYPE "PurchaseBillStatus" AS ENUM ('OPEN', 'RECEIVED', 'CLOSED');

-- AlterTable
ALTER TABLE "EnquiryProduct" ADD COLUMN     "productId" TEXT;

-- AlterTable
ALTER TABLE "SalesOrderItem" ADD COLUMN     "productId" TEXT;

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseBill" (
    "id" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "billType" "PurchaseBillType" NOT NULL,
    "status" "PurchaseBillStatus" NOT NULL DEFAULT 'OPEN',
    "billDate" TIMESTAMP(3) NOT NULL,
    "expectedBy" TIMESTAMP(3),
    "billImageId" TEXT,
    "isDelayed" BOOLEAN NOT NULL DEFAULT false,
    "delayReason" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseBillItem" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "orderedQty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "rate" DECIMAL(12,2) NOT NULL,
    "productImageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseBillItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseAllocation" (
    "id" TEXT NOT NULL,
    "purchaseBillItemId" TEXT NOT NULL,
    "salesOrderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "allocatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_name_key" ON "Product"("name");

-- CreateIndex
CREATE INDEX "Product_isActive_name_idx" ON "Product"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_productId_key" ON "InventoryItem"("productId");

-- CreateIndex
CREATE INDEX "PurchaseBill_status_billDate_idx" ON "PurchaseBill"("status", "billDate");

-- CreateIndex
CREATE INDEX "PurchaseBill_vendorId_idx" ON "PurchaseBill"("vendorId");

-- CreateIndex
CREATE INDEX "PurchaseBill_isDelayed_billDate_idx" ON "PurchaseBill"("isDelayed", "billDate");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBill_vendorId_billNumber_key" ON "PurchaseBill"("vendorId", "billNumber");

-- CreateIndex
CREATE INDEX "PurchaseBillItem_productId_idx" ON "PurchaseBillItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBillItem_billId_lineNo_key" ON "PurchaseBillItem"("billId", "lineNo");

-- CreateIndex
CREATE INDEX "PurchaseAllocation_salesOrderItemId_idx" ON "PurchaseAllocation"("salesOrderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseAllocation_purchaseBillItemId_salesOrderItemId_key" ON "PurchaseAllocation"("purchaseBillItemId", "salesOrderItemId");

-- CreateIndex
CREATE INDEX "EnquiryProduct_productId_idx" ON "EnquiryProduct"("productId");

-- CreateIndex
CREATE INDEX "SalesOrderItem_productId_idx" ON "SalesOrderItem"("productId");

-- AddForeignKey
ALTER TABLE "EnquiryProduct" ADD CONSTRAINT "EnquiryProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBill" ADD CONSTRAINT "PurchaseBill_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBill" ADD CONSTRAINT "PurchaseBill_billImageId_fkey" FOREIGN KEY ("billImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBill" ADD CONSTRAINT "PurchaseBill_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBillItem" ADD CONSTRAINT "PurchaseBillItem_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBillItem" ADD CONSTRAINT "PurchaseBillItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBillItem" ADD CONSTRAINT "PurchaseBillItem_productImageId_fkey" FOREIGN KEY ("productImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseAllocation" ADD CONSTRAINT "PurchaseAllocation_purchaseBillItemId_fkey" FOREIGN KEY ("purchaseBillItemId") REFERENCES "PurchaseBillItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseAllocation" ADD CONSTRAINT "PurchaseAllocation_salesOrderItemId_fkey" FOREIGN KEY ("salesOrderItemId") REFERENCES "SalesOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseAllocation" ADD CONSTRAINT "PurchaseAllocation_allocatedById_fkey" FOREIGN KEY ("allocatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
--  Business invariants, enforced by the database.
--
--  Prisma cannot express these, and the service layer already checks them —
--  but the service is one code path and this is the last line. The same
--  belt-and-braces approach guards the 20-product cap on an enquiry.
-- ---------------------------------------------------------------------------

-- Stock on hand is a physical count; it cannot go below zero.
ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "inventory_on_hand_non_negative" CHECK ("onHand" >= 0);

-- You cannot order a non-positive quantity, cannot receive a negative one,
-- and cannot receive more than was ordered. The last is what stops phantom
-- stock: ordering 10 and receiving 4 must never make 10 allocatable.
ALTER TABLE "PurchaseBillItem"
  ADD CONSTRAINT "purchase_item_ordered_positive" CHECK ("orderedQty" > 0);
ALTER TABLE "PurchaseBillItem"
  ADD CONSTRAINT "purchase_item_received_non_negative" CHECK ("receivedQty" >= 0);
ALTER TABLE "PurchaseBillItem"
  ADD CONSTRAINT "purchase_item_received_within_ordered" CHECK ("receivedQty" <= "orderedQty");

-- A rate is money and is never negative.
ALTER TABLE "PurchaseBillItem"
  ADD CONSTRAINT "purchase_item_rate_non_negative" CHECK ("rate" >= 0);

-- An allocation of zero is not an allocation; a negative one would hand stock
-- back by arithmetic rather than by an explicit release.
ALTER TABLE "PurchaseAllocation"
  ADD CONSTRAINT "allocation_quantity_positive" CHECK ("quantity" > 0);

-- A delayed bill must say why. Mirrors the enquiry rule that a NO_VENDOR line
-- carries a mandatory reason.
ALTER TABLE "PurchaseBill"
  ADD CONSTRAINT "purchase_bill_delay_reason_required"
  CHECK ("isDelayed" = false OR ("delayReason" IS NOT NULL AND length(btrim("delayReason")) > 0));
