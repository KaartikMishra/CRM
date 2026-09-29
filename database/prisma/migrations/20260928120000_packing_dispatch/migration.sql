-- =============================================================================
--  Packing & Dispatch: dispatch records, their lines, and partial-shipment
--  requests.
--
--  Two enums and three tables. Nothing existing is altered: every ALTER below
--  is an ADD CONSTRAINT on a table this migration has just created, and the
--  only references to existing tables are foreign keys pointing at them.
--
--  NOT TOUCHED: SalesOrder, SalesOrderItem, PurchaseBill, PurchaseBillItem,
--  PurchaseAllocation, RsProduct, ShopifyVariant (and therefore crmStockQty),
--  Customer, Vendor, User and every other table keep every row and every value
--  they had. No stock figure is read or written here — dispatch records the
--  movement of goods already committed by allocation, and Procurement remains
--  the single writer of crmStockQty.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE. No backfill. Product and
--  InventoryItem are not referenced or recreated.
-- =============================================================================

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('DRAFT', 'PACKING', 'PACKED', 'DISPATCHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PartialDispatchStatus" AS ENUM ('PENDING', 'ALLOWED', 'DISALLOWED', 'MOOT');

-- CreateTable
CREATE TABLE "Dispatch" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'DRAFT',
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "channel" TEXT,
    "channelOther" TEXT,
    "carrier" TEXT,
    "carrierOther" TEXT,
    "awb" TEXT,
    "packedById" TEXT,
    "packedAt" TIMESTAMP(3),
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchItem" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "salesOrderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "DispatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartialDispatchRequest" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "status" "PartialDispatchStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "poa" TEXT,
    "autoDecided" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PartialDispatchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dispatch_salesOrderId_status_idx" ON "Dispatch"("salesOrderId", "status");

-- CreateIndex
CREATE INDEX "Dispatch_status_createdAt_idx" ON "Dispatch"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DispatchItem_salesOrderItemId_idx" ON "DispatchItem"("salesOrderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchItem_dispatchId_salesOrderItemId_key" ON "DispatchItem"("dispatchId", "salesOrderItemId");

-- CreateIndex
CREATE INDEX "PartialDispatchRequest_status_deadline_idx" ON "PartialDispatchRequest"("status", "deadline");

-- CreateIndex
CREATE INDEX "PartialDispatchRequest_salesOrderId_status_idx" ON "PartialDispatchRequest"("salesOrderId", "status");

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_packedById_fkey" FOREIGN KEY ("packedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchItem" ADD CONSTRAINT "DispatchItem_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchItem" ADD CONSTRAINT "DispatchItem_salesOrderItemId_fkey" FOREIGN KEY ("salesOrderItemId") REFERENCES "SalesOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartialDispatchRequest" ADD CONSTRAINT "PartialDispatchRequest_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartialDispatchRequest" ADD CONSTRAINT "PartialDispatchRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartialDispatchRequest" ADD CONSTRAINT "PartialDispatchRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
--  Constraints Prisma cannot express, added by hand.
-- ---------------------------------------------------------------------------

-- An airway bill identifies a shipment WITH its carrier: two couriers may
-- legitimately issue the same number, and the same number twice from one
-- courier is a mistake. Partial, so the many shipments still being packed --
-- which have no AWB yet -- do not collide with each other on NULL or ''.
CREATE UNIQUE INDEX "dispatch_awb_per_carrier"
  ON "Dispatch" ("carrier", "awb")
  WHERE "awb" IS NOT NULL AND "awb" <> '';

-- One open question per order. A second request while the first is undecided
-- would let two answers disagree about the same shipment.
CREATE UNIQUE INDEX "partial_dispatch_one_pending"
  ON "PartialDispatchRequest" ("salesOrderId")
  WHERE "status" = 'PENDING';

-- The decision fields, matched to the state they describe. Written as one
-- constraint per state so a violation names the case that failed.
--
--   PENDING       nothing decided yet, so no decision field is set.
--   ALLOWED human somebody agreed and has to say why; a plan of action is
--                 optional, because allowing needs no alternative plan.
--   ALLOWED auto  the deadline decided it. No reason, because nobody gave one,
--                 and no decider, because naming somebody would be a fiction.
--   DISALLOWED    a refusal must say why AND what happens instead.
--   MOOT          the question stopped applying. Resolved, timestamped, and
--                 with no fabricated human decision attached to it.
ALTER TABLE "PartialDispatchRequest"
  ADD CONSTRAINT "partial_dispatch_pending_undecided"
  CHECK (
    "status" <> 'PENDING'
    OR ("decidedAt" IS NULL AND "decidedById" IS NULL
        AND "reason" IS NULL AND "poa" IS NULL AND "autoDecided" = false)
  );

ALTER TABLE "PartialDispatchRequest"
  ADD CONSTRAINT "partial_dispatch_decided_has_moment"
  CHECK ("status" = 'PENDING' OR "decidedAt" IS NOT NULL);

ALTER TABLE "PartialDispatchRequest"
  ADD CONSTRAINT "partial_dispatch_allowed_by_person"
  CHECK (
    NOT ("status" = 'ALLOWED' AND "autoDecided" = false)
    OR ("reason" IS NOT NULL AND "decidedById" IS NOT NULL)
  );

ALTER TABLE "PartialDispatchRequest"
  ADD CONSTRAINT "partial_dispatch_auto_is_allowed"
  CHECK (
    NOT "autoDecided"
    OR ("status" = 'ALLOWED' AND "reason" IS NULL AND "poa" IS NULL
        AND "decidedById" IS NULL)
  );

ALTER TABLE "PartialDispatchRequest"
  ADD CONSTRAINT "partial_dispatch_disallowed_explained"
  CHECK (
    "status" <> 'DISALLOWED'
    OR ("reason" IS NOT NULL AND "poa" IS NOT NULL AND "decidedById" IS NOT NULL)
  );

ALTER TABLE "PartialDispatchRequest"
  ADD CONSTRAINT "partial_dispatch_moot_not_human"
  CHECK (
    "status" <> 'MOOT'
    OR ("autoDecided" = false AND "reason" IS NULL AND "poa" IS NULL)
  );

-- A shipment carries a positive number of units, never zero or negative.
ALTER TABLE "DispatchItem"
  ADD CONSTRAINT "dispatch_item_quantity_positive" CHECK ("quantity" > 0);
