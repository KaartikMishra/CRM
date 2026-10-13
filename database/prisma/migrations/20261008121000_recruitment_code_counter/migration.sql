-- =============================================================================
--  HR Phase 3 — the recruitment reference counter.
--
--  A separate migration rather than an edit to 20261008120000, because that one is
--  already applied and recorded. History is forward-only here: amending an applied
--  migration would make every other environment's checksum disagree.
--
--  One table. The same mechanism as PostSalesCaseCounter and EmployeeIdCounter:
--  INSERT ... ON CONFLICT DO UPDATE ... RETURNING inside the creating transaction,
--  which holds the row lock until commit. Never COUNT(*) + 1, which two concurrent
--  creates both read as the same number — and a requisition code is quoted in
--  correspondence, so two roles sharing one is a real confusion rather than a
--  cosmetic one.
-- =============================================================================

CREATE TABLE "RecruitmentCodeCounter" (
    "scope" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentCodeCounter_pkey" PRIMARY KEY ("scope")
);

-- A counter cannot run backwards. Cheap, and it turns a wrong UPDATE into a
-- failure rather than a silently reissued reference.
ALTER TABLE "RecruitmentCodeCounter"
  ADD CONSTRAINT "recruitment_counter_non_negative" CHECK ("lastValue" >= 0);
