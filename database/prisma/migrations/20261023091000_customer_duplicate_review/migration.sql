-- All Customers — normalized phone and the duplicate-review record.
--
-- Purely additive: one nullable column, two indexes on an existing table, one
-- new enum, one new table with its indexes and foreign keys. No existing
-- column, constraint or row is altered, and there is no DROP, TRUNCATE, DELETE
-- or UPDATE statement below.
--
-- ## The ALTER TYPE is deliberately not here
--
-- `ALTER TYPE "AppModule" ADD VALUE 'CUSTOMERS'` lives in the preceding
-- migration, 20261023090000_customers_module. PostgreSQL cannot use a newly
-- added enum value in the same transaction that adds it, so the value and its
-- first use must be separate migrations — the same split the inventory-alert
-- notification types and the HR phases each needed.
--
-- ## `phoneNormalized` is backfilled by the application, not here
--
-- No UPDATE statement populates it. The fold is `normalizePhone` in
-- @rs/shared — digits only, no country-code inference, no fuzzy matching — and
-- restating that rule in SQL would create a second definition of "the same
-- number" that could drift from the one the matcher uses. A one-off
-- application-side backfill is reviewed separately; until it runs, the column
-- is null and the directory's phone search simply finds nothing, which is
-- visible rather than wrong.
--
-- The column is nullable and unindexed-for-uniqueness on purpose: `phone`
-- itself is optional, every existing row predates this, and two real people
-- legitimately share a landline.
--
-- ## Why the duplicate pair is stored in a fixed order
--
-- (A, B) and (B, A) are the same pair, so the service writes them with
-- customerAId < customerBId by string comparison and the unique index below
-- makes a second spelling impossible. Without that, one spelling could be
-- dismissed while the other stayed suggested. It is also what makes a rescan
-- idempotent — it upserts the row it already wrote instead of adding a twin.
--
-- ## The table records decisions; it does not merge anything
--
-- Confirming a candidate marks it CONFIRMED and changes no customer row, no
-- enquiry, no lead and no order. Both customer foreign keys are RESTRICT,
-- matching Lead.customerId: a customer named by a review decision is
-- referenced history, and deleting one should fail loudly rather than quietly
-- discard the decision. `decidedById` is SET NULL instead, because the decision
-- outlives the reviewer's account and losing who decided is a smaller loss than
-- losing that a decision was made.

-- CreateEnum
CREATE TYPE "CustomerDuplicateStatus" AS ENUM ('SUGGESTED', 'CONFIRMED', 'DISMISSED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "phoneNormalized" TEXT;

-- CreateTable
CREATE TABLE "CustomerDuplicateCandidate" (
    "id" TEXT NOT NULL,
    "customerAId" TEXT NOT NULL,
    "customerBId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "matchedOn" TEXT NOT NULL,
    "identifierFingerprint" TEXT NOT NULL,
    "status" "CustomerDuplicateStatus" NOT NULL DEFAULT 'SUGGESTED',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerDuplicateCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerDuplicateCandidate_status_score_idx" ON "CustomerDuplicateCandidate"("status", "score");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDuplicateCandidate_customerAId_customerBId_key" ON "CustomerDuplicateCandidate"("customerAId", "customerBId");

-- CreateIndex
CREATE INDEX "Customer_phoneNormalized_idx" ON "Customer"("phoneNormalized");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- AddForeignKey
ALTER TABLE "CustomerDuplicateCandidate" ADD CONSTRAINT "CustomerDuplicateCandidate_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerDuplicateCandidate" ADD CONSTRAINT "CustomerDuplicateCandidate_customerAId_fkey" FOREIGN KEY ("customerAId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerDuplicateCandidate" ADD CONSTRAINT "CustomerDuplicateCandidate_customerBId_fkey" FOREIGN KEY ("customerBId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A score is a percentage: whole, and never outside 0-100. The scorer already
-- clamps it; this is the same rule stated where a direct write cannot bypass it.
ALTER TABLE "CustomerDuplicateCandidate"
  ADD CONSTRAINT "customer_duplicate_score_range"
  CHECK ("score" >= 0 AND "score" <= 100);

-- A pair is two different customers, and stored in one fixed order. Both halves
-- are what the unique index above relies on to make a rescan an upsert.
ALTER TABLE "CustomerDuplicateCandidate"
  ADD CONSTRAINT "customer_duplicate_pair_ordered"
  CHECK ("customerAId" < "customerBId");

-- A decided pair says who decided and when; a suggested one says neither.
-- Without this a row could claim to be DISMISSED while naming no reviewer, and
-- the audit trail would be a record of nothing.
ALTER TABLE "CustomerDuplicateCandidate"
  ADD CONSTRAINT "customer_duplicate_decision_consistency"
  CHECK (
    ("status" = 'SUGGESTED' AND "decidedAt" IS NULL)
    OR
    ("status" IN ('CONFIRMED', 'DISMISSED') AND "decidedAt" IS NOT NULL)
  );
