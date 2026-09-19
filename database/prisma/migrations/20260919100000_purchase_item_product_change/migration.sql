-- =============================================================================
--  Changing an already-mapped purchase line needs an administrator's approval.
--
--  Giving an UNMAPPED line its first RS Product stays ordinary Procurement work
--  and is unaffected by everything here. What this adds is the gate on the other
--  case: moving a line that already names a product. By then the mapping has
--  been read by the shortage board, may have stock allocated through it, and is
--  the value allocation compares identity on — so changing it silently moves
--  goods between products with none of allocation's checks running.
--
--  PURELY ADDITIVE. One enum, one table, four indexes. No column is altered, no
--  row is written, nothing is dropped, and every existing mapping keeps exactly
--  the product it has. A deployment that stopped immediately after this file
--  would behave precisely as before.
--
--  Modelled on SalesItemChangeRequest rather than invented beside it: same three
--  states, same requestedBy/reviewedBy pairing, same "a request records what was
--  asked and changes nothing until approved" rule.
-- =============================================================================

CREATE TYPE "ProductChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "PurchaseItemProductChange" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    -- Both ends of the move are stored. Re-reading the line at approval time
    -- would answer a different question: if the mapping moved in between, the
    -- request on file is no longer the one being decided, and keeping the
    -- original value is what makes that visible instead of silently applying.
    "fromRsProductId" TEXT NOT NULL,
    "toRsProductId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ProductChangeStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "PurchaseItemProductChange_pkey" PRIMARY KEY ("id")
);

-- A request that proposes the product the line already has is not a change.
-- Refused here as well as in the service, so a direct database write cannot
-- create one either.
ALTER TABLE "PurchaseItemProductChange"
  ADD CONSTRAINT "product_change_moves_product" CHECK ("fromRsProductId" <> "toRsProductId");

-- Reviewer and moment are written together or not at all, and a decided request
-- must carry both — the same pairing sales_change_review_recorded_together
-- enforces on SalesItemChangeRequest.
ALTER TABLE "PurchaseItemProductChange"
  ADD CONSTRAINT "product_change_review_recorded_together"
  CHECK (("reviewedById" IS NULL) = ("reviewedAt" IS NULL));

ALTER TABLE "PurchaseItemProductChange"
  ADD CONSTRAINT "product_change_decided_has_reviewer"
  CHECK ("status" = 'PENDING' OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL));

CREATE INDEX "PurchaseItemProductChange_status_requestedAt_idx"
  ON "PurchaseItemProductChange"("status", "requestedAt");
CREATE INDEX "PurchaseItemProductChange_itemId_status_idx"
  ON "PurchaseItemProductChange"("itemId", "status");
CREATE INDEX "PurchaseItemProductChange_billId_status_idx"
  ON "PurchaseItemProductChange"("billId", "status");

-- One open request per line, guaranteed rather than merely checked.
--
-- The service checks it too, for a readable message, but two people racing the
-- same line would both pass that check and file two contradictory proposals —
-- and approving both would move the mapping twice. Partial, so the history of
-- decided requests on a line is unlimited.
CREATE UNIQUE INDEX "PurchaseItemProductChange_one_pending_per_item"
  ON "PurchaseItemProductChange"("itemId") WHERE "status" = 'PENDING';

ALTER TABLE "PurchaseItemProductChange" ADD CONSTRAINT "PurchaseItemProductChange_billId_fkey"
  FOREIGN KEY ("billId") REFERENCES "PurchaseBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseItemProductChange" ADD CONSTRAINT "PurchaseItemProductChange_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "PurchaseBillItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, deliberately, where the mapping columns use SET NULL: a request is a
-- record of a decision about two specific products, and blanking either end
-- would leave an audit row that no longer says what was asked.
ALTER TABLE "PurchaseItemProductChange" ADD CONSTRAINT "PurchaseItemProductChange_fromRsProductId_fkey"
  FOREIGN KEY ("fromRsProductId") REFERENCES "RsProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseItemProductChange" ADD CONSTRAINT "PurchaseItemProductChange_toRsProductId_fkey"
  FOREIGN KEY ("toRsProductId") REFERENCES "RsProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseItemProductChange" ADD CONSTRAINT "PurchaseItemProductChange_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseItemProductChange" ADD CONSTRAINT "PurchaseItemProductChange_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
