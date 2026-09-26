-- =============================================================================
--  Payment method, and approval for editing an order's charges
--
--  Two additions, both strictly additive. Nothing is dropped, nothing is
--  rewritten, and no existing row changes value:
--
--    1. SalesOrder."paymentMethod" — nullable, no default. Every existing order
--       keeps NULL, which is the honest answer for one recorded before the
--       column existed and for one on which no payment has been taken. The
--       service requires a method exactly when money is recorded.
--
--    2. SalesChargeChangeRequest — a proposed replacement for an order's
--       charges, held apart from the charges themselves until somebody with
--       SALES ASSIGN decides it. It reuses the existing "SalesChangeStatus"
--       enum rather than declaring a second one, so the CRM keeps one
--       vocabulary for "a change somebody asked for".
--
--  Deliberately NOT touched: sales_order_money_guard. Neither addition is a
--  term in the payable. A payment method says how the paidAmount arrived, not
--  how much, and a PENDING charge request is a proposal that moves no money —
--  which is the whole point of holding it in its own table. The trigger sums
--  "SalesOrderCharge" and nothing else, so TypeScript and plpgsql still agree
--  to the paisa and no existing order's payable moves.
-- =============================================================================

-- The money guard is DEFERRABLE INITIALLY DEFERRED, so any events still pending
-- in this transaction would fire during the DDL below and read a table mid-ALTER.
-- Forcing them now keeps that from happening. Harmless when there are none.
SET CONSTRAINTS ALL IMMEDIATE;

-- -----------------------------------------------------------------------------
--  1. How the order is being paid
-- -----------------------------------------------------------------------------
--  TEXT rather than a Postgres enum, following "gstMode", "gstRate" and
--  Customer."state": these are business lists that get revised, and an enum
--  charges an ALTER TYPE for every revision while never letting a value be
--  dropped. The shared z.enum in @rs/shared is what restricts it.
ALTER TABLE "SalesOrder" ADD COLUMN "paymentMethod" TEXT;

-- -----------------------------------------------------------------------------
--  2. A proposed change to an order's charges
-- -----------------------------------------------------------------------------
CREATE TABLE "SalesChargeChangeRequest" (
    "id"              TEXT NOT NULL,
    "orderId"         TEXT NOT NULL,
    "status"          "SalesChangeStatus" NOT NULL DEFAULT 'PENDING',
    -- The complete proposed set, as PUT /api/sales/:id/charges takes it.
    -- Re-validated against the shared schema before it is ever applied.
    "proposedCharges" JSONB NOT NULL,
    "requestedById"   TEXT NOT NULL,
    "requestedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById"    TEXT,
    "reviewedAt"      TIMESTAMP(3),
    "reviewNote"      TEXT,

    CONSTRAINT "SalesChargeChangeRequest_pkey" PRIMARY KEY ("id")
);

-- The one access path: an order's requests, usually only the PENDING one.
CREATE INDEX "SalesChargeChangeRequest_orderId_status_idx"
    ON "SalesChargeChangeRequest"("orderId", "status");

-- Cascade with the order: a deleted order's proposals have nothing to describe.
ALTER TABLE "SalesChargeChangeRequest"
    ADD CONSTRAINT "SalesChargeChangeRequest_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT: who asked for a financial change is part of the record, so the
-- requester cannot be deleted out from under it.
ALTER TABLE "SalesChargeChangeRequest"
    ADD CONSTRAINT "SalesChargeChangeRequest_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalesChargeChangeRequest"
    ADD CONSTRAINT "SalesChargeChangeRequest_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
