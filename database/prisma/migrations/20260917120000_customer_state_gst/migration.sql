-- =============================================================================
--  Customer State and GST number.
--
--  Purely additive: two nullable columns on an existing table. No default and
--  no backfill — every existing customer reads NULL, which is exactly what
--  "not recorded" already means for `phone`, `email` and `address` beside them.
--
--  `state` is TEXT, not a Postgres enum. The 28 States of India are a fixed
--  reference list owned by @rs/shared (INDIA_STATES) and enforced at the edge
--  by Zod; an enum would buy nothing and cost a great deal later, since a value
--  cannot be dropped from a Postgres enum once added.
--
--  `gstNumber` is TEXT and deliberately NOT unique: the same GSTIN can
--  legitimately sit on more than one customer row. The database enforces no
--  GSTIN checksum and no cross-check between the number's leading state code
--  and `state` — both are stricter than "a well-formed GSTIN", and structure is
--  already checked at the edge.
--
--  No constraint is added or altered. No index is added. No existing column is
--  touched. No DROP, TRUNCATE, DELETE, INSERT or UPDATE. `Customer` keeps every
--  row and relation it had, and no other table is referenced.
-- =============================================================================

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "state" TEXT,
ADD COLUMN     "gstNumber" TEXT;
