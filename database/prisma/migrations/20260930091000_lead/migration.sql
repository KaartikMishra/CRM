-- =============================================================================
--  Create Lead / Deal — Phase 1.
--
--  Two new enums and one new table. Strictly additive: no existing table is
--  altered, no existing column changes type, nothing is backfilled and no row
--  is read, written or removed.
--
--  WHAT THIS DOES NOT DO, deliberately:
--
--    * It does not touch "Customer". A lead points at the existing master by
--      foreign key; there is no second customer table and no copied column.
--    * It adds NO unique constraint on "Customer"."phone". Phone is intended to
--      be a unique business identifier, but the live data contains duplicates
--      from dummy and historical rows, so a unique index would fail on
--      creation. Phase 1 matches on the digits and handles several results;
--      making the column unique is a data-cleanup decision for the business,
--      not something a feature migration should force.
--    * It writes no permission rows. LEAD_DEAL access comes from ROLE_DEFAULTS
--      for an administrator and from an explicit override for anyone else, the
--      same as every other module.
--    * It adds no status, owner, follow-up, product or pipeline column. Those
--      rules are not specified yet, and a speculative column is a thing the
--      business has to work around later.
--
--  RequirementType is NOT CustomerType, though the words overlap. CustomerType
--  says who somebody is on the master; this says what one enquiry is for, and
--  the same retail customer can raise a corporate gifting lead.
--
--  "channel" is a plain TEXT validated by the shared z.enum rather than a
--  Postgres enum, following Dispatch's channel and carrier: a commercial list
--  that changes should not charge an ALTER TYPE for every revision. Storefronts
--  are added and retired far more often than the six lead sources are.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

CREATE TYPE "LeadSource" AS ENUM ('CALL', 'WHATSAPP', 'EMAIL', 'ABANDONED_CART', 'SOCIAL_MEDIA', 'OTHER');

CREATE TYPE "RequirementType" AS ENUM ('RETAIL', 'WHOLESALE', 'EXPORT_RETAIL', 'EXPORT_WHOLESALE', 'CORPORATE_GIFTING', 'PERSONAL_GIFTING');

CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "leadSource" "LeadSource" NOT NULL,
    "leadSourceOther" TEXT,
    "sourceDetails" TEXT,
    "sourceAt" TIMESTAMP(3) NOT NULL,
    "requirementType" "RequirementType" NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channelOther" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- One customer's leads, newest first, and the module's own list. Two indexes
-- because Phase 1 has exactly two reads; nothing speculative is indexed.
CREATE INDEX "Lead_customerId_createdAt_idx" ON "Lead"("customerId", "createdAt");
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt");

-- Restrict, not Cascade. A customer carrying leads is referenced history, and
-- deleting one should fail loudly rather than silently take the leads with it.
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- "OTHER" plus a written name is one answer, not two — stated here as well as
-- in the shared schema so a row written by any future caller obeys it.
ALTER TABLE "Lead"
  ADD CONSTRAINT "lead_source_other_pairing"
  CHECK (
    ("leadSource" = 'OTHER' AND "leadSourceOther" IS NOT NULL AND btrim("leadSourceOther") <> '')
    OR ("leadSource" <> 'OTHER' AND "leadSourceOther" IS NULL)
  );

ALTER TABLE "Lead"
  ADD CONSTRAINT "lead_channel_other_pairing"
  CHECK (
    ("channel" = 'OTHER' AND "channelOther" IS NOT NULL AND btrim("channelOther") <> '')
    OR ("channel" <> 'OTHER' AND "channelOther" IS NULL)
  );
