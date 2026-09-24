-- =============================================================================
--  Customer identity fields, order-level GST, and order-level charges.
--
--  Three additive changes and one redefinition:
--
--    1. Customer gains companyName and country.
--    2. SalesOrder gains gstMode.
--    3. SalesOrderCharge is created.
--    4. sales_order_money_guard is REDEFINED.
--
--  Only the fourth deserves care. Until now the guard defined an order's money
--  as sum(quantity * price) over its ACTIVE lines, and GST was explicitly
--  outside it ("Stored and displayed only. Nothing here enters a total").
--  Tax and charges now form part of what the customer owes, so the ceiling on
--  payment and the condition for closing have to move with them -- otherwise a
--  customer paying the amount printed on their own invoice would be refused by
--  the database.
--
--  SAFETY, measured against the live data on 2026-09-24 before writing this:
--    6 sales orders, all OPEN. 0 CLOSED.
--    1 order carries any payment at all.
--    2 of 8 order lines carry a gstRate.
--  No CLOSED order exists, so no row can be caught by the stricter equality
--  rule. Every order backfills to EXCLUSIVE, under which the payable can only
--  grow, so no existing payment can exceed its new ceiling either.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  1. Customer -- who the invoice is made out to, and where they are
-- -----------------------------------------------------------------------------
ALTER TABLE "Customer" ADD COLUMN "companyName" TEXT;
ALTER TABLE "Customer" ADD COLUMN "country"     TEXT;

-- Deliberately NOT backfilled to 'India'. Every existing row was created by
-- somebody who was never shown the field, so their country is unrecorded
-- rather than India, and writing a value they did not give would be inventing
-- data. New customers default to India at the form.

-- -----------------------------------------------------------------------------
--  2. SalesOrder -- how a line's price is to be read
--
--  NOT NULL with a default, unlike gstRate and state: there is no honest
--  "not recorded" answer here, because no total can be worked out at all until
--  a price is read one way or the other.
--
--  Existing rows take EXCLUSIVE, which reads the price already on them as the
--  goods value with tax on top. That matches what somebody was doing when they
--  typed a price and separately chose a slab.
-- -----------------------------------------------------------------------------
ALTER TABLE "SalesOrder" ADD COLUMN "gstMode" TEXT NOT NULL DEFAULT 'EXCLUSIVE';

-- -----------------------------------------------------------------------------
--  3. SalesOrderCharge -- duty, packing, shipping, customization, discount
--
--  amount is always positive; DISCOUNT is what makes a row subtract. A
--  negative amount was the alternative and it makes every later report that
--  sums this table depend on remembering the convention.
-- -----------------------------------------------------------------------------
CREATE TABLE "SalesOrderCharge" (
    "id"        TEXT NOT NULL,
    "orderId"   TEXT NOT NULL,
    "type"      TEXT NOT NULL,
    "label"     TEXT,
    "amount"    DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrderCharge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_charge_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX "SalesOrderCharge_orderId_idx" ON "SalesOrderCharge"("orderId");

ALTER TABLE "SalesOrderCharge"
  ADD CONSTRAINT "SalesOrderCharge_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
--  4. The money guard, redefined around the payable amount
--
--  The arithmetic below mirrors taxOnExclusive / splitInclusive in
--  @rs/shared/utils/money.ts to the paise, and must continue to. Both round
--  half-up at two decimals, once, per line:
--
--    EXCLUSIVE   tax  = ROUND(lineValue * rate / 100, 2)
--    INCLUSIVE   base = ROUND(lineValue * 100 / (100 + rate), 2)
--                tax  = lineValue - base        (the remainder, never rounded
--                                                again, so base + tax is exact)
--
--  Postgres ROUND(numeric, 2) rounds halves away from zero, which for these
--  non-negative figures is the same half-up rule the TypeScript uses. If the
--  two ever disagreed, an order the API reported as fully paid would be
--  rejected here at COMMIT -- which is precisely the failure this comment
--  exists to prevent.
--
--  PREVIOUS DEFINITION, kept for rollback:
--    SELECT COALESCE(sum("quantity" * "price"), 0) INTO active_total
--    FROM "SalesOrderItem" WHERE "orderId" = target_id AND "status" = 'ACTIVE';
--    IF paid > active_total THEN ... ;
--    IF status = 'CLOSED' AND paid <> active_total THEN ...
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sales_order_money_guard() RETURNS TRIGGER AS $func$
DECLARE
  target_id    TEXT;
  paid         NUMERIC(14,2);
  order_status "SalesOrderStatus";
  mode         TEXT;
  goods        NUMERIC(14,2);
  tax          NUMERIC(14,2);
  charges      NUMERIC(14,2);
  discount     NUMERIC(14,2);
  payable      NUMERIC(14,2);
BEGIN
  IF TG_TABLE_NAME = 'SalesOrder' THEN
    target_id := NEW."id";
  ELSE
    target_id := COALESCE(NEW."orderId", OLD."orderId");
  END IF;

  SELECT "paidAmount", "status", "gstMode"
  INTO paid, order_status, mode
  FROM "SalesOrder" WHERE "id" = target_id;

  -- The order itself was deleted in this transaction; its lines went with it.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum("quantity" * "price"), 0)
  INTO goods
  FROM "SalesOrderItem"
  WHERE "orderId" = target_id AND "status" = 'ACTIVE';

  -- 'NONE' and '0' both contribute nothing, and are never cast: the guard
  -- ahead of them means ::numeric only ever sees one of the numeric slabs.
  SELECT COALESCE(sum(
    CASE
      WHEN i."gstRate" IS NULL OR i."gstRate" IN ('NONE', '0') THEN 0
      WHEN mode = 'INCLUSIVE' THEN
        (i."quantity" * i."price")
          - ROUND((i."quantity" * i."price") * 100 / (100 + i."gstRate"::numeric), 2)
      ELSE
        ROUND((i."quantity" * i."price") * i."gstRate"::numeric / 100, 2)
    END
  ), 0)
  INTO tax
  FROM "SalesOrderItem" i
  WHERE i."orderId" = target_id AND i."status" = 'ACTIVE';

  SELECT
    COALESCE(sum(CASE WHEN "type" = 'DISCOUNT' THEN 0 ELSE "amount" END), 0),
    COALESCE(sum(CASE WHEN "type" = 'DISCOUNT' THEN "amount" ELSE 0 END), 0)
  INTO charges, discount
  FROM "SalesOrderCharge"
  WHERE "orderId" = target_id;

  -- Under INCLUSIVE the tax is already inside goods; adding it would charge
  -- the customer twice.
  payable := goods
           + (CASE WHEN mode = 'INCLUSIVE' THEN 0 ELSE tax END)
           + charges
           - discount;

  IF payable < 0 THEN
    RAISE EXCEPTION
      'sales_payable_not_negative: payable %', payable
      USING ERRCODE = 'check_violation';
  END IF;

  -- Named to match the application's error vocabulary, so the API can translate
  -- a raced violation into the same message the service would have produced.
  IF paid > payable THEN
    RAISE EXCEPTION
      'sales_paid_within_total: paid %, payable %', paid, payable
      USING ERRCODE = 'check_violation';
  END IF;

  IF order_status = 'CLOSED' AND paid <> payable THEN
    RAISE EXCEPTION
      'sales_closed_fully_paid: paid %, payable %', paid, payable
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$func$ LANGUAGE plpgsql;

-- A charge changes the payable exactly as a line does, so it needs the same
-- deferred check. The two existing triggers keep working against the new body.
CREATE CONSTRAINT TRIGGER "sales_order_money_guard_on_charge"
  AFTER INSERT OR UPDATE OR DELETE ON "SalesOrderCharge"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sales_order_money_guard();
