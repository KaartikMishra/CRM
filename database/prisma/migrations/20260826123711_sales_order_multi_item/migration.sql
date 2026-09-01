-- =============================================================================
--  A sales order becomes a set of product lines.
--
--  Order of operations matters and is deliberate: every existing order's product
--  is copied into a line, the copy is proven complete, and only then are the old
--  columns dropped. Prisma runs each migration in a transaction, so if any step
--  fails the whole thing rolls back and the table is left exactly as it was.
--
--  ---------------------------------------------------------------------------
--  Why the CHECK constraints have to go
--  ---------------------------------------------------------------------------
--  sales_quantity_positive, sales_price_positive, sales_paid_within_total and
--  sales_closed_fully_paid are all written against "quantity" and "price" on
--  SalesOrder. Those columns are moving to SalesOrderItem, so the constraints
--  cannot survive in that form.
--
--  The first two move to the item table unchanged. The other two cannot: a row
--  local CHECK cannot sum a child table. Postgres's tool for a cross-row
--  invariant is a constraint trigger, which is what replaces them below.
--
--  ---------------------------------------------------------------------------
--  Why the triggers are DEFERRABLE INITIALLY DEFERRED
--  ---------------------------------------------------------------------------
--  An order is inserted before its lines exist. Checked immediately, an order
--  created with a payment already recorded would fail against a total of zero.
--  Deferring to COMMIT means the rule is evaluated once the whole order is in
--  place, which is the only moment at which it is meaningful.
--
--  ---------------------------------------------------------------------------
--  Existing data
--  ---------------------------------------------------------------------------
--  Constraint triggers fire on INSERT, UPDATE and DELETE from creation onward.
--  They never validate rows already stored, so the historical order that closed
--  with a balance outstanding (rsm002) stays exactly as recorded — the same
--  guarantee the NOT VALID constraint gave it in the previous migration.
-- =============================================================================

-- CreateEnum
CREATE TYPE "SalesItemStatus" AS ENUM ('ACTIVE', 'PENDING_APPROVAL');

-- CreateTable
CREATE TABLE "SalesOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "productImageId" TEXT,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "status" "SalesItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "proposedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderItem_orderId_lineNo_key" ON "SalesOrderItem"("orderId", "lineNo");

-- CreateIndex
CREATE INDEX "SalesOrderItem_orderId_status_idx" ON "SalesOrderItem"("orderId", "status");

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_productImageId_fkey" FOREIGN KEY ("productImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
--  Carry every existing order's product across as its first line.
--
--  The line is ACTIVE and credited to whoever created the order, which keeps
--  each order's total exactly what it was before this migration ran.
-- -----------------------------------------------------------------------------
--  The id is shaped like a cuid on purpose: 'c' followed by 24 hex characters.
--  The API validates every item id as a cuid before it will look one up, so a
--  bare hash here would leave migrated lines unreachable by their own endpoints.
--
--  approvedBy is left null. These lines were never proposed and never approved —
--  they are the original order — and recording a creator as their approver would
--  invent an approval that did not happen.
INSERT INTO "SalesOrderItem" (
    "id", "orderId", "lineNo", "productName", "productImageId",
    "quantity", "price", "status", "proposedById", "approvedById", "approvedAt",
    "createdAt", "updatedAt"
)
SELECT
    'c' || substr(md5(random()::text || clock_timestamp()::text || "id"), 1, 24),
    "id",
    1,
    "productName",
    "productImageId",
    "quantity",
    "price",
    'ACTIVE',
    "createdById",
    NULL,
    NULL,
    "createdAt",
    "updatedAt"
FROM "SalesOrder";

-- -----------------------------------------------------------------------------
--  Prove the copy is complete before anything is dropped.
--
--  If a single order failed to produce a line, this aborts and the transaction
--  rolls back with the old columns still intact and populated.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  order_count  BIGINT;
  item_count   BIGINT;
  total_before NUMERIC;
  total_after  NUMERIC;
BEGIN
  SELECT count(*) INTO order_count FROM "SalesOrder";
  SELECT count(*) INTO item_count  FROM "SalesOrderItem";

  IF order_count <> item_count THEN
    RAISE EXCEPTION
      'Sales migration aborted: % orders produced % lines. No data has been changed.',
      order_count, item_count;
  END IF;

  SELECT COALESCE(sum("quantity" * "price"), 0) INTO total_before FROM "SalesOrder";
  SELECT COALESCE(sum("quantity" * "price"), 0) INTO total_after  FROM "SalesOrderItem";

  IF total_before <> total_after THEN
    RAISE EXCEPTION
      'Sales migration aborted: order value % does not match line value %. No data has been changed.',
      total_before, total_after;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
--  Now, and only now, retire the per-product columns and the constraints that
--  depended on them.
-- -----------------------------------------------------------------------------
ALTER TABLE "SalesOrder" DROP CONSTRAINT "sales_quantity_positive";
ALTER TABLE "SalesOrder" DROP CONSTRAINT "sales_price_positive";
ALTER TABLE "SalesOrder" DROP CONSTRAINT "sales_paid_within_total";
ALTER TABLE "SalesOrder" DROP CONSTRAINT "sales_closed_fully_paid";

ALTER TABLE "SalesOrder" DROP CONSTRAINT "SalesOrder_productImageId_fkey";

ALTER TABLE "SalesOrder" DROP COLUMN "productName";
ALTER TABLE "SalesOrder" DROP COLUMN "productImageId";
ALTER TABLE "SalesOrder" DROP COLUMN "quantity";
ALTER TABLE "SalesOrder" DROP COLUMN "price";

-- -----------------------------------------------------------------------------
--  Per-line invariants, carried over unchanged.
-- -----------------------------------------------------------------------------
ALTER TABLE "SalesOrderItem"
  ADD CONSTRAINT "sales_item_quantity_positive"
    CHECK ("quantity" > 0);

ALTER TABLE "SalesOrderItem"
  ADD CONSTRAINT "sales_item_price_positive"
    CHECK ("price" > 0);

-- An approval is recorded with both its approver and its moment, or not at all.
--
-- Deliberately not "every ACTIVE line has an approver": lines created with the
-- order were never proposed, so they have no approval to record. approvedBy
-- therefore means exactly one thing — who accepted a proposal — rather than
-- doubling as a generic "who made this line count".
ALTER TABLE "SalesOrderItem"
  ADD CONSTRAINT "sales_item_approval_recorded_together"
    CHECK (("approvedById" IS NULL) = ("approvedAt" IS NULL));

-- A line awaiting approval cannot already carry one.
ALTER TABLE "SalesOrderItem"
  ADD CONSTRAINT "sales_item_pending_has_no_approval"
    CHECK ("status" <> 'PENDING_APPROVAL' OR "approvedById" IS NULL);

-- -----------------------------------------------------------------------------
--  Cross-row money rules, as a deferred constraint trigger.
--
--  Two invariants the application also enforces, kept here so that no code path
--  and no concurrent interleaving can produce an order that is overpaid or
--  closed with a balance outstanding.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sales_order_money_guard() RETURNS TRIGGER AS $$
DECLARE
  target_id    TEXT;
  paid         NUMERIC(14,2);
  order_status "SalesOrderStatus";
  active_total NUMERIC(14,2);
BEGIN
  IF TG_TABLE_NAME = 'SalesOrder' THEN
    target_id := NEW."id";
  ELSE
    target_id := COALESCE(NEW."orderId", OLD."orderId");
  END IF;

  SELECT "paidAmount", "status" INTO paid, order_status
  FROM "SalesOrder" WHERE "id" = target_id;

  -- The order itself was deleted in this transaction; its lines went with it.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum("quantity" * "price"), 0)
  INTO active_total
  FROM "SalesOrderItem"
  WHERE "orderId" = target_id AND "status" = 'ACTIVE';

  -- Named to match the application's error vocabulary, so the API can translate
  -- a raced violation into the same message the service would have produced.
  IF paid > active_total THEN
    RAISE EXCEPTION
      'sales_paid_within_total: paid %, active line total %', paid, active_total
      USING ERRCODE = 'check_violation';
  END IF;

  IF order_status = 'CLOSED' AND paid <> active_total THEN
    RAISE EXCEPTION
      'sales_closed_fully_paid: paid %, active line total %', paid, active_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "sales_order_money_guard_on_order"
  AFTER INSERT OR UPDATE ON "SalesOrder"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sales_order_money_guard();

CREATE CONSTRAINT TRIGGER "sales_order_money_guard_on_item"
  AFTER INSERT OR UPDATE OR DELETE ON "SalesOrderItem"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sales_order_money_guard();
