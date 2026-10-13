-- =============================================================================
--  Cross-cutting foundation: ApprovalRequest, HRSetting, SecureDocument.
--
--  Three new tables, two new enums, and nothing else. No existing table is
--  altered. No existing column changes type, nullability or default. No row is
--  inserted, updated or deleted anywhere.
--
--  Depends on 20261007090000_hr_permission_vocabulary, which added the enum
--  values this migration references — 'APPROVE' appears as a column default
--  below, and Postgres will not accept a value added by ALTER TYPE inside the
--  transaction that added it.
--
--  ---------------------------------------------------------------------------
--  WHAT EACH TABLE REPLACES
--
--  ApprovalRequest  The approval "engine" was policies/approval.ts in its
--                   entirety: `requiresApproval = actor.role !== 'ADMIN'`. It
--                   could answer "may this person skip approval" and nothing
--                   else — not who approved, not when, not why, not what was
--                   proposed. Four shipped modules route approvals through
--                   bespoke tables of their own (SalesItemChangeRequest,
--                   SalesChargeChangeRequest, PurchaseItemProductChange,
--                   PurchaseDelayReason and ProcurementDelayReason), each
--                   re-implementing requested/decided/status. This table is the
--                   generic form for everything that comes next. **The existing
--                   five are NOT migrated into it and are NOT touched** — they
--                   are load-bearing in shipped modules, and rewriting them is
--                   not what this phase is for.
--
--  HRSetting        Working hours, week-off patterns, leave quotas, probation
--                   lengths and payroll cycles would otherwise be constants in
--                   code, so changing one would mean a deploy.
--
--  SecureDocument   MediaAsset has no access control of any kind, and its stored
--                   `secureUrl` is a Cloudinary delivery URL that anybody holding
--                   the link can fetch with no CRM session at all. Correct for a
--                   product photo; unacceptable for a payslip or an Aadhaar scan.
--
--  ---------------------------------------------------------------------------
--  WHY SecureDocument IS A SECOND TABLE AND NOT A CHANGE TO MediaAsset
--
--  Seven tables reference MediaAsset. Adding access control to it would change
--  the delivery behaviour of product, enquiry, sales, purchase, lead and
--  post-sales images simultaneously — six shipped modules — which is out of
--  scope for this phase and would be a poor trade regardless: those images are
--  public content, and making them private costs latency and signing for no gain.
--
--  This is one storage provider with two access models, NOT a second storage
--  provider. The same Cloudinary account and the same CLOUDINARY_URL credential
--  serve both; these objects are uploaded with `type: authenticated` and reached
--  only through short-lived signed URLs. No new secret, no new dependency, and
--  no change to any existing upload path.
--
--  Note what is absent: there is no `secureUrl` column. A stored URL outlives
--  every access check and cannot be revoked, which is precisely how MediaAsset
--  became publicly fetchable. `publicId` is the only durable identifier here,
--  and URLs are minted per request and expire.
--
--  ---------------------------------------------------------------------------
--  WHY THERE IS NO employeeId
--
--  Employee does not exist until Phase 1, and inventing a placeholder table to
--  hang a foreign key on would create exactly the duplicate identity this phase
--  forbids. Ownership is recorded polymorphically for now — ownerType/ownerId,
--  the same pattern AuditLog, Notification and ApprovalRequest above all use.
--  Phase 1 adds the typed relation additively, against an abstraction that
--  already works and is already tested.
--
--  ---------------------------------------------------------------------------
--  THE CHECK CONSTRAINTS
--
--  Paired with Zod schemas in shared/, as every other invariant in this database
--  is: the application rejects bad input with a useful message, and the database
--  refuses it again so no path — a script, a console, a future endpoint — can
--  write a row that contradicts itself.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

-- --- enums -------------------------------------------------------------------

-- CANCELLED exists so a requester can withdraw. Deleting the row would destroy
-- the evidence that the request was ever made; a withdrawn request is a
-- historical fact like any other decision.
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TYPE "SecureDocumentKind" AS ENUM (
  'IDENTITY_PROOF',
  'ADDRESS_PROOF',
  'EDUCATION_CERTIFICATE',
  'EXPERIENCE_LETTER',
  'OFFER_LETTER',
  'APPOINTMENT_LETTER',
  'CONTRACT',
  'PAYSLIP',
  'TAX_DOCUMENT',
  'BANK_DETAIL',
  'MEDICAL_RECORD',
  'DISCIPLINARY_RECORD',
  'APPRAISAL',
  'RESUME',
  'OTHER'
);

-- --- ApprovalRequest ---------------------------------------------------------

CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "module" "AppModule" NOT NULL,
    "action" "PermissionAction" NOT NULL DEFAULT 'APPROVE',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "payload" JSONB,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- The approver's queue: everything still pending, oldest first.
CREATE INDEX "ApprovalRequest_status_module_requestedAt_idx" ON "ApprovalRequest"("status", "module", "requestedAt");
-- Every request against one thing, which is how a detail page shows history.
CREATE INDEX "ApprovalRequest_entityType_entityId_requestedAt_idx" ON "ApprovalRequest"("entityType", "entityId", "requestedAt");
CREATE INDEX "ApprovalRequest_requestedById_requestedAt_idx" ON "ApprovalRequest"("requestedById", "requestedAt");
CREATE INDEX "ApprovalRequest_decidedById_decidedAt_idx" ON "ApprovalRequest"("decidedById", "decidedAt");

-- Restrict on both sides, matching how every other decision trail in this
-- schema protects its actors: a decision whose decider vanished is unreadable
-- evidence. Users are deactivated rather than deleted in this system, so this
-- costs nothing in practice.
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A decision is all three facts or none of them.
--
-- The failure this prevents is a PENDING row that already names a decider, or an
-- APPROVED row that cannot say who approved it — either of which makes the trail
-- worthless precisely when somebody needs to audit it. CANCELLED is grouped with
-- PENDING: withdrawing a request is not deciding it, so it carries no decider.
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "approval_decision_consistency" CHECK (
  (
    "status" IN ('PENDING', 'CANCELLED')
    AND "decidedById" IS NULL
    AND "decidedAt" IS NULL
  )
  OR (
    "status" IN ('APPROVED', 'REJECTED')
    AND "decidedById" IS NOT NULL
    AND "decidedAt" IS NOT NULL
  )
);

-- A decision cannot predate the request that asked for it.
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "approval_decided_after_requested" CHECK (
  "decidedAt" IS NULL OR "decidedAt" >= "requestedAt"
);

-- Polymorphic keys must actually point somewhere. The database cannot check that
-- the target row exists — that is the price of polymorphism, and the price
-- AuditLog and Notification already pay — but it can refuse an empty string,
-- which is the failure that would otherwise silently match nothing.
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "approval_entity_present" CHECK (
  length(btrim("entityType")) > 0 AND length(btrim("entityId")) > 0
);

-- --- HRSetting ---------------------------------------------------------------

CREATE TABLE "HRSetting" (
    "id" TEXT NOT NULL,
    "module" "AppModule" NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HRSetting_pkey" PRIMARY KEY ("id")
);

-- One row per key per module. This is what makes a setting a setting rather than
-- an append-only log of attempts to set it.
CREATE UNIQUE INDEX "HRSetting_module_key_key" ON "HRSetting"("module", "key");
CREATE INDEX "HRSetting_module_idx" ON "HRSetting"("module");

-- SetNull: a departed administrator's change stays readable as history. The
-- AuditLog carries the full before/after, so losing the name costs the trail
-- nothing it does not already hold.
ALTER TABLE "HRSetting" ADD CONSTRAINT "HRSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A key must be a key. Without this, '' and '   ' are both storable and both
-- unreachable by any reader that trims its input.
ALTER TABLE "HRSetting" ADD CONSTRAINT "hr_setting_key_present" CHECK (
  length(btrim("key")) > 0
);

-- --- SecureDocument ----------------------------------------------------------

CREATE TABLE "SecureDocument" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "deliveryType" TEXT NOT NULL DEFAULT 'authenticated',
    "kind" "SecureDocumentKind" NOT NULL,
    "module" "AppModule" NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "bytes" INTEGER,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecureDocument_pkey" PRIMARY KEY ("id")
);

-- One stored object is one row.
CREATE UNIQUE INDEX "SecureDocument_publicId_key" ON "SecureDocument"("publicId");
CREATE INDEX "SecureDocument_ownerType_ownerId_createdAt_idx" ON "SecureDocument"("ownerType", "ownerId", "createdAt");
CREATE INDEX "SecureDocument_module_kind_idx" ON "SecureDocument"("module", "kind");
CREATE INDEX "SecureDocument_uploadedById_createdAt_idx" ON "SecureDocument"("uploadedById", "createdAt");

-- Restrict: a confidential document whose uploader is unknown is a document
-- nobody can account for.
ALTER TABLE "SecureDocument" ADD CONSTRAINT "SecureDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The constraint that makes this table mean what its name says.
--
-- 'authenticated' and 'private' are Cloudinary's two non-public delivery types.
-- Without this check, a caller that forgot to pass the delivery type — or passed
-- 'upload', Cloudinary's public default — would produce a row that this table
-- promises is confidential and that is in fact world-readable. That is the exact
-- failure mode SecureDocument exists to prevent, so the database refuses it
-- rather than trusting every future caller to remember.
ALTER TABLE "SecureDocument" ADD CONSTRAINT "secure_document_delivery_type" CHECK (
  "deliveryType" IN ('authenticated', 'private')
);

-- Ownership must point somewhere, for the same reason ApprovalRequest's does.
ALTER TABLE "SecureDocument" ADD CONSTRAINT "secure_document_owner_present" CHECK (
  length(btrim("ownerType")) > 0 AND length(btrim("ownerId")) > 0
);

ALTER TABLE "SecureDocument" ADD CONSTRAINT "secure_document_public_id_present" CHECK (
  length(btrim("publicId")) > 0
);

-- A file with a negative size is a bug upstream, not a row.
ALTER TABLE "SecureDocument" ADD CONSTRAINT "secure_document_bytes_positive" CHECK (
  "bytes" IS NULL OR "bytes" > 0
);
