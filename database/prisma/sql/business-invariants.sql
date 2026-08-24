-- =============================================================================
--  Business invariants that Prisma cannot express.
--
--  Copy this file's contents into the migration created by:
--      npm run db:migrate -- --create-only --name business_invariants
--  then apply it with:
--      npm run db:migrate
--
--  These turn the rules in §62 from application conventions into database
--  guarantees. Application code checks them too — for good error messages —
--  but the database is what makes them impossible to violate under concurrency.
-- =============================================================================

-- §11 / §62.1 — at most twenty products per enquiry.
-- Combined with @@unique([enquiryId, lineNo]), two concurrent add-product
-- requests physically cannot produce a 21st row.
ALTER TABLE "EnquiryProduct"
  ADD CONSTRAINT "line_no_within_20"
    CHECK ("lineNo" BETWEEN 1 AND 20);

-- §18 — quantity must be a real quantity.
ALTER TABLE "EnquiryProduct"
  ADD CONSTRAINT "quantity_positive"
    CHECK ("quantity" > 0);

-- Q3 — a line may only be closed without a vendor if the reason is recorded.
ALTER TABLE "EnquiryProduct"
  ADD CONSTRAINT "no_vendor_has_reason"
    CHECK ("status" <> 'NO_VENDOR' OR "noVendorReason" IS NOT NULL);

-- A weight is meaningless without its unit, and vice versa.
ALTER TABLE "EnquiryProduct"
  ADD CONSTRAINT "weight_value_and_unit_together"
    CHECK (("weightValue" IS NULL) = ("weightUnit" IS NULL));

-- §35 — rates are never negative.
ALTER TABLE "VendorResponse"
  ADD CONSTRAINT "rate_non_negative"
    CHECK ("ratePerUnit" >= 0);

-- §36 — a delivery promise of zero days is not a promise.
ALTER TABLE "VendorResponse"
  ADD CONSTRAINT "delivery_positive"
    CHECK ("deliveryWithinDays" > 0);

ALTER TABLE "VendorResponse"
  ADD CONSTRAINT "vendor_weight_value_and_unit_together"
    CHECK (("weightValue" IS NULL) = ("weightUnit" IS NULL));

-- §24 — the deadline always follows creation.
ALTER TABLE "ProductEnquiry"
  ADD CONSTRAINT "deadline_after_creation"
    CHECK ("slaDeadlineAt" > "createdAt");

-- §17 — "Others" is only meaningful with the actual source written down.
ALTER TABLE "ProductEnquiry"
  ADD CONSTRAINT "other_source_specified"
    CHECK ("source" <> 'OTHERS' OR "sourceDetail" IS NOT NULL);

-- §41 — a closed enquiry always records when it closed and who closed it.
ALTER TABLE "ProductEnquiry"
  ADD CONSTRAINT "closed_has_closer"
    CHECK ("status" <> 'CLOSED'
           OR ("closedAt" IS NOT NULL AND "closedById" IS NOT NULL));

-- Q2 / §29 — the clock stop and its verdict are written together or not at all.
ALTER TABLE "ProductEnquiry"
  ADD CONSTRAINT "efficiency_accompanies_first_submit"
    CHECK (("firstSubmitAt" IS NULL) = ("efficiency" IS NULL));

-- §62.2 — an SLA of zero minutes would make every enquiry instantly breached.
ALTER TABLE "ProductEnquiry"
  ADD CONSTRAINT "sla_minutes_positive"
    CHECK ("slaMinutes" > 0);

-- §43 — a delay record without a reason defeats its own purpose.
ALTER TABLE "DelayRecord"
  ADD CONSTRAINT "delay_reason_not_blank"
    CHECK (length(btrim("reason")) >= 5);
