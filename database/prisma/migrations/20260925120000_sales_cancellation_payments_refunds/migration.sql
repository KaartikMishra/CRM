-- =============================================================================
--  Cancellation, the payment ledger, and refunds
--
--  Strictly additive. Nothing is dropped, no existing column changes type or
--  nullability, and no existing row's meaning moves. In particular:
--
--    * sales_order_money_guard is NOT touched. It computes the payable from
--      "quantity" * "price" over ACTIVE lines, and this migration leaves
--      "quantity" alone — a cancelled unit is recorded in the new
--      "cancelledQty" beside it. That is the whole reason cancellation is
--      modelled this way: reducing "quantity" would drop the payable below
--      what a part-paid customer has already paid, and the trigger would
--      refuse the transaction at COMMIT. The order's ACTIVE value is derived
--      in the application from the remaining quantities, through the same
--      computeSalesTotals every other figure already goes through, so no
--      second arithmetic is introduced anywhere.
--
--    * "SalesOrder"."paidAmount" stays the enforced figure. The new
--      "SalesPayment" rows are what that figure is made of, written in the
--      same transaction, and their sum equals it — including for history,
--      which is backfilled at the end of this file.
--
--  NOTE ON THE ENUM. 'CANCELLED' is added to an existing type, and Postgres
--  forbids *referencing* a newly added label in the same transaction that adds
--  it. Nothing below references it: the cancellation columns are constrained
--  as an all-or-nothing group rather than against the status, and the service
--  is what ties the group to the status. "SalesRefundStatus" is a brand new
--  type, which carries no such restriction, so its constraints name its values
--  freely.
-- =============================================================================

-- The money guard is DEFERRABLE INITIALLY DEFERRED, so events still pending in
-- this transaction would otherwise fire during the DDL below and read a table
-- mid-ALTER. Harmless when there are none.
SET CONSTRAINTS ALL IMMEDIATE;

-- -----------------------------------------------------------------------------
--  1. An order can be called off
-- -----------------------------------------------------------------------------
ALTER TYPE "SalesOrderStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "SalesOrder" ADD COLUMN "cancelledAt"        TIMESTAMP(3);
ALTER TABLE "SalesOrder" ADD COLUMN "cancelledById"      TEXT;
ALTER TABLE "SalesOrder" ADD COLUMN "cancellationReason" TEXT;

-- Who cancelled it is part of the record, so they cannot be deleted out from
-- under it — the same RESTRICT "closedById" already carries.
ALTER TABLE "SalesOrder"
    ADD CONSTRAINT "SalesOrder_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- All three or none of them. A cancellation with no reason recorded is
-- unauditable, and one with no canceller names nobody.
ALTER TABLE "SalesOrder"
    ADD CONSTRAINT "sales_cancellation_recorded_together" CHECK (
        ("cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL)
        OR
        ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL
         AND "cancellationReason" IS NOT NULL AND length(btrim("cancellationReason")) > 0)
    );

-- -----------------------------------------------------------------------------
--  2. Individual units can be called off, without losing what was ordered
-- -----------------------------------------------------------------------------
ALTER TABLE "SalesOrderItem" ADD COLUMN "cancelledQty" INTEGER NOT NULL DEFAULT 0;

-- Several partial cancellations can never sum past what was ordered, and a
-- negative one cannot quietly restore a line.
ALTER TABLE "SalesOrderItem"
    ADD CONSTRAINT "sales_item_cancelled_within_quantity"
    CHECK ("cancelledQty" >= 0 AND "cancelledQty" <= "quantity");

-- -----------------------------------------------------------------------------
--  3. The payment ledger
-- -----------------------------------------------------------------------------
CREATE TABLE "SalesPayment" (
    "id"           TEXT NOT NULL,
    "orderId"      TEXT NOT NULL,
    "amount"       DECIMAL(14,2) NOT NULL,
    -- One of PAYMENT_METHODS in @rs/shared; TEXT for the same reason
    -- "SalesOrder"."paymentMethod" is TEXT.
    "method"       TEXT,
    -- UTR, cheque number, whatever names this payment elsewhere. Free text:
    -- the format differs per method and per bank, and a pattern that rejected
    -- a valid reference would stop a real payment being recorded.
    "reference"    TEXT,
    "note"         TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesPayment_pkey" PRIMARY KEY ("id")
);

-- Money going out is a SalesRefund, never a negative payment, so that
-- sum(amount) keeps meaning "what the customer has paid".
ALTER TABLE "SalesPayment"
    ADD CONSTRAINT "sales_payment_amount_positive" CHECK ("amount" > 0);

CREATE INDEX "SalesPayment_orderId_recordedAt_idx"
    ON "SalesPayment"("orderId", "recordedAt");

ALTER TABLE "SalesPayment"
    ADD CONSTRAINT "SalesPayment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SalesPayment"
    ADD CONSTRAINT "SalesPayment_recordedById_fkey"
    FOREIGN KEY ("recordedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
--  4. Refunds
-- -----------------------------------------------------------------------------
CREATE TYPE "SalesRefundStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

CREATE TABLE "SalesRefund" (
    "id"            TEXT NOT NULL,
    "orderId"       TEXT NOT NULL,
    "amount"        DECIMAL(14,2) NOT NULL,
    "status"        "SalesRefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason"        TEXT NOT NULL,
    "reference"     TEXT,
    "note"          TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledById"   TEXT,
    "settledAt"     TIMESTAMP(3),

    CONSTRAINT "SalesRefund_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SalesRefund"
    ADD CONSTRAINT "sales_refund_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "SalesRefund"
    ADD CONSTRAINT "sales_refund_reason_present" CHECK (length(btrim("reason")) > 0);

-- The settlement pairing every other decision in this schema uses.
ALTER TABLE "SalesRefund"
    ADD CONSTRAINT "sales_refund_settled_recorded_together"
    CHECK (("settledAt" IS NULL) = ("settledById" IS NULL));

-- A refund still waiting has no settler; one that has been decided has both.
ALTER TABLE "SalesRefund"
    ADD CONSTRAINT "sales_refund_decided_has_settler"
    CHECK ("status" = 'PENDING' OR ("settledAt" IS NOT NULL AND "settledById" IS NOT NULL));

-- Claiming the money went back requires saying how it went. This is the
-- constraint that stops a refund being marked done on somebody's say-so with
-- nothing to check it against.
ALTER TABLE "SalesRefund"
    ADD CONSTRAINT "sales_refund_completed_has_reference"
    CHECK ("status" <> 'COMPLETED' OR ("reference" IS NOT NULL AND length(btrim("reference")) > 0));

CREATE INDEX "SalesRefund_orderId_status_idx" ON "SalesRefund"("orderId", "status");

ALTER TABLE "SalesRefund"
    ADD CONSTRAINT "SalesRefund_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SalesRefund"
    ADD CONSTRAINT "SalesRefund_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalesRefund"
    ADD CONSTRAINT "SalesRefund_settledById_fkey"
    FOREIGN KEY ("settledById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
--  5. History keeps the invariant
-- -----------------------------------------------------------------------------
--  Every order that has taken money gets one payment row carrying exactly the
--  amount already recorded on it, so sum("SalesPayment"."amount") =
--  "SalesOrder"."paidAmount" holds for orders written before this table as well
--  as after it. The amount is real — it is the figure the money guard has been
--  enforcing all along. What was never captured is the instalment breakdown,
--  and the note says so rather than inventing one.
--
--  Attributed to whoever created the order, at the moment the order was
--  created: the only two facts actually on record. "recordedById" is NOT NULL
--  and "createdById" is the honest answer available.
INSERT INTO "SalesPayment" ("id", "orderId", "amount", "method", "reference", "note", "recordedById", "recordedAt")
SELECT
    'c' || substr(md5(random()::text || o."id"), 1, 24),
    o."id",
    o."paidAmount",
    o."paymentMethod",
    NULL,
    'Recorded before the payment ledger existed. The amount is the order''s own, but the instalments behind it were never captured.',
    o."createdById",
    o."createdAt"
FROM "SalesOrder" o
WHERE o."paidAmount" > 0;
