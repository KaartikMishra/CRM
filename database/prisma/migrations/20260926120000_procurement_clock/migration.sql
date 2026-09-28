-- =============================================================================
--  Procurement Clock — a submodule of Purchase & Procurement
--
--  Strictly additive. Nothing is dropped, no existing column is altered, and no
--  existing row changes value. Two enums and three tables:
--
--    1. ProcurementClock — one row per sales order, holding a T+2 deadline and a
--       completion result. NOTHING ELSE. Every quantity the board shows is
--       computed at read time from the order's own lines, their alreadyFulfilled
--       and their PurchaseAllocation rows, so there is no second copy of the
--       order, its products, its quantities or its stock.
--
--    2. PurchaseDelayReason — the purchase person's explanation for one LINE
--       they could not cover. Decided by PROCUREMENT ASSIGN, never by an
--       administrator.
--
--    3. ProcurementDelayReason — procurement's explanation for an ORDER covered
--       late. Decided by an administrator. Its own table rather than beside the
--       purchase reasons, because the two attach to different things and are
--       decided by different people.
--
--  Deliberately NOT touched: sales_order_money_guard. None of this is a term in
--  the payable — a deadline is not money and a delay reason moves none — so the
--  trigger still sums "SalesOrderItem" and "SalesOrderCharge" and nothing else,
--  and no existing order's payable moves by a paisa.
--
--  Deliberately NOT added: any status column for the four states a reader sees.
--  Two of them (UNFULFILLED vs UNFULFILLED_WITH_DELAY) are a comparison against
--  the clock right now, so storing them would need a periodic sweep to flip
--  one into the other — an automatic action nobody asked for, in a codebase with
--  no scheduler. They are derived, exactly as isOverdue() already derives
--  "overdue" beside the stored SalesEfficiency.
-- =============================================================================

-- The money guard is DEFERRABLE INITIALLY DEFERRED, so any events still pending
-- in this transaction would fire during the DDL below and read a table mid-ALTER.
-- Forcing them now keeps that from happening. Harmless when there are none.
SET CONSTRAINTS ALL IMMEDIATE;

-- -----------------------------------------------------------------------------
--  Enums
-- -----------------------------------------------------------------------------
--  ProcurementVerdict is its own type rather than a reuse of "SalesEfficiency":
--  that one is decided by dispatch and this one by coverage, and SalesEfficiency
--  exists as its own type for exactly that reason.
CREATE TYPE "ProcurementVerdict" AS ENUM ('ON_TIME', 'DELAYED');

--  One vocabulary for both delay chains, as "SalesChangeStatus" is shared across
--  two Sales tables. Three states and no way back.
CREATE TYPE "DelayReasonStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- -----------------------------------------------------------------------------
--  1. The clock
-- -----------------------------------------------------------------------------
CREATE TABLE "ProcurementClock" (
    "id"      TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    -- T+2: the last instant of the IST day two days after the order's own
    -- orderDate. Written once and never recomputed.
    "deadline" TIMESTAMP(3) NOT NULL,
    -- When coverage reached zero. Null while anything is outstanding, and
    -- cleared again if coverage is later lost.
    "completedAt" TIMESTAMP(3),
    "verdict"     "ProcurementVerdict",
    -- True only where the backfill below could not establish a real instant.
    "completionEstimated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementClock_pkey" PRIMARY KEY ("id")
);

-- One clock per order.
CREATE UNIQUE INDEX "ProcurementClock_orderId_key" ON "ProcurementClock"("orderId");

-- The board: outstanding orders by deadline, completed ones by result.
CREATE INDEX "ProcurementClock_completedAt_deadline_idx"
    ON "ProcurementClock"("completedAt", "deadline");

-- A completion records both its moment and its verdict, or neither. This is the
-- clock's equivalent of sales_efficiency_accompanies_dispatch.
ALTER TABLE "ProcurementClock"
    ADD CONSTRAINT "procurement_clock_verdict_with_completion"
    CHECK (("completedAt" IS NULL) = ("verdict" IS NULL));

-- An estimate is a statement about a completion, so there has to be one.
ALTER TABLE "ProcurementClock"
    ADD CONSTRAINT "procurement_clock_estimate_has_completion"
    CHECK ("completionEstimated" = false OR "completedAt" IS NOT NULL);

-- Cascade with the order: a deleted order's clock has nothing to measure.
ALTER TABLE "ProcurementClock"
    ADD CONSTRAINT "ProcurementClock_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
--  2. The purchase person's reason, per order line
-- -----------------------------------------------------------------------------
CREATE TABLE "PurchaseDelayReason" (
    "id"               TEXT NOT NULL,
    "salesOrderItemId" TEXT NOT NULL,
    "reason"           TEXT NOT NULL,
    "status"           "DelayReasonStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById"    TEXT NOT NULL,
    "requestedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById"     TEXT,
    "reviewedAt"       TIMESTAMP(3),
    "reviewNote"       TEXT,

    CONSTRAINT "PurchaseDelayReason_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseDelayReason_status_requestedAt_idx"
    ON "PurchaseDelayReason"("status", "requestedAt");
CREATE INDEX "PurchaseDelayReason_salesOrderItemId_status_idx"
    ON "PurchaseDelayReason"("salesOrderItemId", "status");

-- An explanation nobody wrote explains nothing.
ALTER TABLE "PurchaseDelayReason"
    ADD CONSTRAINT "purchase_delay_reason_present"
    CHECK (length(btrim("reason")) > 0);

-- A decision records both its author and its moment, or neither.
ALTER TABLE "PurchaseDelayReason"
    ADD CONSTRAINT "purchase_delay_review_recorded_together"
    CHECK (("reviewedById" IS NULL) = ("reviewedAt" IS NULL));

-- Anything no longer pending has been decided by somebody.
ALTER TABLE "PurchaseDelayReason"
    ADD CONSTRAINT "purchase_delay_decided_has_reviewer"
    CHECK ("status" = 'PENDING' OR "reviewedById" IS NOT NULL);

-- One open reason per line, enforced by the database rather than the UI, so two
-- people cannot queue contradictory explanations for the same goods. Partial:
-- decided reasons accumulate freely as history.
CREATE UNIQUE INDEX "purchase_delay_one_pending_per_item"
    ON "PurchaseDelayReason"("salesOrderItemId")
    WHERE "status" = 'PENDING';

ALTER TABLE "PurchaseDelayReason"
    ADD CONSTRAINT "PurchaseDelayReason_salesOrderItemId_fkey"
    FOREIGN KEY ("salesOrderItemId") REFERENCES "SalesOrderItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT on the submitter: who offered an explanation is part of the record,
-- matching how the other request tables treat their requester.
ALTER TABLE "PurchaseDelayReason"
    ADD CONSTRAINT "PurchaseDelayReason_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseDelayReason"
    ADD CONSTRAINT "PurchaseDelayReason_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
--  3. Procurement's own reason, per order
-- -----------------------------------------------------------------------------
CREATE TABLE "ProcurementDelayReason" (
    "id"            TEXT NOT NULL,
    "clockId"       TEXT NOT NULL,
    "reason"        TEXT NOT NULL,
    "status"        "DelayReasonStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById"  TEXT,
    "reviewedAt"    TIMESTAMP(3),
    "reviewNote"    TEXT,

    CONSTRAINT "ProcurementDelayReason_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProcurementDelayReason_status_requestedAt_idx"
    ON "ProcurementDelayReason"("status", "requestedAt");
CREATE INDEX "ProcurementDelayReason_clockId_status_idx"
    ON "ProcurementDelayReason"("clockId", "status");

ALTER TABLE "ProcurementDelayReason"
    ADD CONSTRAINT "procurement_delay_reason_present"
    CHECK (length(btrim("reason")) > 0);

ALTER TABLE "ProcurementDelayReason"
    ADD CONSTRAINT "procurement_delay_review_recorded_together"
    CHECK (("reviewedById" IS NULL) = ("reviewedAt" IS NULL));

ALTER TABLE "ProcurementDelayReason"
    ADD CONSTRAINT "procurement_delay_decided_has_reviewer"
    CHECK ("status" = 'PENDING' OR "reviewedById" IS NOT NULL);

CREATE UNIQUE INDEX "procurement_delay_one_pending_per_clock"
    ON "ProcurementDelayReason"("clockId")
    WHERE "status" = 'PENDING';

ALTER TABLE "ProcurementDelayReason"
    ADD CONSTRAINT "ProcurementDelayReason_clockId_fkey"
    FOREIGN KEY ("clockId") REFERENCES "ProcurementClock"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProcurementDelayReason"
    ADD CONSTRAINT "ProcurementDelayReason_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProcurementDelayReason"
    ADD CONSTRAINT "ProcurementDelayReason_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
--  Backfill: one clock per order that already exists
-- -----------------------------------------------------------------------------
--  THE DEADLINE is exact for every order. It is a function of orderDate alone:
--  the last instant of the IST day two days after it. The arithmetic below is
--  the SQL form of what procurement.calc.ts computes — shift into IST wall-clock
--  time, truncate to the day, take its final millisecond, shift back — so the
--  two agree to the millisecond rather than approximately.
--
--  THE COMPLETION RESULT is not always knowable, and this migration refuses to
--  pretend otherwise. Three cases:
--
--    a) not fully covered, or the order is CANCELLED
--         -> completedAt NULL. A cancelled order is never reported as a
--            procurement success: coverage is trivially zero once every line is
--            called off, and calling that "fulfilled" would be false.
--
--    b) fully covered, and every covering unit came from an allocation
--         -> completedAt = the latest allocation's createdAt. A RECORDED FACT:
--            that is the moment the last unit was committed to this order.
--            completionEstimated stays false.
--
--    c) fully covered, but some coverage came from alreadyFulfilled, which
--       carries no timestamp of its own
--         -> completedAt = the order's updatedAt, the best evidence that exists,
--            and completionEstimated is set TRUE. The flag lives in the row
--            rather than only in this comment, so the API and the UI can label
--            the result "estimated" and nobody reads a guess as a fact.
--
--  The verdict follows from whichever completedAt was established, compared
--  against the same deadline — the identical rule reconcileClock applies from
--  now on, so historical rows and new ones are decided the same way.
-- -----------------------------------------------------------------------------
WITH line_state AS (
    SELECT
        i."orderId",
        GREATEST(
            0,
            (i."quantity" - i."cancelledQty")
                - i."alreadyFulfilled"
                - COALESCE((SELECT sum(a."quantity")
                            FROM "PurchaseAllocation" a
                            WHERE a."salesOrderItemId" = i."id"), 0)
        ) AS outstanding,
        i."alreadyFulfilled" AS hand_supplied
    FROM "SalesOrderItem" i
    WHERE i."status" = 'ACTIVE'
),
order_state AS (
    SELECT
        o."id"        AS order_id,
        o."status"    AS order_status,
        o."updatedAt" AS updated_at,
        date_trunc('day', (o."orderDate" + INTERVAL '2 days') + INTERVAL '330 minutes')
            - INTERVAL '330 minutes' + INTERVAL '1 day' - INTERVAL '1 millisecond'
            AS deadline,
        COALESCE((SELECT sum(l.outstanding)   FROM line_state l WHERE l."orderId" = o."id"), NULL) AS outstanding,
        COALESCE((SELECT sum(l.hand_supplied) FROM line_state l WHERE l."orderId" = o."id"), 0)    AS hand_supplied,
        (SELECT max(a."createdAt")
           FROM "PurchaseAllocation" a
           JOIN "SalesOrderItem" ai ON ai."id" = a."salesOrderItemId"
          WHERE ai."orderId" = o."id") AS last_allocated_at
    FROM "SalesOrder" o
),
resolved AS (
    SELECT
        s.*,
        CASE
            WHEN s.order_status = 'CANCELLED' THEN NULL
            WHEN s.outstanding IS NULL OR s.outstanding > 0 THEN NULL
            WHEN s.hand_supplied = 0 AND s.last_allocated_at IS NOT NULL THEN s.last_allocated_at
            ELSE s.updated_at
        END AS completed_at,
        CASE
            WHEN s.order_status = 'CANCELLED' THEN false
            WHEN s.outstanding IS NULL OR s.outstanding > 0 THEN false
            WHEN s.hand_supplied = 0 AND s.last_allocated_at IS NOT NULL THEN false
            ELSE true
        END AS estimated
    FROM order_state s
)
INSERT INTO "ProcurementClock"
    ("id", "orderId", "deadline", "completedAt", "verdict", "completionEstimated", "createdAt", "updatedAt")
SELECT
    'c' || substr(md5(random()::text || r.order_id), 1, 24),
    r.order_id,
    r.deadline,
    r.completed_at,
    CASE
        WHEN r.completed_at IS NULL THEN NULL
        WHEN r.completed_at <= r.deadline THEN 'ON_TIME'::"ProcurementVerdict"
        ELSE 'DELAYED'::"ProcurementVerdict"
    END,
    r.estimated,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM resolved r;
