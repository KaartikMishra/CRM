-- =============================================================================
--  A sales order may only be closed once it is settled in full.
--
--  Additive: one CHECK constraint. No table, column, enum, index or row is
--  created, altered or dropped, and no data is written.
--
--  ---------------------------------------------------------------------------
--  Why NOT VALID
--  ---------------------------------------------------------------------------
--  This rule is being introduced after the module has been in use, and the
--  shared development database already holds an order that breaks it:
--
--      rsm002 — total 5200.00, paid 1000.00, status CLOSED
--
--  That is a real record of something that actually happened, not a fixture.
--  A validating constraint would either refuse to apply or force us to rewrite
--  someone's history to satisfy a rule that did not exist when they acted.
--
--  NOT VALID enforces the rule on every INSERT and every UPDATE from this
--  moment on, while leaving already-stored rows unexamined. New orders cannot
--  close part-paid; the historical one stays exactly as it was recorded.
--
--  Should that row ever be corrected by hand, the constraint can be promoted
--  with:
--      ALTER TABLE "SalesOrder" VALIDATE CONSTRAINT "sales_closed_fully_paid";
--
--  ---------------------------------------------------------------------------
--  Why quantity * price rather than a stored total
--  ---------------------------------------------------------------------------
--  The order total has no column of its own — it is derived, so that there is
--  exactly one definition of it. Expressing the rule against the same product
--  the API computes keeps the database and the service in agreement instead of
--  giving them two totals that can drift.
-- =============================================================================

ALTER TABLE "SalesOrder"
  ADD CONSTRAINT "sales_closed_fully_paid"
    CHECK ("status" <> 'CLOSED' OR "paidAmount" = "quantity" * "price")
    NOT VALID;
