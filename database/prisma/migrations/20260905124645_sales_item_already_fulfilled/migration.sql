-- AlterTable
ALTER TABLE "SalesOrderItem" ADD COLUMN     "alreadyFulfilled" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
--  Fulfilment recorded outside procurement can be neither negative nor more
--  than the customer asked for. Enforced here as well as in the service, the
--  same belt-and-braces approach used for the 20-product cap and received
--  quantities on a purchase bill.
--
--  DEFAULT 0 means every existing row is already valid, so this validates
--  immediately without rewriting anyone's order.
-- ---------------------------------------------------------------------------
ALTER TABLE "SalesOrderItem"
  ADD CONSTRAINT "sales_item_already_fulfilled_non_negative"
  CHECK ("alreadyFulfilled" >= 0);

ALTER TABLE "SalesOrderItem"
  ADD CONSTRAINT "sales_item_already_fulfilled_within_quantity"
  CHECK ("alreadyFulfilled" <= "quantity");
