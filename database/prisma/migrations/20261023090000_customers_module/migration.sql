-- All Customers — the CUSTOMERS permission namespace.
--
-- A migration of its own, carrying one statement, for the reason RS_PRODUCTS,
-- LEAD_DEAL and the inventory-alert notification types each needed theirs:
-- PostgreSQL cannot use a newly added enum value in the same transaction that
-- adds it. The value lands here; the first row that could reference it is
-- written by a later migration or by the application.
--
-- `IF NOT EXISTS` so a partially applied addition is re-runnable rather than
-- fatal, matching the established pattern in this directory.
--
-- Purely additive: no table, column, constraint or row is altered. A value
-- cannot be removed from a PostgreSQL enum, so this statement is the one part
-- of the All Customers work that is not reversible by dropping something — the
-- same is already true of LEAD_DEAL and HR_TRAINING.

ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'CUSTOMERS';
