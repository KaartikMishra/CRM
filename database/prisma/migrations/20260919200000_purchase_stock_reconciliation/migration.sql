-- =============================================================================
--  Purchased stock reaches CRM stock, once, and only when it is free.
--
--  The rule: an APPROVED bill line contributes its received quantity MINUS
--  whatever is already committed to a customer requirement. Received 5 against
--  a requirement of 1 puts 4 into CRM stock; the committed 1 never becomes free
--  stock because it is already spoken for.
--
--  `stockedQty` is what makes that idempotent. It records how much this line
--  currently stands to CRM stock, so every event — approval, a further receipt,
--  an allocation, a released allocation, a retried request — is applied as
--
--      target = approved && mapped ? receivedQty − Σ allocations : 0
--      delta  = target − stockedQty
--
--  rather than as a repeated addition of receivedQty, which would credit the
--  cumulative total again on every receipt.
--
--  ADDITIVE, and deliberately NOT a stock ledger: one integer on a row that
--  already exists, reconciled in place. No movement table, no second stock
--  source. CRM stock stays where it has always lived — ShopifyVariant.crmStockQty
--  — and Shopify's own inventoryQty is not touched here or anywhere else.
-- =============================================================================

ALTER TABLE "PurchaseBillItem" ADD COLUMN "stockedQty" INTEGER NOT NULL DEFAULT 0;

-- --------------------------------------------------------------------------
--  Existing lines are marked as ALREADY reconciled. No stock moves.
--
--  This is the load-bearing half of the migration, and the reason the column is
--  not simply left at its default.
--
--  Every bill that exists today was backfilled to APPROVED by the approval
--  migration, and several lines carry a surplus — received above what is
--  allocated. Leaving those at stockedQty = 0 would mean the next event on any
--  of them (a receipt correction, an allocation, a released allocation) computed
--  a delta against zero and poured their entire historical surplus into CRM
--  stock, months after the goods arrived. That is a retroactive rewrite of
--  hand-maintained counts, not a migration.
--
--  Setting stockedQty to each line's CURRENT target instead means delta = 0 for
--  every existing line: nothing is credited now, no crmStockQty value is
--  touched, and from here on those lines behave correctly because only genuine
--  future changes produce a non-zero delta.
--
--  GREATEST(...,0) guards the one case the arithmetic cannot express: a line
--  allocated beyond what it received. None exists today, and a negative
--  contribution would be meaningless rather than merely wrong.
-- --------------------------------------------------------------------------

UPDATE "PurchaseBillItem" pbi
SET "stockedQty" = GREATEST(
  0,
  pbi."receivedQty" - COALESCE(
    (SELECT SUM(pa."quantity")::int
     FROM "PurchaseAllocation" pa
     WHERE pa."purchaseBillItemId" = pbi."id"),
    0
  )
)
WHERE pbi."rsProductId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "PurchaseBill" b
    WHERE b."id" = pbi."billId" AND b."approvalStatus" = 'APPROVED'
  );

-- Unmapped lines and lines on pending or rejected bills contribute nothing, so
-- their target is 0 and the column default is already correct for them.

-- A line cannot stand for a negative amount of stock.
ALTER TABLE "PurchaseBillItem"
  ADD CONSTRAINT "purchase_item_stocked_not_negative" CHECK ("stockedQty" >= 0);
