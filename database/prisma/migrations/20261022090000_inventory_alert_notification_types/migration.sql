-- Inventory Alerts — two notification types.
--
-- A separate migration from the tables, deliberately: PostgreSQL cannot use a
-- newly added enum value in the same transaction that adds it, so the value and
-- its first use must live in different migrations. The same split was made for
-- the HR Phases 3, 4, 5 and 6 notification values, for the same reason.
--
-- `IF NOT EXISTS` so a partially applied addition is re-runnable rather than
-- fatal, matching the established pattern.
--
-- **No inventory notice ever carries a cost price.** A notice lands in a bell
-- that more colleagues can read than may read what stock cost, so these
-- messages carry the product, the SKU, the stock figure and the threshold —
-- and nothing about money. See the comment in `shared/src/enums.ts`.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INVENTORY_LOW_STOCK';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'INVENTORY_STOCK_RECOVERED';
