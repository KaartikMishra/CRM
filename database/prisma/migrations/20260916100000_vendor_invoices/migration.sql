-- =============================================================================
--  Vendor Invoices: vendor detail fields and vendor-product mapping.
--
--  Three nullable columns on Vendor, and one new table.
--
--  The columns are nullable with no default because they are optional by
--  business rule — a vendor needs only a name — so every existing vendor row
--  reads NULL, which is exactly what "not recorded" already means for `phone`
--  and `email` beside them. No backfill is needed or issued.
--
--  `name` keeps its unique constraint untouched: Procurement resolves a vendor
--  by name when a bill is typed up, and relaxing that would make the resolution
--  ambiguous. `city` is also kept — Product Enquiry reads it, and the new
--  `address` sits alongside rather than replacing it.
--
--  VendorProductMapping deliberately references RsProduct, the canonical
--  catalogue, rather than the legacy Product master. Its `currentRate` is the
--  price agreed today; what a purchase actually cost stays on
--  PurchaseBillItem.rate and is never rewritten from here. No trade-history
--  table is created — that history already exists on PurchaseBill and
--  PurchaseBillItem and is read live.
--
--  Purely additive. No existing column is altered or dropped, no constraint is
--  changed, and Product, InventoryItem, PurchaseBill, PurchaseBillItem,
--  SalesOrder, ProductEnquiry and RsProduct keep every row and relation they
--  had.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "address" TEXT,
ADD COLUMN     "altPhone" TEXT;

-- CreateTable
CREATE TABLE "VendorProductMapping" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "rsProductId" TEXT NOT NULL,
    "currentRate" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One row per vendor/product pair regardless of state: a pair is one
-- relationship whose rate and status change over time, so re-mapping an
-- archived pair reactivates that row rather than creating a second.
CREATE UNIQUE INDEX "VendorProductMapping_vendorId_rsProductId_key" ON "VendorProductMapping"("vendorId", "rsProductId");

-- CreateIndex
CREATE INDEX "VendorProductMapping_vendorId_isActive_idx" ON "VendorProductMapping"("vendorId", "isActive");

-- CreateIndex
CREATE INDEX "VendorProductMapping_rsProductId_isActive_idx" ON "VendorProductMapping"("rsProductId", "isActive");

-- AddForeignKey
ALTER TABLE "VendorProductMapping" ADD CONSTRAINT "VendorProductMapping_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorProductMapping" ADD CONSTRAINT "VendorProductMapping_rsProductId_fkey" FOREIGN KEY ("rsProductId") REFERENCES "RsProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
