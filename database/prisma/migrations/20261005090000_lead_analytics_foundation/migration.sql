-- =============================================================================
--  Lead/Deal analytics foundation — Phase 4B.
--
--  Three new enums, four additive columns on "Lead", and two new tables.
--  Strictly additive: no existing table is altered beyond gaining nullable or
--  defaulted columns, no existing column changes type, nothing is backfilled,
--  and no row is read, written or removed.
--
--  NO BACKFILL IS NEEDED, by design:
--    * "dealStatus" defaults to INPROCESS — a lead captured before this column
--      existed was, and still is, undecided.
--    * every new relation is nullable, so an existing lead with no associate,
--      no allocator and no order remains valid.
--
--  WHAT THIS DELIBERATELY DOES NOT DO:
--
--    * It stores NO promptness score and NO GOOD/AVERAGE/POOR column.
--      "LeadActivity"."dueAt" and "completedAt" are the source of truth, and the
--      rating is arithmetic over those rows on every read. A stored rating would
--      need a sweep to flip as a deadline passed — the same reason
--      ProcurementClock's `clockState` is derived rather than columned.
--    * It stores NO "SELF"/"OTHER USER" column. That is
--      allocatedById = associateId, computed from two columns that already exist
--      below; a third would be free to disagree with them.
--    * It stores NO order value on the lead. Value is read through
--      "salesOrderId"; a copy would drift the first time a charge changed.
--    * It stores NO volume. Volume is lengthMm x widthMm x heightMm, null if any
--      is null, and a column would be a fourth number free to contradict three.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

CREATE TYPE "DealStatus" AS ENUM ('WON', 'LOST', 'INPROCESS');

CREATE TYPE "LeadActivityKind" AS ENUM ('FIRST_CONTACT', 'FOLLOW_UP', 'RESULT');

CREATE TYPE "ProductMatchKind" AS ENUM ('EXACT', 'SIMILAR');

-- --------------------------------------------------------------------------
--  Lead gains four columns. Every one is defaulted or nullable.
-- --------------------------------------------------------------------------

ALTER TABLE "Lead" ADD COLUMN     "dealStatus" "DealStatus" NOT NULL DEFAULT 'INPROCESS';
ALTER TABLE "Lead" ADD COLUMN     "associateId" TEXT;
ALTER TABLE "Lead" ADD COLUMN     "allocatedById" TEXT;
ALTER TABLE "Lead" ADD COLUMN     "salesOrderId" TEXT;

-- One order is the result of at most one lead. Partial by nature: many leads
-- have no order, and NULLs do not collide in a Postgres unique index.
CREATE UNIQUE INDEX "Lead_salesOrderId_key" ON "Lead"("salesOrderId");

-- The analytics table's own reads: one associate's work, and the board by status.
CREATE INDEX "Lead_associateId_createdAt_idx" ON "Lead"("associateId", "createdAt");
CREATE INDEX "Lead_dealStatus_createdAt_idx" ON "Lead"("dealStatus", "createdAt");

-- Restrict on both people: an associate or allocator carrying leads is
-- referenced history, and removing them should fail loudly rather than quietly
-- detach the attribution a promptness score depends on. SetNull on the order,
-- because a lead outlives the order it produced.
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_allocatedById_fkey" FOREIGN KEY ("allocatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
--  LeadActivity — the source of truth for promptness.
-- --------------------------------------------------------------------------

CREATE TABLE "LeadActivity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" "LeadActivityKind" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "performedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- One lead's timeline in order, and the promptness query's own shape. The second
-- mirrors ProcurementClock's (completedAt, deadline) index for the same reason:
-- every promptness read filters on exactly that pair.
CREATE INDEX "LeadActivity_leadId_dueAt_idx" ON "LeadActivity"("leadId", "dueAt");
CREATE INDEX "LeadActivity_completedAt_dueAt_idx" ON "LeadActivity"("completedAt", "dueAt");

ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NO constraint relating "completedAt" to "dueAt", deliberately. Completing
-- early is the good case, completing late is the case promptness exists to
-- measure, and never completing is a null — all three are valid rows, and the
-- scoring reads them rather than the database forbidding any of them.

-- --------------------------------------------------------------------------
--  LeadProductRequirement — what the customer actually wants.
-- --------------------------------------------------------------------------

CREATE TABLE "LeadProductRequirement" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "imageId" TEXT,
    "rsProductId" TEXT,
    "matchKind" "ProductMatchKind",
    "quantity" INTEGER NOT NULL,
    "weightValue" DECIMAL(10,3),
    "weightUnit" "WeightUnit",
    "weightInGrams" DECIMAL(12,3),
    "lengthValue" DECIMAL(10,2),
    "widthValue" DECIMAL(10,2),
    "heightValue" DECIMAL(10,2),
    "dimensionUnit" "DimensionUnit",
    "lengthMm" DECIMAL(12,2),
    "widthMm" DECIMAL(12,2),
    "heightMm" DECIMAL(12,2),
    "productValue" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadProductRequirement_pkey" PRIMARY KEY ("id")
);

-- Line numbers are per lead, exactly as EnquiryProduct does per enquiry.
CREATE UNIQUE INDEX "LeadProductRequirement_leadId_lineNo_key" ON "LeadProductRequirement"("leadId", "lineNo");
CREATE INDEX "LeadProductRequirement_rsProductId_idx" ON "LeadProductRequirement"("rsProductId");

ALTER TABLE "LeadProductRequirement" ADD CONSTRAINT "LeadProductRequirement_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadProductRequirement" ADD CONSTRAINT "LeadProductRequirement_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeadProductRequirement" ADD CONSTRAINT "LeadProductRequirement_rsProductId_fkey" FOREIGN KEY ("rsProductId") REFERENCES "RsProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A match kind describes a matched product, so the two travel together or not
-- at all. Stated here as well as in the shared schema, so a row written by any
-- future caller obeys it.
ALTER TABLE "LeadProductRequirement"
  ADD CONSTRAINT "lead_requirement_match_kind_pairing"
  CHECK (
    ("rsProductId" IS NULL AND "matchKind" IS NULL)
    OR ("rsProductId" IS NOT NULL)
  );

-- A requirement is for a positive number of things.
ALTER TABLE "LeadProductRequirement"
  ADD CONSTRAINT "lead_requirement_quantity_positive" CHECK ("quantity" > 0);

-- A quoted value is never negative. Zero is permitted: a sample or a
-- replacement can legitimately be worth nothing.
ALTER TABLE "LeadProductRequirement"
  ADD CONSTRAINT "lead_requirement_value_non_negative"
  CHECK ("productValue" IS NULL OR "productValue" >= 0);
