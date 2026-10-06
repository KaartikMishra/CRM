-- =============================================================================
--  Post Sales & Grievance — Phase 1, the core case foundation.
--
--  Eight new enums, one counter table and four new tables. Strictly additive:
--  no existing table is altered, no existing column changes type, nothing is
--  backfilled, and no existing row is read, written or removed.
--
--  POST_SALES already exists in the "AppModule" enum, so there is NO ALTER TYPE
--  here — the module's permissions were declared when the enum was first
--  written, and ROLE_DEFAULTS.ADMIN already grants it.
--
--  WHAT THIS DELIBERATELY DOES NOT DO:
--
--    * It copies NO customer, order, product or shipment data onto a case.
--      Every one is a foreign key, so a case cannot disagree with the canonical
--      record. Order totals come through SalesOrder and Sales' own toMoney;
--      product identity through SalesOrderItem to RsProduct.
--    * It creates NO second notification, audit, media, user or inventory
--      system. Notification and AuditLog are already polymorphic through
--      entityType/entityId, and MediaAsset is the one upload store.
--    * It stores NO SLA deadline, breach flag, CSAT score or resolution record.
--      Those are later phases; a column added on a guess is one the business has
--      to work around.
--    * It touches NO stock. "crmStockQty" and "inventoryQty" are not mentioned
--      anywhere below, and Phase 1 is read-only with respect to inventory.
--
--  DELETE BEHAVIOUR, stated once:
--    Case children  CASCADE  — a removed case takes its own rows with it.
--    Sales history  RESTRICT — a case can never delete a Customer, a SalesOrder
--                              or a SalesOrderItem. Removing a customer who has
--                              cases fails loudly rather than erasing them.
--    People / media SET NULL — a departed employee or a retired asset leaves the
--                              record readable rather than deleting it.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

CREATE TYPE "PostSalesCaseType" AS ENUM ('COMPLAINT', 'RETURN', 'REPLACEMENT', 'REFUND', 'EXCHANGE', 'WARRANTY', 'DELIVERY_ISSUE', 'PRODUCT_QUESTION', 'BILLING_ISSUE', 'PAYMENT_ISSUE', 'FEEDBACK', 'SUGGESTION', 'REVIEW_ISSUE', 'OTHER');

CREATE TYPE "PostSalesIssueCategory" AS ENUM ('DAMAGED_PRODUCT', 'MANUFACTURING_DEFECT', 'FINISH_POLISH_ISSUE', 'SIZE_ISSUE', 'WRONG_SIZE', 'WRONG_PRODUCT', 'MISSING_PRODUCT', 'MISSING_PART', 'QUALITY_CONCERN', 'LEAKAGE', 'BREAKAGE', 'DENT', 'SCRATCH', 'COATING_ISSUE', 'COLOUR_DIFFERENCE', 'PRODUCT_PERFORMANCE', 'PRODUCT_USAGE_QUESTION', 'PRODUCT_CARE_QUESTION', 'DELAYED_DELIVERY', 'DELIVERY_FAILED', 'WRONG_ADDRESS', 'COURIER_DAMAGE', 'PACKAGE_DAMAGED', 'PACKAGE_MISSING', 'WRONG_PACKAGE', 'PARTIAL_DELIVERY', 'TRACKING_ISSUE', 'WRONG_ITEM', 'MISSING_ITEM', 'QUANTITY_ISSUE', 'ORDER_MODIFICATION', 'CANCELLATION', 'BILLING_ISSUE', 'INVOICE_ISSUE', 'PAYMENT_ISSUE', 'RETURN_REQUEST', 'REPLACEMENT_REQUEST', 'REFUND_REQUEST', 'EXCHANGE_REQUEST', 'WARRANTY_REQUEST', 'SERVICE_REQUEST', 'DISSATISFACTION', 'NEGATIVE_FEEDBACK', 'SUGGESTION', 'PRODUCT_FEEDBACK', 'SERVICE_FEEDBACK', 'OTHER');

CREATE TYPE "PostSalesPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TYPE "PostSalesCaseStatus" AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'AWAITING_CUSTOMER', 'AWAITING_INTERNAL', 'AWAITING_VENDOR', 'AWAITING_COURIER', 'RESOLUTION_IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED');

CREATE TYPE "PostSalesActivityKind" AS ENUM ('SYSTEM', 'NOTE', 'INTERNAL_NOTE', 'CUSTOMER_COMMUNICATION', 'FOLLOW_UP', 'STATUS_CHANGE', 'ASSIGNMENT_CHANGE');

CREATE TYPE "PostSalesCommunicationChannel" AS ENUM ('PHONE', 'WHATSAPP', 'EMAIL', 'SMS', 'WEBSITE', 'INSTAGRAM', 'FACEBOOK', 'MARKETPLACE', 'IN_PERSON', 'INTERNAL');

CREATE TYPE "PostSalesCommunicationDirection" AS ENUM ('INCOMING', 'OUTGOING');

CREATE TYPE "PostSalesAttachmentKind" AS ENUM ('PRODUCT_PHOTO', 'PACKAGING_PHOTO', 'SCREENSHOT', 'PAYMENT_PROOF', 'DELIVERY_PROOF', 'OTHER');

-- --------------------------------------------------------------------------
--  The case-number counter, exactly as EnquiryCounter serves ENQ-.
--
--  One row per period, bumped by an atomic INSERT ... ON CONFLICT DO UPDATE
--  RETURNING inside the creating transaction. Never COUNT(*) + 1, which two
--  concurrent creates would both read as the same value.
-- --------------------------------------------------------------------------

CREATE TABLE "PostSalesCaseCounter" (
    "period" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PostSalesCaseCounter_pkey" PRIMARY KEY ("period")
);

-- --------------------------------------------------------------------------
--  PostSalesCase — the spine.
-- --------------------------------------------------------------------------

CREATE TABLE "PostSalesCase" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "salesOrderId" TEXT,
    "dispatchId" TEXT,
    "caseType" "PostSalesCaseType" NOT NULL,
    "issueCategory" "PostSalesIssueCategory" NOT NULL,
    "priority" "PostSalesPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "PostSalesCaseStatus" NOT NULL DEFAULT 'NEW',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assignedToId" TEXT,
    "raisedById" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostSalesCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PostSalesCase_caseNumber_key" ON "PostSalesCase"("caseNumber");

-- The board's own queries: the open queue, one person's workload, a customer's
-- history, an order's cases, and the priority view.
CREATE INDEX "PostSalesCase_status_createdAt_idx" ON "PostSalesCase"("status", "createdAt");
CREATE INDEX "PostSalesCase_assignedToId_status_idx" ON "PostSalesCase"("assignedToId", "status");
CREATE INDEX "PostSalesCase_customerId_createdAt_idx" ON "PostSalesCase"("customerId", "createdAt");
CREATE INDEX "PostSalesCase_salesOrderId_idx" ON "PostSalesCase"("salesOrderId");
CREATE INDEX "PostSalesCase_priority_status_idx" ON "PostSalesCase"("priority", "status");
CREATE INDEX "PostSalesCase_createdAt_idx" ON "PostSalesCase"("createdAt");

-- Restrict toward customer, order and raiser: a case is referenced history, and
-- removing the person or order behind it should fail loudly rather than quietly
-- erase the grievance. SetNull on the assignee and the shipment, because a case
-- outlives both.
ALTER TABLE "PostSalesCase" ADD CONSTRAINT "PostSalesCase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PostSalesCase" ADD CONSTRAINT "PostSalesCase_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PostSalesCase" ADD CONSTRAINT "PostSalesCase_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PostSalesCase" ADD CONSTRAINT "PostSalesCase_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PostSalesCase" ADD CONSTRAINT "PostSalesCase_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A resolved case has a resolvedAt and a closed one has a closedAt. Stated here
-- as well as in the service, so a row written by any future caller stays honest
-- about its own timeline.
ALTER TABLE "PostSalesCase"
  ADD CONSTRAINT "post_sales_resolved_stamped"
  CHECK (("status" <> 'RESOLVED' AND "status" <> 'CLOSED') OR "resolvedAt" IS NOT NULL);

ALTER TABLE "PostSalesCase"
  ADD CONSTRAINT "post_sales_closed_stamped"
  CHECK ("status" <> 'CLOSED' OR "closedAt" IS NOT NULL);

-- --------------------------------------------------------------------------
--  PostSalesCaseItem — which order lines are affected.
-- --------------------------------------------------------------------------

CREATE TABLE "PostSalesCaseItem" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "salesOrderItemId" TEXT NOT NULL,
    "affectedQty" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostSalesCaseItem_pkey" PRIMARY KEY ("id")
);

-- One line at most once per case: a second entry for the same line is an edit of
-- the quantity, not another affected line.
CREATE UNIQUE INDEX "PostSalesCaseItem_caseId_salesOrderItemId_key" ON "PostSalesCaseItem"("caseId", "salesOrderItemId");
CREATE INDEX "PostSalesCaseItem_salesOrderItemId_idx" ON "PostSalesCaseItem"("salesOrderItemId");

ALTER TABLE "PostSalesCaseItem" ADD CONSTRAINT "PostSalesCaseItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "PostSalesCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostSalesCaseItem" ADD CONSTRAINT "PostSalesCaseItem_salesOrderItemId_fkey" FOREIGN KEY ("salesOrderItemId") REFERENCES "SalesOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An affected quantity is a positive number of things.
ALTER TABLE "PostSalesCaseItem"
  ADD CONSTRAINT "post_sales_item_qty_positive" CHECK ("affectedQty" > 0);

-- --------------------------------------------------------------------------
--  PostSalesActivity — the timeline.
-- --------------------------------------------------------------------------

CREATE TABLE "PostSalesActivity" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "PostSalesActivityKind" NOT NULL,
    "note" TEXT NOT NULL,
    "channel" "PostSalesCommunicationChannel",
    "direction" "PostSalesCommunicationDirection",
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "performedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostSalesActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PostSalesActivity_caseId_createdAt_idx" ON "PostSalesActivity"("caseId", "createdAt");
CREATE INDEX "PostSalesActivity_caseId_kind_idx" ON "PostSalesActivity"("caseId", "kind");
CREATE INDEX "PostSalesActivity_completedAt_dueAt_idx" ON "PostSalesActivity"("completedAt", "dueAt");

ALTER TABLE "PostSalesActivity" ADD CONSTRAINT "PostSalesActivity_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "PostSalesCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostSalesActivity" ADD CONSTRAINT "PostSalesActivity_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A channel and a direction describe a conversation, so they belong to a
-- CUSTOMER_COMMUNICATION and to nothing else. Both travel together or not at all.
ALTER TABLE "PostSalesActivity"
  ADD CONSTRAINT "post_sales_activity_channel_pairing"
  CHECK (
    ("kind" = 'CUSTOMER_COMMUNICATION' AND "channel" IS NOT NULL AND "direction" IS NOT NULL)
    OR ("kind" <> 'CUSTOMER_COMMUNICATION' AND "channel" IS NULL AND "direction" IS NULL)
  );

-- A follow-up is an action expected at a moment; without one it is a note.
ALTER TABLE "PostSalesActivity"
  ADD CONSTRAINT "post_sales_followup_has_due"
  CHECK ("kind" <> 'FOLLOW_UP' OR "dueAt" IS NOT NULL);

-- NO constraint relating "completedAt" to "dueAt", deliberately — the same
-- decision LeadActivity made. Completing early is the good case, completing late
-- is the case follow-ups exist to surface, and never completing is a null. All
-- three are valid rows.

-- --------------------------------------------------------------------------
--  PostSalesAttachment — the join to MediaAsset.
-- --------------------------------------------------------------------------

CREATE TABLE "PostSalesAttachment" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "mediaAssetId" TEXT,
    "kind" "PostSalesAttachmentKind" NOT NULL DEFAULT 'OTHER',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostSalesAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PostSalesAttachment_caseId_mediaAssetId_key" ON "PostSalesAttachment"("caseId", "mediaAssetId");
CREATE INDEX "PostSalesAttachment_caseId_createdAt_idx" ON "PostSalesAttachment"("caseId", "createdAt");
CREATE INDEX "PostSalesAttachment_mediaAssetId_idx" ON "PostSalesAttachment"("mediaAssetId");

-- SetNull on the asset: a retired image leaves the link readable as history
-- rather than deleting the record of what was attached. Detaching from a case
-- removes this row and never the MediaAsset — several tables may reference one.
ALTER TABLE "PostSalesAttachment" ADD CONSTRAINT "PostSalesAttachment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "PostSalesCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostSalesAttachment" ADD CONSTRAINT "PostSalesAttachment_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PostSalesAttachment" ADD CONSTRAINT "PostSalesAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
