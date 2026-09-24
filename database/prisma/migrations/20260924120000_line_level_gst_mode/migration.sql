-- =============================================================================
--  GST mode moves from the order to the line.
--
--  The previous migration put a single gstMode on SalesOrder, which forced one
--  reading onto every price on the document. Real orders do not work that way:
--  a product quoted at 5% plus tax sits beside one quoted at 18% all-in, and
--  they are still one order. The setting belongs to the line that carries the
--  price it describes.
--
--  ORDER OF OPERATIONS, and every step of it matters:
--
--    1. Add SalesOrderItem."gstMode", defaulted so the column can be NOT NULL.
--    2. BACKFILL every existing line from its own order's setting. This is the
--       step that preserves history: each line is read exactly as it was read
--       before this migration, so no existing order's payable moves by a paisa.
--    3. Replace the money guard so it reads the mode per line.
--    4. SET CONSTRAINTS ALL IMMEDIATE, to flush the deferred trigger events
--       queued by step 2 BEFORE the DDL in step 5. Postgres refuses to alter a
--       table that has pending trigger events, and firing them here re-checks
--       every touched order against the NEW function — which is the outcome to
--       want. If an order could not satisfy it, this migration rolls back and
--       says so rather than leaving the books inconsistent.
--    5. Drop SalesOrder."gstMode", now that nothing reads it.
--
--  Step 5 is the only destructive statement, and it is safe because step 2 has
--  already copied every value it held onto the lines it applied to. Nothing is
--  deleted: no order, no line, no charge, no payment.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  1. The new line-level column
--
--  NOT NULL with a default, unlike gstRate beside it: there is no honest "not
--  recorded" answer here, because no total can be worked out at all until a
--  price is read one way or the other.
-- -----------------------------------------------------------------------------
ALTER TABLE "SalesOrderItem" ADD COLUMN "gstMode" TEXT NOT NULL DEFAULT 'EXCLUSIVE';

-- -----------------------------------------------------------------------------
--  2. Backfill from the order each line belongs to
--
--  Every line inherits the reading it was actually created under. A line on an
--  order marked INCLUSIVE keeps being read as inclusive; one on an EXCLUSIVE
--  order keeps being read as exclusive. The arithmetic is therefore unchanged
--  for every row that already exists, which is what makes this safe to run
--  against live sales.
-- -----------------------------------------------------------------------------
UPDATE "SalesOrderItem" AS i
SET "gstMode" = o."gstMode"
FROM "SalesOrder" AS o
WHERE i."orderId" = o."id";

-- -----------------------------------------------------------------------------
--  3. The money guard, reading the mode per line
--
--  Only the tax subquery changes. It now takes each line's own "gstMode"
--  instead of the order's, which means a single order can mix the two and
--  still be checked correctly.
--
--  The arithmetic continues to mirror computeLineTax in
--  @rs/shared/utils/sales-total.ts to the paise, rounding half-up at two
--  decimals, once, per line:
--
--    EXCLUSIVE   tax  = ROUND(lineValue * rate / 100, 2)
--    INCLUSIVE   base = ROUND(lineValue * 100 / (100 + rate), 2)
--                tax  = lineValue - base    (the remainder, never rounded
--                                            again, so base + tax is exact)
--
--  A line read INCLUSIVE contributes its gross to the payable and nothing more,
--  because the tax is already inside that gross. A line read EXCLUSIVE
--  contributes its gross plus the tax. Summing those two contributions is the
--  whole of the change below.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sales_order_money_guard() RETURNS TRIGGER AS $func$
DECLARE
  target_id    TEXT;
  paid         NUMERIC(14,2);
  order_status "SalesOrderStatus";
  goods        NUMERIC(14,2);
  charges      NUMERIC(14,2);
  discount     NUMERIC(14,2);
  payable      NUMERIC(14,2);
BEGIN
  IF TG_TABLE_NAME = 'SalesOrder' THEN
    target_id := NEW."id";
  ELSE
    target_id := COALESCE(NEW."orderId", OLD."orderId");
  END IF;

  SELECT "paidAmount", "status"
  INTO paid, order_status
  FROM "SalesOrder" WHERE "id" = target_id;

  -- The order itself was deleted in this transaction; its lines went with it.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Each line's own contribution to the payable, read its own way.
  -- 'NONE' and '0' both contribute the bare goods and are never cast: the
  -- guard ahead of them means ::numeric only ever sees one of the slabs.
  SELECT COALESCE(sum(
    CASE
      WHEN i."gstRate" IS NULL OR i."gstRate" IN ('NONE', '0') THEN
        i."quantity" * i."price"
      WHEN i."gstMode" = 'INCLUSIVE' THEN
        -- The tax is already inside the price.
        i."quantity" * i."price"
      ELSE
        (i."quantity" * i."price")
          + ROUND((i."quantity" * i."price") * i."gstRate"::numeric / 100, 2)
    END
  ), 0)
  INTO goods
  FROM "SalesOrderItem" i
  WHERE i."orderId" = target_id AND i."status" = 'ACTIVE';

  SELECT
    COALESCE(sum(CASE WHEN "type" = 'DISCOUNT' THEN 0 ELSE "amount" END), 0),
    COALESCE(sum(CASE WHEN "type" = 'DISCOUNT' THEN "amount" ELSE 0 END), 0)
  INTO charges, discount
  FROM "SalesOrderCharge"
  WHERE "orderId" = target_id;

  payable := goods + charges - discount;

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

-- -----------------------------------------------------------------------------
--  4. Flush the deferred events queued by the backfill
--
--  Without this, step 5 fails with "cannot ALTER TABLE ... because it has
--  pending trigger events". Firing them now also re-validates every order the
--  backfill touched, against the function installed above.
-- -----------------------------------------------------------------------------
SET CONSTRAINTS ALL IMMEDIATE;

-- -----------------------------------------------------------------------------
--  5. Retire the order-level column
--
--  Safe only because step 2 copied every value it held onto the lines it
--  applied to. Nothing reads it after step 3.
-- -----------------------------------------------------------------------------
ALTER TABLE "SalesOrder" DROP COLUMN "gstMode";
