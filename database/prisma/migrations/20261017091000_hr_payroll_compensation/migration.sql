-- HR Phase 6 — Payroll & Compensation
--
-- Additive only. Ten new tables, eight new enums, no existing table altered and
-- no column dropped. Verified before writing: zero DROP TABLE, TRUNCATE,
-- DELETE FROM or DROP COLUMN statements appear below.
--
-- ===========================================================================
--  SIX DRIFT STATEMENTS WERE STRIPPED BY HAND FROM THIS MIGRATION
-- ===========================================================================
--
-- `prisma migrate diff` emitted six statements unrelated to payroll, which would
-- have converted three live Sales/Procurement foreign keys from ON DELETE
-- RESTRICT to ON DELETE SET NULL:
--
--    ALTER TABLE "PurchaseBill"              DROP CONSTRAINT "PurchaseBill_reviewedById_fkey";
--    ALTER TABLE "PurchaseItemProductChange" DROP CONSTRAINT "PurchaseItemProductChange_reviewedById_fkey";
--    ALTER TABLE "SalesOrder"                DROP CONSTRAINT "SalesOrder_cancelledById_fkey";
--    ALTER TABLE "SalesOrder"                ADD CONSTRAINT  ... ON DELETE SET NULL ...;
--    ALTER TABLE "PurchaseBill"              ADD CONSTRAINT  ... ON DELETE SET NULL ...;
--    ALTER TABLE "PurchaseItemProductChange" ADD CONSTRAINT  ... ON DELETE SET NULL ...;
--
-- This is long-standing drift between schema.prisma and the live database: the
-- database holds RESTRICT (confdeltype = 'r', verified by querying pg_constraint
-- immediately before this migration was written), and the Prisma models say
-- SetNull. The same six statements appeared in the Phase 5 migration and were
-- stripped there for the same reason.
--
-- **BOTH halves had to be removed, not just the DROPs.** Removing only the three
-- DROP CONSTRAINT lines would leave three ADD CONSTRAINT lines that convert all
-- three keys to SET NULL — the precise opposite of preserving them. The stripped
-- file was then grepped for any surviving non-comment reference to those three
-- tables; there are none.
--
-- Reconciling that drift is a separate change with its own review. It is not
-- payroll's to make, and making it silently inside a payroll migration would
-- weaken referential guarantees on shipped Sales and Procurement data.
--
-- ===========================================================================
--  WHAT THIS MIGRATION DELIBERATELY DOES NOT CONTAIN
-- ===========================================================================
--
-- No statutory rate, threshold, slab, overtime multiplier or rounding policy
-- appears as a column default or a CHECK. Provident fund, insurance and tax are
-- configured `SalaryComponent` rows, and the applicable figures are HRSetting
-- values. A rate written into a migration is a legal claim this codebase cannot
-- substantiate and cannot correct without another migration.
--
-- See `backend/src/modules/hr/PAYROLL-SCOPE.md` for what that means for
-- compliance, and for the list of policies the module reports as NOT APPLIED
-- when nothing is configured.

-- CreateEnum
CREATE TYPE "SalaryComponentKind" AS ENUM ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION');

-- CreateEnum
CREATE TYPE "SalaryCalculationKind" AS ENUM ('FIXED', 'PERCENT_OF_BASE', 'PERCENT_OF_GROSS', 'FORMULA_BALANCE');

-- CreateEnum
CREATE TYPE "DailyRateBasis" AS ENUM ('CALENDAR_DAYS', 'WORKING_DAYS', 'FIXED_THIRTY');

-- CreateEnum
CREATE TYPE "MonetaryRoundingMode" AS ENUM ('HALF_UP', 'HALF_EVEN', 'DOWN');

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'APPROVED', 'FINALIZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollItemStatus" AS ENUM ('PENDING', 'CALCULATED', 'EXCLUDED', 'FINALIZED');

-- CreateEnum
CREATE TYPE "PayrollExclusionReason" AS ENUM ('NOT_ELIGIBLE', 'NO_SALARY_ASSIGNMENT', 'JOINED_AFTER_PERIOD', 'EXITED_BEFORE_PERIOD', 'MANUALLY_EXCLUDED');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentKind" AS ENUM ('ARREAR', 'RECOVERY', 'BONUS', 'REIMBURSEMENT');

-- CreateTable
CREATE TABLE "SalaryComponent" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "SalaryComponentKind" NOT NULL,
    "calculation" "SalaryCalculationKind" NOT NULL,
    "rate" DECIMAL(6,2),
    "capAmount" DECIMAL(12,2),
    "floorAmount" DECIMAL(12,2),
    "isBase" BOOLEAN NOT NULL DEFAULT false,
    "prorates" BOOLEAN NOT NULL DEFAULT true,
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 100,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryStructure" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryStructureComponent" (
    "id" TEXT NOT NULL,
    "structureId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "rateOverride" DECIMAL(6,2),
    "displayOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryStructureComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSalary" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "structureId" TEXT,
    "monthlyGross" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSalary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSalaryComponent" (
    "id" TEXT NOT NULL,
    "salaryId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "rateOverride" DECIMAL(6,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeSalaryComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "dailyRateBasis" "DailyRateBasis" NOT NULL DEFAULT 'CALENDAR_DAYS',
    "roundingMode" "MonetaryRoundingMode" NOT NULL DEFAULT 'HALF_UP',
    "calendarDays" INTEGER NOT NULL,
    "workingDays" INTEGER NOT NULL DEFAULT 0,
    "payableDaysDivisor" INTEGER NOT NULL DEFAULT 0,
    "grossEarnings" DECIMAL(14,2),
    "totalDeductions" DECIMAL(14,2),
    "employerContributions" DECIMAL(14,2),
    "netPay" DECIMAL(14,2),
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "calculatedAt" TIMESTAMP(3),
    "calculatedById" TEXT,
    "approvalRequestId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "notes" TEXT,
    "cancellationReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollItem" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "PayrollItemStatus" NOT NULL DEFAULT 'PENDING',
    "exclusionReason" "PayrollExclusionReason",
    "exclusionNote" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "salaryAssignmentId" TEXT,
    "monthlyGross" DECIMAL(12,2),
    "presentDays" DECIMAL(5,2),
    "paidLeaveDays" DECIMAL(5,2),
    "unpaidLeaveDays" DECIMAL(5,2),
    "holidayDays" DECIMAL(5,2),
    "weekOffDays" DECIMAL(5,2),
    "payableDays" DECIMAL(5,2),
    "overtimeMinutes" INTEGER,
    "grossEarnings" DECIMAL(12,2),
    "totalDeductions" DECIMAL(12,2),
    "employerContributions" DECIMAL(12,2),
    "netPay" DECIMAL(12,2),
    "snapshot" JSONB,
    "payslipDocumentId" TEXT,
    "calculatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollItemLine" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "componentCode" TEXT NOT NULL,
    "componentName" TEXT NOT NULL,
    "kind" "SalaryComponentKind" NOT NULL,
    "calculation" "SalaryCalculationKind" NOT NULL,
    "rate" DECIMAL(6,2),
    "fullAmount" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "prorationNote" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollItemLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodId" TEXT,
    "kind" "PayrollAdjustmentKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reason" TEXT NOT NULL,
    "correctsPeriodId" TEXT,
    "reference" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollCodeCounter" (
    "scope" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollCodeCounter_pkey" PRIMARY KEY ("scope")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalaryComponent_code_key" ON "SalaryComponent"("code");

-- CreateIndex
CREATE INDEX "SalaryComponent_kind_isActive_displayOrder_idx" ON "SalaryComponent"("kind", "isActive", "displayOrder");

-- CreateIndex
CREATE INDEX "SalaryComponent_isActive_displayOrder_idx" ON "SalaryComponent"("isActive", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryStructure_code_key" ON "SalaryStructure"("code");

-- CreateIndex
CREATE INDEX "SalaryStructure_isActive_name_idx" ON "SalaryStructure"("isActive", "name");

-- CreateIndex
CREATE INDEX "SalaryStructureComponent_structureId_displayOrder_idx" ON "SalaryStructureComponent"("structureId", "displayOrder");

-- CreateIndex
CREATE INDEX "SalaryStructureComponent_componentId_idx" ON "SalaryStructureComponent"("componentId");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryStructureComponent_structureId_componentId_key" ON "SalaryStructureComponent"("structureId", "componentId");

-- CreateIndex
CREATE INDEX "EmployeeSalary_employeeId_effectiveFrom_idx" ON "EmployeeSalary"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EmployeeSalary_structureId_idx" ON "EmployeeSalary"("structureId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSalary_employeeId_effectiveFrom_key" ON "EmployeeSalary"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EmployeeSalaryComponent_salaryId_idx" ON "EmployeeSalaryComponent"("salaryId");

-- CreateIndex
CREATE INDEX "EmployeeSalaryComponent_componentId_idx" ON "EmployeeSalaryComponent"("componentId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSalaryComponent_salaryId_componentId_key" ON "EmployeeSalaryComponent"("salaryId", "componentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_code_key" ON "PayrollPeriod"("code");

-- CreateIndex
CREATE INDEX "PayrollPeriod_status_year_month_idx" ON "PayrollPeriod"("status", "year", "month");

-- CreateIndex
CREATE INDEX "PayrollPeriod_periodStart_periodEnd_idx" ON "PayrollPeriod"("periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_year_month_key" ON "PayrollPeriod"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollItem_payslipDocumentId_key" ON "PayrollItem"("payslipDocumentId");

-- CreateIndex
CREATE INDEX "PayrollItem_periodId_status_idx" ON "PayrollItem"("periodId", "status");

-- CreateIndex
CREATE INDEX "PayrollItem_employeeId_createdAt_idx" ON "PayrollItem"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "PayrollItem_salaryAssignmentId_idx" ON "PayrollItem"("salaryAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollItem_periodId_employeeId_key" ON "PayrollItem"("periodId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollItemLine_itemId_displayOrder_idx" ON "PayrollItemLine"("itemId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollItemLine_itemId_componentCode_key" ON "PayrollItemLine"("itemId", "componentCode");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_employeeId_createdAt_idx" ON "PayrollAdjustment"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_periodId_idx" ON "PayrollAdjustment"("periodId");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_correctsPeriodId_idx" ON "PayrollAdjustment"("correctsPeriodId");

-- AddForeignKey
ALTER TABLE "SalaryComponent" ADD CONSTRAINT "SalaryComponent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStructure" ADD CONSTRAINT "SalaryStructure_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStructureComponent" ADD CONSTRAINT "SalaryStructureComponent_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "SalaryStructure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStructureComponent" ADD CONSTRAINT "SalaryStructureComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "SalaryComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "SalaryStructure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalaryComponent" ADD CONSTRAINT "EmployeeSalaryComponent_salaryId_fkey" FOREIGN KEY ("salaryId") REFERENCES "EmployeeSalary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalaryComponent" ADD CONSTRAINT "EmployeeSalaryComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "SalaryComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_calculatedById_fkey" FOREIGN KEY ("calculatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_salaryAssignmentId_fkey" FOREIGN KEY ("salaryAssignmentId") REFERENCES "EmployeeSalary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItemLine" ADD CONSTRAINT "PayrollItemLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PayrollItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_correctsPeriodId_fkey" FOREIGN KEY ("correctsPeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
--  CHECK constraints
-- ===========================================================================
--
-- Each of these is a property of ONE ROW that must hold however the row was
-- written. Anything needing to compare rows — is this approver the person being
-- paid, does this structure have exactly one base component — cannot be
-- expressed row-locally and lives in `payroll-access.ts` and the services.
--
-- None of them encodes a statutory rule. They enforce internal coherence: a
-- percentage component that has no percentage, a negative salary, a finalised
-- period with no record of who finalised it.

-- --- Money is never negative where it is entered -------------------------
--
-- Computed net pay CAN legitimately be negative — deductions exceeding earnings
-- is a real condition — so `PayrollItem.netPay` is deliberately NOT constrained.
-- The service detects it and blocks finalisation, which is the correct handling:
-- a CHECK here would make the run fail instead of reporting the problem.

ALTER TABLE "SalaryComponent"
  ADD CONSTRAINT "salary_component_rate_range"
  CHECK ("rate" IS NULL OR ("rate" >= 0 AND "rate" <= 100));

ALTER TABLE "SalaryComponent"
  ADD CONSTRAINT "salary_component_cap_non_negative"
  CHECK ("capAmount" IS NULL OR "capAmount" >= 0);

ALTER TABLE "SalaryComponent"
  ADD CONSTRAINT "salary_component_floor_non_negative"
  CHECK ("floorAmount" IS NULL OR "floorAmount" >= 0);

-- A percentage component needs a percentage, and a fixed one must not carry a
-- rate that will never be read. Both directions, because each is a silently
-- wrong payslip rather than an error.
ALTER TABLE "SalaryComponent"
  ADD CONSTRAINT "salary_component_rate_presence"
  CHECK (
    ("calculation" IN ('PERCENT_OF_BASE', 'PERCENT_OF_GROSS') AND "rate" IS NOT NULL)
    OR ("calculation" IN ('FIXED', 'FORMULA_BALANCE') AND "rate" IS NULL)
  );

-- Only an earning can be the base, and it must be a fixed amount, or a
-- percentage of it is circular.
ALTER TABLE "SalaryComponent"
  ADD CONSTRAINT "salary_component_base_is_fixed_earning"
  CHECK ("isBase" = false OR ("kind" = 'EARNING' AND "calculation" = 'FIXED'));

ALTER TABLE "SalaryStructureComponent"
  ADD CONSTRAINT "structure_component_amount_non_negative"
  CHECK ("amount" IS NULL OR "amount" >= 0);

ALTER TABLE "SalaryStructureComponent"
  ADD CONSTRAINT "structure_component_rate_range"
  CHECK ("rateOverride" IS NULL OR ("rateOverride" >= 0 AND "rateOverride" <= 100));

-- A salary of zero is meaningless and a negative one is a data-entry accident
-- with no correct interpretation.
ALTER TABLE "EmployeeSalary"
  ADD CONSTRAINT "employee_salary_gross_positive"
  CHECK ("monthlyGross" > 0);

-- An assignment cannot stop before it starts.
ALTER TABLE "EmployeeSalary"
  ADD CONSTRAINT "employee_salary_effective_order"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

ALTER TABLE "EmployeeSalaryComponent"
  ADD CONSTRAINT "employee_salary_component_amount_non_negative"
  CHECK ("amount" IS NULL OR "amount" >= 0);

ALTER TABLE "EmployeeSalaryComponent"
  ADD CONSTRAINT "employee_salary_component_rate_range"
  CHECK ("rateOverride" IS NULL OR ("rateOverride" >= 0 AND "rateOverride" <= 100));

-- --- Period coherence ----------------------------------------------------

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_month_range"
  CHECK ("month" >= 1 AND "month" <= 12);

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_year_range"
  CHECK ("year" >= 2000 AND "year" <= 2200);

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_date_order"
  CHECK ("periodEnd" >= "periodStart");

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_calendar_days_sane"
  CHECK ("calendarDays" >= 28 AND "calendarDays" <= 31);

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_working_days_sane"
  CHECK ("workingDays" >= 0 AND "workingDays" <= 31);

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_divisor_non_negative"
  CHECK ("payableDaysDivisor" >= 0 AND "payableDaysDivisor" <= 31);

-- A costed period must record the divisor it used. This is what stops a
-- finalised period from being unable to explain its own arithmetic.
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_divisor_when_costed"
  CHECK (
    "status" IN ('DRAFT', 'CANCELLED')
    OR "payableDaysDivisor" > 0
  );

-- Totals arrive together at calculation, or not at all. A period with a gross
-- but no net is a half-written run that nothing should read.
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_totals_together"
  CHECK (
    ("grossEarnings" IS NULL AND "totalDeductions" IS NULL
      AND "employerContributions" IS NULL AND "netPay" IS NULL)
    OR ("grossEarnings" IS NOT NULL AND "totalDeductions" IS NOT NULL
      AND "employerContributions" IS NOT NULL AND "netPay" IS NOT NULL)
  );

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_totals_non_negative"
  CHECK (
    ("grossEarnings" IS NULL OR "grossEarnings" >= 0)
    AND ("totalDeductions" IS NULL OR "totalDeductions" >= 0)
    AND ("employerContributions" IS NULL OR "employerContributions" >= 0)
  );

-- Who costed it, and when, are one fact.
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_calculation_stamp_consistency"
  CHECK (("calculatedAt" IS NULL) = ("calculatedById" IS NULL));

-- A finalised period must say who finalised it and when. The service
-- additionally refuses a finaliser who is paid by the run — that compares rows
-- and cannot live here.
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_finalized_has_finalizer"
  CHECK (
    "status" <> 'FINALIZED'
    OR ("finalizedAt" IS NOT NULL AND "finalizedById" IS NOT NULL)
  );

-- And the converse: nothing outside FINALIZED carries a finalisation stamp.
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_finalizer_only_when_finalized"
  CHECK (
    "status" = 'FINALIZED'
    OR ("finalizedAt" IS NULL AND "finalizedById" IS NULL)
  );

-- An approved or finalised period records its approval.
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_approved_has_approver"
  CHECK (
    "status" NOT IN ('APPROVED', 'FINALIZED')
    OR ("approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL)
  );

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_approval_stamp_consistency"
  CHECK (("approvedAt" IS NULL) = ("approvedById" IS NULL));

-- A cancelled period says why. "Why is there no March payroll" is a question
-- somebody will ask a year later.
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_cancelled_has_reason"
  CHECK ("status" <> 'CANCELLED' OR "cancellationReason" IS NOT NULL);

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "payroll_period_employee_count_non_negative"
  CHECK ("employeeCount" >= 0);

-- --- Item coherence ------------------------------------------------------

-- An excluded line says why; a non-excluded one does not pretend to.
ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "payroll_item_exclusion_reason_presence"
  CHECK (
    ("status" = 'EXCLUDED' AND "exclusionReason" IS NOT NULL)
    OR ("status" <> 'EXCLUDED' AND "exclusionReason" IS NULL)
  );

-- A calculated or finalised line carries its figures. An excluded or pending one
-- must not, or a total would silently include a line nobody costed.
ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "payroll_item_totals_when_calculated"
  CHECK (
    "status" NOT IN ('CALCULATED', 'FINALIZED')
    OR ("grossEarnings" IS NOT NULL AND "totalDeductions" IS NOT NULL
        AND "employerContributions" IS NOT NULL AND "netPay" IS NOT NULL
        AND "payableDays" IS NOT NULL)
  );

ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "payroll_item_component_totals_non_negative"
  CHECK (
    ("grossEarnings" IS NULL OR "grossEarnings" >= 0)
    AND ("totalDeductions" IS NULL OR "totalDeductions" >= 0)
    AND ("employerContributions" IS NULL OR "employerContributions" >= 0)
  );

ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "payroll_item_day_counts_non_negative"
  CHECK (
    ("presentDays" IS NULL OR "presentDays" >= 0)
    AND ("paidLeaveDays" IS NULL OR "paidLeaveDays" >= 0)
    AND ("unpaidLeaveDays" IS NULL OR "unpaidLeaveDays" >= 0)
    AND ("holidayDays" IS NULL OR "holidayDays" >= 0)
    AND ("weekOffDays" IS NULL OR "weekOffDays" >= 0)
    AND ("payableDays" IS NULL OR "payableDays" >= 0)
  );

ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "payroll_item_overtime_non_negative"
  CHECK ("overtimeMinutes" IS NULL OR "overtimeMinutes" >= 0);

ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "payroll_item_gross_non_negative"
  CHECK ("monthlyGross" IS NULL OR "monthlyGross" > 0);

-- **A finalised line must carry its snapshot.** This is the immutability
-- guarantee at the database level: a finalised figure that cannot explain itself
-- is exactly what the snapshot exists to prevent.
ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "payroll_item_finalized_has_snapshot"
  CHECK ("status" <> 'FINALIZED' OR "snapshot" IS NOT NULL);

-- --- Lines and adjustments ----------------------------------------------

ALTER TABLE "PayrollItemLine"
  ADD CONSTRAINT "payroll_line_amounts_non_negative"
  CHECK ("amount" >= 0 AND "fullAmount" >= 0);

-- Proration reduces a figure; it never increases one. A line whose counted
-- amount exceeds its full amount is an arithmetic bug, and this is where it
-- surfaces rather than on a payslip.
ALTER TABLE "PayrollItemLine"
  ADD CONSTRAINT "payroll_line_amount_within_full"
  CHECK ("amount" <= "fullAmount");

ALTER TABLE "PayrollItemLine"
  ADD CONSTRAINT "payroll_line_rate_range"
  CHECK ("rate" IS NULL OR ("rate" >= 0 AND "rate" <= 100));

-- An adjustment is a positive amount whose `kind` decides its direction, for the
-- same reason a deduction is not a negative earning.
ALTER TABLE "PayrollAdjustment"
  ADD CONSTRAINT "payroll_adjustment_amount_positive"
  CHECK ("amount" > 0);

-- An adjustment cannot correct the period it is paid in: that is an edit to a
-- finalised figure wearing a different name.
ALTER TABLE "PayrollAdjustment"
  ADD CONSTRAINT "payroll_adjustment_not_self_correcting"
  CHECK ("correctsPeriodId" IS NULL OR "correctsPeriodId" <> "periodId");

ALTER TABLE "PayrollCodeCounter"
  ADD CONSTRAINT "payroll_code_counter_non_negative"
  CHECK ("lastValue" >= 0);
