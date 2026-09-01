-- =============================================================================
--  Date change requests, part 1 of 2: the vocabulary.
--
--  Split from part 2 because Postgres refuses to reference a newly added enum
--  value inside the transaction that adds it, and the CHECK constraints in
--  part 2 name 'DATE'.
--
--  Purely additive: one enum value and two nullable columns. Nothing is dropped
--  and no existing row is touched.
-- =============================================================================

-- AlterEnum
ALTER TYPE "SalesChangeType" ADD VALUE 'DATE';

-- AlterTable
ALTER TABLE "SalesItemChangeRequest" ADD COLUMN     "proposedOrderDate" TIMESTAMP(3),
ADD COLUMN     "proposedToBeDispatchedBy" TIMESTAMP(3);

