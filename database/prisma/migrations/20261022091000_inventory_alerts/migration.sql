-- Inventory Alerts — monitoring configuration and alert history.
--
-- Purely additive: two new tables, two new enums, their indexes and foreign
-- keys. No existing column, constraint or row is altered.
--
-- ## Six drift statements were stripped by hand
--
-- `prisma migrate diff` wanted to emit these as well:
--
--     ALTER TABLE "SalesOrder"                DROP CONSTRAINT "SalesOrder_cancelledById_fkey";
--     ALTER TABLE "PurchaseBill"              DROP CONSTRAINT "PurchaseBill_reviewedById_fkey";
--     ALTER TABLE "PurchaseItemProductChange" DROP CONSTRAINT "PurchaseItemProductChange_reviewedById_fkey";
--     ... and three matching ADD CONSTRAINT ... ON DELETE SET NULL
--
-- They are NOT part of this feature. The live database holds all three as
-- ON DELETE RESTRICT (verified: pg_constraint.confdeltype = 'r'), which is
-- deliberate — a decision whose decider vanished is unreadable evidence. The
-- schema file says SET NULL, so the diff tool reports the gap on every
-- migration; the same six statements were stripped from the HR Phase 6
-- migration for the same reason. Both halves were removed, so this migration
-- neither applies nor reverts the drift.
--
-- ## The partial unique index
--
-- `InventoryAlert_one_active_per_monitor` is the real guarantee that one
-- configuration cannot hold two active alerts. Prisma cannot express a partial
-- unique index, so it is written here by hand. It is a database constraint
-- rather than a service check because two concurrent stock updates can both
-- read "no active alert" and both insert; the loser gets P2002, which the
-- service treats as "somebody else raised it". This is the first partial
-- unique index in this schema.
--
-- Scoped to status = 'ACTIVE' so a configuration may accumulate any number of
-- RESOLVED rows — the history the feature exists to keep.
--
-- ## Why alert history survives a deleted variant
--
-- A Shopify sync hard-deletes variants absent from a payload, and
-- ShopifyVariant itself cascades from RsProduct. Preserving the record that a
-- product once ran out of stock therefore takes TWO nullable relations, not
-- one:
--
--   MonitoredVariant.variantId  TEXT NULL, ON DELETE SET NULL
--   InventoryAlert.variantId    TEXT NULL, ON DELETE SET NULL
--
-- The first is the one that is easy to get wrong. With MonitoredVariant.
-- variantId NOT NULL and ON DELETE CASCADE, deleting a variant removed the
-- configuration — and InventoryAlert cascades from the configuration, so the
-- history went with it. Making only InventoryAlert.variantId nullable does not
-- help: that row is destroyed by the monitoredVariantId cascade before its own
-- SET NULL can matter.
--
-- So the configuration is DETACHED rather than deleted: it survives with a null
-- variantId, `archivedAt` is stamped by the reconciliation pass in
-- inventory-alert.service.ts, and any live alert is closed with resolution
-- VARIANT_REMOVED. The snapshot columns (productTitleAtRaise, skuAtRaise,
-- rsProductIdAtRaise, thresholdAtRaise, stockAtRaise) are what keep a detached
-- row explicable once its variant is gone.
--
-- InventoryAlert.monitoredVariantId keeps ON DELETE CASCADE deliberately. No
-- code deletes a configuration — archiving is the only removal — so the cascade
-- is unreachable in practice; if one were ever deleted on purpose, its history
-- is scoped to it and should go too.
--
-- `@unique` on a nullable variantId still enforces one configuration per LIVE
-- variant: Postgres permits many NULLs in a unique index, so any number of
-- archived configurations coexist.

-- CreateEnum
CREATE TYPE "InventoryAlertResolution" AS ENUM ('STOCK_RECOVERED', 'MONITORING_DISABLED', 'THRESHOLD_CHANGED', 'VARIANT_REMOVED');
-- CreateEnum
CREATE TYPE "InventoryAlertStatus" AS ENUM ('ACTIVE', 'RESOLVED');
-- CreateTable
CREATE TABLE "MonitoredVariant" (
    "id" TEXT NOT NULL,
    "variantId" TEXT,
    "threshold" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoredVariant_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "InventoryAlert" (
    "id" TEXT NOT NULL,
    "monitoredVariantId" TEXT NOT NULL,
    "variantId" TEXT,
    "status" "InventoryAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "resolution" "InventoryAlertResolution",
    "thresholdAtRaise" INTEGER NOT NULL,
    "stockAtRaise" INTEGER NOT NULL,
    "productTitleAtRaise" TEXT NOT NULL,
    "skuAtRaise" TEXT,
    "rsProductIdAtRaise" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "stockAtResolve" INTEGER,

    CONSTRAINT "InventoryAlert_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "MonitoredVariant_variantId_key" ON "MonitoredVariant"("variantId");
-- CreateIndex
CREATE INDEX "MonitoredVariant_isActive_idx" ON "MonitoredVariant"("isActive");
-- CreateIndex
CREATE INDEX "InventoryAlert_status_raisedAt_idx" ON "InventoryAlert"("status", "raisedAt");
-- CreateIndex
CREATE INDEX "InventoryAlert_monitoredVariantId_raisedAt_idx" ON "InventoryAlert"("monitoredVariantId", "raisedAt");
-- AddForeignKey
ALTER TABLE "MonitoredVariant" ADD CONSTRAINT "MonitoredVariant_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ShopifyVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "MonitoredVariant" ADD CONSTRAINT "MonitoredVariant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "MonitoredVariant" ADD CONSTRAINT "MonitoredVariant_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "InventoryAlert" ADD CONSTRAINT "InventoryAlert_monitoredVariantId_fkey" FOREIGN KEY ("monitoredVariantId") REFERENCES "MonitoredVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "InventoryAlert" ADD CONSTRAINT "InventoryAlert_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ShopifyVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
-- At most one ACTIVE alert per monitoring configuration. Partial, so RESOLVED
-- history is unbounded. See the header note.
CREATE UNIQUE INDEX "InventoryAlert_one_active_per_monitor"
  ON "InventoryAlert"("monitoredVariantId") WHERE "status" = 'ACTIVE';

-- A threshold is a count of units: whole and never negative. A negative
-- threshold would make every variant permanently alerting, and the Zod schema
-- already refuses one — this is the same rule stated where it cannot be
-- bypassed by a direct write.
ALTER TABLE "MonitoredVariant"
  ADD CONSTRAINT "monitored_variant_threshold_non_negative"
  CHECK ("threshold" >= 0);

-- A resolved alert says when and why; an active one says neither. Without this
-- a row could claim to be ACTIVE while carrying a resolvedAt, and the history
-- would contradict itself.
ALTER TABLE "InventoryAlert"
  ADD CONSTRAINT "inventory_alert_resolution_consistency"
  CHECK (
    ("status" = 'ACTIVE'   AND "resolvedAt" IS NULL     AND "resolution" IS NULL)
    OR
    ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolution" IS NOT NULL)
  );
