-- =============================================================================
--  ShopifyWebhookEvent gains claimedAt and attempts.
--
--  Recovery for an event whose worker died mid-handler.
--
--  Today a row with processedAt and error both null is ambiguous: it is either
--  a delivery being processed right now, or one abandoned by a crashed process.
--  The handler cannot tell them apart, so it treats both as "somebody else has
--  it" and acknowledges — which is correct for the first case and loses the
--  second permanently once Shopify's eight retries are exhausted.
--
--  claimedAt removes the ambiguity by recording *when* the claim was taken. A
--  claim older than the stale threshold is assumed abandoned and may be taken
--  over; a recent one is left strictly alone, so two workers still never
--  process the same event at the same time.
--
--  attempts counts how many times processing has been tried, so a permanently
--  failing event is visible rather than retried silently forever.
--
--  Both nullable/defaulted, so existing rows need no backfill: an event already
--  recorded simply has no claim timestamp, which reads as "not currently
--  claimed" — the correct interpretation for anything already finished.
--
--  Purely additive. Two columns and one index on one RS Products table. No
--  existing column is altered, and Product, InventoryItem, SalesOrder,
--  PurchaseBill and ProductEnquiry are untouched.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

-- AlterTable
ALTER TABLE "ShopifyWebhookEvent" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "ShopifyWebhookEvent_processedAt_claimedAt_idx" ON "ShopifyWebhookEvent"("processedAt", "claimedAt");
