-- =============================================================================
--  Date change requests, part 2 of 2: the invariants.
--
--  Two existing CHECK constraints are dropped and immediately recreated, widened
--  to admit the DATE case. A CHECK holds no data — dropping one removes a rule,
--  never a row — and every existing request is ADD/EDIT/REMOVE, so all of them
--  satisfy the replacements unchanged. No table, column or row is dropped.
-- =============================================================================

-- Was: type = 'ADD' OR "itemId" IS NOT NULL
-- A DATE request concerns the order, not a line, so it carries no item either.
ALTER TABLE "SalesItemChangeRequest"
  DROP CONSTRAINT "sales_change_edit_remove_have_item";
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_edit_remove_have_item"
    CHECK ("type" IN ('ADD', 'DATE') OR "itemId" IS NOT NULL);

-- Was: type = 'REMOVE' OR (productName, quantity, price all NOT NULL)
-- DATE proposes dates, not product values.
ALTER TABLE "SalesItemChangeRequest"
  DROP CONSTRAINT "sales_change_add_edit_have_values";
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_add_edit_have_values"
    CHECK ("type" IN ('REMOVE', 'DATE')
           OR ("productName" IS NOT NULL AND "quantity" IS NOT NULL AND "price" IS NOT NULL));

-- A DATE request has to actually propose something, and only a DATE request may.
ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_date_proposes_a_date"
    CHECK ("type" <> 'DATE'
           OR "proposedOrderDate" IS NOT NULL
           OR "proposedToBeDispatchedBy" IS NOT NULL);

ALTER TABLE "SalesItemChangeRequest"
  ADD CONSTRAINT "sales_change_only_date_proposes_dates"
    CHECK ("type" = 'DATE'
           OR ("proposedOrderDate" IS NULL AND "proposedToBeDispatchedBy" IS NULL));

-- One open date request per order. The existing per-item index keys on itemId,
-- which is null here, so it cannot cover this case.
CREATE UNIQUE INDEX "sales_change_one_pending_date_per_order"
  ON "SalesItemChangeRequest" ("orderId")
  WHERE "status" = 'PENDING' AND "type" = 'DATE';
