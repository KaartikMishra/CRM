-- =============================================================================
--  Every newly recorded Purchase Bill needs an administrator's sign-off.
--
--  Recording a bill is procurement work; trusting it is not. A bill now starts
--  PENDING and its stock cannot be allocated to a customer order until somebody
--  with approval rights has approved it.
--
--  A SEPARATE COLUMN, NOT A NEW PurchaseBillStatus VALUE. That enum says how
--  much of the goods have arrived and is recomputed from the lines on every
--  receipt, so a PENDING_APPROVAL member there would be overwritten by the next
--  receipt — and could never express "fully received, still awaiting sign-off",
--  which is an ordinary state. Arrival and authorisation are independent facts.
--  (Postgres also refuses to use an enum value in the same transaction that
--  adds it, which would have forced this into two migrations for no benefit.)
--
--  ADDITIVE. One enum, four columns, one index, one foreign key. No existing
--  column is altered or dropped, no quantity, rate, total or allocation is
--  touched, and no row is deleted.
-- =============================================================================

CREATE TYPE "BillApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- Added WITHOUT a default first, so every existing row lands NULL and can be
-- given its correct value deliberately below, rather than being swept to
-- PENDING by a default and then corrected.
ALTER TABLE "PurchaseBill" ADD COLUMN "approvalStatus" "BillApprovalStatus";
ALTER TABLE "PurchaseBill" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "PurchaseBill" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseBill" ADD COLUMN "reviewNote" TEXT;

-- --------------------------------------------------------------------------
--  Existing bills are APPROVED, and this is the whole point of the backfill.
--
--  These bills were recorded under a rule that did not require sign-off. They
--  have been received against, allocated from, and reported on. Leaving them
--  PENDING would retro-suspend working history: stock already promised to
--  customers would sit behind an approval nobody knew was needed, and an
--  administrator would face a queue of bills from before the rule existed.
--
--  `reviewedById` is deliberately left NULL on these rows. Naming a reviewer
--  would be inventing a decision nobody made — "approved because it predates
--  the rule" is honestly recorded as an approval with no reviewer, which is
--  exactly what the review-pairing CHECK below is written to permit.
-- --------------------------------------------------------------------------

UPDATE "PurchaseBill" SET "approvalStatus" = 'APPROVED' WHERE "approvalStatus" IS NULL;

-- Only now is the column made NOT NULL and given its default, so from here on
-- every *new* bill starts PENDING while every *existing* one stays APPROVED.
ALTER TABLE "PurchaseBill" ALTER COLUMN "approvalStatus" SET NOT NULL;
ALTER TABLE "PurchaseBill" ALTER COLUMN "approvalStatus" SET DEFAULT 'PENDING';

-- Reviewer and moment are written together or not at all — the same pairing
-- sales_change_review_recorded_together enforces on SalesItemChangeRequest.
ALTER TABLE "PurchaseBill"
  ADD CONSTRAINT "bill_review_recorded_together"
  CHECK (("reviewedById" IS NULL) = ("reviewedAt" IS NULL));

/*
  A decided bill carries a reviewer — except the backfilled ones.

  The exemption is narrow and explicit: a row may be APPROVED with no reviewer
  only if it also has no reviewedAt, which is precisely the shape the backfill
  above produced and which nothing writing through the service can create (it
  always writes both). A REJECTED bill always needs a reviewer, because no
  historical row is rejected.
*/
ALTER TABLE "PurchaseBill"
  ADD CONSTRAINT "bill_decided_has_reviewer"
  CHECK (
    "approvalStatus" = 'PENDING'
    OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)
    OR ("approvalStatus" = 'APPROVED' AND "reviewedById" IS NULL AND "reviewedAt" IS NULL)
  );

CREATE INDEX "PurchaseBill_approvalStatus_billDate_idx"
  ON "PurchaseBill"("approvalStatus", "billDate");

-- RESTRICT, matching the other reviewer references: a sign-off is a record of
-- who took responsibility, and blanking it would leave an audit row that no
-- longer says who decided.
ALTER TABLE "PurchaseBill" ADD CONSTRAINT "PurchaseBill_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
