-- =============================================================================
--  HR Phase 5 — Performance Management
-- =============================================================================
--
--  Thirteen tables, eleven enums, forward-only and purely additive. Nothing
--  existing is altered, dropped or renamed.
--
--  WHAT WAS DELIBERATELY EXCLUDED FROM THIS MIGRATION
--
--  `prisma migrate diff` wanted to emit six further statements — three DROPs and
--  the three re-creates that pair with them:
--
--    ALTER TABLE "PurchaseBill"              DROP CONSTRAINT "PurchaseBill_reviewedById_fkey";
--    ALTER TABLE "PurchaseItemProductChange" DROP CONSTRAINT "PurchaseItemProductChange_reviewedById_fkey";
--    ALTER TABLE "SalesOrder"                DROP CONSTRAINT "SalesOrder_cancelledById_fkey";
--    ALTER TABLE "SalesOrder"                ADD CONSTRAINT ... ON DELETE SET NULL;
--    ALTER TABLE "PurchaseBill"              ADD CONSTRAINT ... ON DELETE SET NULL;
--    ALTER TABLE "PurchaseItemProductChange" ADD CONSTRAINT ... ON DELETE SET NULL;
--
--  All six were stripped by hand, and they have nothing to do with Phase 5.
--
--  The three ADDs are the dangerous half and are easy to miss: stripping only the
--  DROPs would leave statements that re-create each constraint as ON DELETE SET
--  NULL, which is precisely the conversion this exclusion exists to prevent. Both
--  halves have to go together.
--  They are the recorded Sales/Procurement drift: the live database holds those
--  three foreign keys as ON DELETE RESTRICT, which is correct and deliberate —
--  an order must not lose the record of who cancelled it — while the Prisma
--  schema describes them differently. Every HR migration since Phase 3 has had
--  to strip the same three statements, and this is the fourth time.
--
--  Letting them through would drop a live RESTRICT and silently allow a User to
--  be deleted out from under a cancelled order. Their delete rules were verified
--  as 'r' in pg_constraint immediately before this migration was written and
--  again immediately after it was applied.
--
--  Resolving the drift properly means correcting the Prisma schema to match the
--  database, which is a Sales/Procurement change and out of scope here.
--
--  THE INVARIANTS BELOW, AND WHY EACH IS A CHECK RATHER THAN A SERVICE RULE
--
--  A CHECK is right when the rule is a property of one row and must hold no
--  matter which code path wrote it. Everything that needs to compare rows — is
--  this person their own manager, has this reviewer already rated this
--  competency, is the actor the subject of the review — cannot be expressed
--  row-locally and lives in `performance-access.ts` and the services instead,
--  where it can be unit-tested.
--
--  The separation-of-duties rules are the clearest case of that split:
--  `performance_review_finalized_has_approver` makes a finalized review with no
--  named approver impossible here, and the service separately refuses an approver
--  who is the review's own subject. The database cannot answer the second
--  question; it can and does answer the first.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ReviewCycleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReviewCycleCadence" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL', 'AD_HOC');

-- CreateEnum
CREATE TYPE "PerformanceReviewStatus" AS ENUM ('NOT_STARTED', 'SELF_ASSESSMENT', 'PENDING_MANAGER', 'MANAGER_REVIEW', 'PENDING_APPROVAL', 'FINALIZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GoalScope" AS ENUM ('EMPLOYEE', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ACHIEVED', 'PARTIALLY_MET', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KpiMetricKind" AS ENUM ('NUMBER', 'PERCENTAGE', 'CURRENCY', 'DURATION', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "KpiDirection" AS ENUM ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER');

-- CreateEnum
CREATE TYPE "CompetencyCategory" AS ENUM ('CORE', 'FUNCTIONAL', 'LEADERSHIP', 'BEHAVIOURAL');

-- CreateEnum
CREATE TYPE "RatingSource" AS ENUM ('SELF', 'MANAGER', 'HR');

-- CreateEnum
CREATE TYPE "DevelopmentPlanStatus" AS ENUM ('OPEN', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "DevelopmentPlanKind" AS ENUM ('IMPROVEMENT', 'GROWTH');

-- CreateTable
CREATE TABLE "ReviewCycle" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cadence" "ReviewCycleCadence" NOT NULL DEFAULT 'ANNUAL',
    "status" "ReviewCycleStatus" NOT NULL DEFAULT 'DRAFT',
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "selfAssessmentDueOn" DATE,
    "managerReviewDueOn" DATE,
    "targetDepartmentId" TEXT,
    "goalAchievementThreshold" DECIMAL(6,2) NOT NULL DEFAULT 100.00,
    "goalPartialThreshold" DECIMAL(6,2) NOT NULL DEFAULT 50.00,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "closureReason" TEXT,

    CONSTRAINT "ReviewCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetencyDefinition" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "CompetencyCategory" NOT NULL DEFAULT 'CORE',
    "description" TEXT,
    "weight" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetencyDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceGoal" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "successCriteria" TEXT,
    "scope" "GoalScope" NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT',
    "employeeId" TEXT,
    "departmentId" TEXT,
    "cycleId" TEXT,
    "startOn" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "weight" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
    "attainment" DECIMAL(8,2),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closureNote" TEXT,

    CONSTRAINT "PerformanceGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceKpi" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metricKind" "KpiMetricKind" NOT NULL,
    "direction" "KpiDirection" NOT NULL DEFAULT 'HIGHER_IS_BETTER',
    "targetValue" DECIMAL(14,2) NOT NULL,
    "baselineValue" DECIMAL(14,2),
    "currentValue" DECIMAL(14,2),
    "unitLabel" TEXT,
    "weight" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
    "attainment" DECIMAL(8,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "lastUpdatedById" TEXT,
    "lastUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerformanceKpi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiProgressRecord" (
    "id" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiProgressRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReview" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "status" "PerformanceReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "selfOverallRating" DECIMAL(4,2),
    "managerOverallRating" DECIMAL(4,2),
    "finalRating" DECIMAL(4,2),
    "goalAttainment" DECIMAL(8,2),
    "selfSubmittedAt" TIMESTAMP(3),
    "managerSubmittedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalComments" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerformanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfAssessment" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "achievements" TEXT,
    "challenges" TEXT,
    "developmentWishes" TEXT,
    "overallRating" DECIMAL(4,2),
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerAssessment" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "strengths" TEXT,
    "improvementAreas" TEXT,
    "comments" TEXT,
    "overallRating" DECIMAL(4,2),
    "promotionRecommended" BOOLEAN,
    "submittedAt" TIMESTAMP(3),
    "submittedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetencyRating" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "competencyId" TEXT NOT NULL,
    "source" "RatingSource" NOT NULL,
    "rating" INTEGER NOT NULL,
    "comments" TEXT,
    "ratedById" TEXT NOT NULL,
    "ratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetencyRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewGoalLink" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "attainmentAtFinalisation" DECIMAL(8,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewGoalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentPlan" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "DevelopmentPlanKind" NOT NULL,
    "status" "DevelopmentPlanStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "objective" TEXT,
    "supportOffered" TEXT,
    "reviewOn" DATE,
    "reviewId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "outcomeNote" TEXT,

    CONSTRAINT "DevelopmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentAction" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dueOn" DATE,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevelopmentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceCodeCounter" (
    "scope" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerformanceCodeCounter_pkey" PRIMARY KEY ("scope")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCycle_code_key" ON "ReviewCycle"("code");

-- CreateIndex
CREATE INDEX "ReviewCycle_status_periodStart_idx" ON "ReviewCycle"("status", "periodStart");

-- CreateIndex
CREATE INDEX "ReviewCycle_targetDepartmentId_status_idx" ON "ReviewCycle"("targetDepartmentId", "status");

-- CreateIndex
CREATE INDEX "CompetencyDefinition_cycleId_sortOrder_idx" ON "CompetencyDefinition"("cycleId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CompetencyDefinition_cycleId_name_key" ON "CompetencyDefinition"("cycleId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceGoal_code_key" ON "PerformanceGoal"("code");

-- CreateIndex
CREATE INDEX "PerformanceGoal_employeeId_status_idx" ON "PerformanceGoal"("employeeId", "status");

-- CreateIndex
CREATE INDEX "PerformanceGoal_departmentId_status_idx" ON "PerformanceGoal"("departmentId", "status");

-- CreateIndex
CREATE INDEX "PerformanceGoal_cycleId_status_idx" ON "PerformanceGoal"("cycleId", "status");

-- CreateIndex
CREATE INDEX "PerformanceGoal_status_dueOn_idx" ON "PerformanceGoal"("status", "dueOn");

-- CreateIndex
CREATE INDEX "PerformanceKpi_goalId_sortOrder_idx" ON "PerformanceKpi"("goalId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceKpi_goalId_name_key" ON "PerformanceKpi"("goalId", "name");

-- CreateIndex
CREATE INDEX "KpiProgressRecord_kpiId_recordedAt_idx" ON "KpiProgressRecord"("kpiId", "recordedAt");

-- CreateIndex
CREATE INDEX "PerformanceReview_reviewerId_status_idx" ON "PerformanceReview"("reviewerId", "status");

-- CreateIndex
CREATE INDEX "PerformanceReview_employeeId_status_idx" ON "PerformanceReview"("employeeId", "status");

-- CreateIndex
CREATE INDEX "PerformanceReview_cycleId_status_idx" ON "PerformanceReview"("cycleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceReview_cycleId_employeeId_key" ON "PerformanceReview"("cycleId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SelfAssessment_reviewId_key" ON "SelfAssessment"("reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerAssessment_reviewId_key" ON "ManagerAssessment"("reviewId");

-- CreateIndex
CREATE INDEX "CompetencyRating_reviewId_idx" ON "CompetencyRating"("reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetencyRating_reviewId_competencyId_source_key" ON "CompetencyRating"("reviewId", "competencyId", "source");

-- CreateIndex
CREATE INDEX "ReviewGoalLink_goalId_idx" ON "ReviewGoalLink"("goalId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewGoalLink_reviewId_goalId_key" ON "ReviewGoalLink"("reviewId", "goalId");

-- CreateIndex
CREATE INDEX "DevelopmentPlan_employeeId_status_idx" ON "DevelopmentPlan"("employeeId", "status");

-- CreateIndex
CREATE INDEX "DevelopmentPlan_status_reviewOn_idx" ON "DevelopmentPlan"("status", "reviewOn");

-- CreateIndex
CREATE INDEX "DevelopmentPlan_reviewId_idx" ON "DevelopmentPlan"("reviewId");

-- CreateIndex
CREATE INDEX "DevelopmentAction_planId_sortOrder_idx" ON "DevelopmentAction"("planId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ReviewCycle" ADD CONSTRAINT "ReviewCycle_targetDepartmentId_fkey" FOREIGN KEY ("targetDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewCycle" ADD CONSTRAINT "ReviewCycle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetencyDefinition" ADD CONSTRAINT "CompetencyDefinition_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ReviewCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceGoal" ADD CONSTRAINT "PerformanceGoal_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceGoal" ADD CONSTRAINT "PerformanceGoal_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceGoal" ADD CONSTRAINT "PerformanceGoal_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ReviewCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceGoal" ADD CONSTRAINT "PerformanceGoal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceGoal" ADD CONSTRAINT "PerformanceGoal_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceKpi" ADD CONSTRAINT "PerformanceKpi_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "PerformanceGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceKpi" ADD CONSTRAINT "PerformanceKpi_lastUpdatedById_fkey" FOREIGN KEY ("lastUpdatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiProgressRecord" ADD CONSTRAINT "KpiProgressRecord_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "PerformanceKpi"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiProgressRecord" ADD CONSTRAINT "KpiProgressRecord_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ReviewCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfAssessment" ADD CONSTRAINT "SelfAssessment_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerAssessment" ADD CONSTRAINT "ManagerAssessment_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerAssessment" ADD CONSTRAINT "ManagerAssessment_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetencyRating" ADD CONSTRAINT "CompetencyRating_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetencyRating" ADD CONSTRAINT "CompetencyRating_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "CompetencyDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetencyRating" ADD CONSTRAINT "CompetencyRating_ratedById_fkey" FOREIGN KEY ("ratedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewGoalLink" ADD CONSTRAINT "ReviewGoalLink_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewGoalLink" ADD CONSTRAINT "ReviewGoalLink_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "PerformanceGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentPlan" ADD CONSTRAINT "DevelopmentPlan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentPlan" ADD CONSTRAINT "DevelopmentPlan_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentPlan" ADD CONSTRAINT "DevelopmentPlan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentPlan" ADD CONSTRAINT "DevelopmentPlan_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentAction" ADD CONSTRAINT "DevelopmentAction_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DevelopmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentAction" ADD CONSTRAINT "DevelopmentAction_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
--  BUSINESS INVARIANTS
-- =============================================================================

-- --- ReviewCycle -------------------------------------------------------------

ALTER TABLE "ReviewCycle"
  ADD CONSTRAINT "review_cycle_code_uppercase" CHECK ("code" = upper("code"));

-- A period that ends before it starts is not a period. The schema and the Zod
-- contract both check this; the CHECK is what makes it true of every row however
-- it was written.
ALTER TABLE "ReviewCycle"
  ADD CONSTRAINT "review_cycle_period_ordered" CHECK ("periodEnd" >= "periodStart");

-- Thresholds in (0, 1000]. Above 100 is legitimate — a stretch cycle may define
-- "achieved" as 110% of target — which is why the ceiling is not 100.
ALTER TABLE "ReviewCycle"
  ADD CONSTRAINT "review_cycle_achievement_threshold_range" CHECK (
    "goalAchievementThreshold" > 0 AND "goalAchievementThreshold" <= 1000
  );

ALTER TABLE "ReviewCycle"
  ADD CONSTRAINT "review_cycle_partial_threshold_range" CHECK (
    "goalPartialThreshold" > 0 AND "goalPartialThreshold" <= 1000
  );

-- Partial cannot sit above achievement, or the band between them is empty and
-- PARTIALLY_MET becomes unreachable.
ALTER TABLE "ReviewCycle"
  ADD CONSTRAINT "review_cycle_thresholds_ordered" CHECK (
    "goalPartialThreshold" <= "goalAchievementThreshold"
  );

-- A cycle that is ACTIVE or beyond was opened by somebody at some point. Without
-- this, a row could claim to be live with no record of when it became so.
ALTER TABLE "ReviewCycle"
  ADD CONSTRAINT "review_cycle_activated_stamp" CHECK (
    "status" = 'DRAFT' OR "activatedAt" IS NOT NULL
  );

ALTER TABLE "ReviewCycle"
  ADD CONSTRAINT "review_cycle_closed_stamp" CHECK (
    "status" NOT IN ('CLOSED', 'ARCHIVED') OR "closedAt" IS NOT NULL
  );

ALTER TABLE "ReviewCycle"
  ADD CONSTRAINT "review_cycle_archived_stamp" CHECK (
    "status" <> 'ARCHIVED' OR "archivedAt" IS NOT NULL
  );

-- --- CompetencyDefinition ----------------------------------------------------

ALTER TABLE "CompetencyDefinition"
  ADD CONSTRAINT "competency_weight_range" CHECK ("weight" > 0 AND "weight" <= 100);

ALTER TABLE "CompetencyDefinition"
  ADD CONSTRAINT "competency_sort_non_negative" CHECK ("sortOrder" >= 0);

-- --- PerformanceGoal ---------------------------------------------------------

ALTER TABLE "PerformanceGoal"
  ADD CONSTRAINT "goal_code_uppercase" CHECK ("code" = upper("code"));

-- The ownership invariant this schema is shaped around. Exactly one owner: a goal
-- with neither belongs to nobody and nobody is accountable for it; a goal with
-- both is ambiguous about which. The scope column must agree with whichever is
-- set, so the two can never disagree about what kind of goal this is.
ALTER TABLE "PerformanceGoal"
  ADD CONSTRAINT "goal_exactly_one_owner" CHECK (
    ("scope" = 'EMPLOYEE' AND "employeeId" IS NOT NULL AND "departmentId" IS NULL)
    OR
    ("scope" = 'DEPARTMENT' AND "departmentId" IS NOT NULL AND "employeeId" IS NULL)
  );

ALTER TABLE "PerformanceGoal"
  ADD CONSTRAINT "goal_dates_ordered" CHECK ("dueOn" >= "startOn");

ALTER TABLE "PerformanceGoal"
  ADD CONSTRAINT "goal_weight_range" CHECK ("weight" > 0 AND "weight" <= 100);

-- Attainment is uncapped above: 140% of target is a fact worth keeping, and
-- clamping it would erase exactly what an appraisal exists to surface. Bounded
-- below at zero because a negative attainment has no meaning — a KPI moving the
-- wrong way attains zero, it does not attain minus thirty.
ALTER TABLE "PerformanceGoal"
  ADD CONSTRAINT "goal_attainment_non_negative" CHECK (
    "attainment" IS NULL OR "attainment" >= 0
  );

-- A closed goal names who closed it and when; an open one claims neither. All
-- three together or none, so a row cannot say it was closed by nobody.
ALTER TABLE "PerformanceGoal"
  ADD CONSTRAINT "goal_closure_complete" CHECK (
    (
      "status" IN ('ACHIEVED', 'PARTIALLY_MET', 'MISSED', 'CANCELLED')
      AND "closedById" IS NOT NULL
      AND "closedAt" IS NOT NULL
    )
    OR
    (
      "status" IN ('DRAFT', 'ACTIVE')
      AND "closedById" IS NULL
      AND "closedAt" IS NULL
    )
  );

-- --- PerformanceKpi ----------------------------------------------------------

ALTER TABLE "PerformanceKpi"
  ADD CONSTRAINT "kpi_weight_range" CHECK ("weight" > 0 AND "weight" <= 100);

ALTER TABLE "PerformanceKpi"
  ADD CONSTRAINT "kpi_attainment_non_negative" CHECK (
    "attainment" IS NULL OR "attainment" >= 0
  );

ALTER TABLE "PerformanceKpi"
  ADD CONSTRAINT "kpi_sort_non_negative" CHECK ("sortOrder" >= 0);

-- A BOOLEAN KPI is done or not: its target is 1 and nothing else makes sense.
-- Enforced here because a BOOLEAN KPI with a target of 7 would compute an
-- attainment of 14% for something that was actually completed.
ALTER TABLE "PerformanceKpi"
  ADD CONSTRAINT "kpi_boolean_target_is_one" CHECK (
    "metricKind" <> 'BOOLEAN' OR "targetValue" = 1
  );

-- A BOOLEAN KPI's recorded value is 0 or 1, for the same reason.
ALTER TABLE "PerformanceKpi"
  ADD CONSTRAINT "kpi_boolean_value_binary" CHECK (
    "metricKind" <> 'BOOLEAN' OR "currentValue" IS NULL OR "currentValue" IN (0, 1)
  );

-- A target of zero cannot be attained as a proportion — every value divides into
-- it undefined — so the arithmetic has no answer. A goal of "zero defects" is
-- expressed as a LOWER_IS_BETTER KPI with a small target, not a zero one.
ALTER TABLE "PerformanceKpi"
  ADD CONSTRAINT "kpi_target_not_zero" CHECK ("targetValue" <> 0);

-- The author stamp pairs: a KPI that records who last moved it records when.
ALTER TABLE "PerformanceKpi"
  ADD CONSTRAINT "kpi_update_stamp_paired" CHECK (
    ("lastUpdatedById" IS NULL AND "lastUpdatedAt" IS NULL)
    OR ("lastUpdatedById" IS NOT NULL AND "lastUpdatedAt" IS NOT NULL)
  );

-- --- PerformanceReview ------------------------------------------------------

-- Every rating on the company's 1–5 scale, matching Phase 3's interview feedback
-- and probation reviews. Two HR scales differing by a point would make the two
-- incomparable for no benefit.
ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_self_rating_range" CHECK (
    "selfOverallRating" IS NULL
    OR ("selfOverallRating" >= 1 AND "selfOverallRating" <= 5)
  );

ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_manager_rating_range" CHECK (
    "managerOverallRating" IS NULL
    OR ("managerOverallRating" >= 1 AND "managerOverallRating" <= 5)
  );

ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_final_rating_range" CHECK (
    "finalRating" IS NULL OR ("finalRating" >= 1 AND "finalRating" <= 5)
  );

ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_goal_attainment_non_negative" CHECK (
    "goalAttainment" IS NULL OR "goalAttainment" >= 0
  );

-- THE SEPARATION-OF-DUTIES INVARIANT, in the half a CHECK can express.
--
-- A finalized review names its approver and the moment it was locked. The service
-- separately refuses an approver who is the review's own subject — that comparison
-- needs another row and cannot live here. Between them: a finalized appraisal
-- always has an accountable approver, and that approver is never the person
-- appraised.
ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_finalized_has_approver" CHECK (
    "status" <> 'FINALIZED'
    OR ("finalizedById" IS NOT NULL AND "finalizedAt" IS NOT NULL)
  );

-- And the converse: a review that is not finalized has not been approved by
-- anybody. Without this, a row could carry an approver while still sitting in
-- SELF_ASSESSMENT, which would read as approved on any screen showing the stamp.
ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_approver_only_when_finalized" CHECK (
    "status" = 'FINALIZED'
    OR ("finalizedById" IS NULL AND "finalizedAt" IS NULL)
  );

-- A cancelled review says why. "Cancelled" with no reason is the quiet way to
-- make an appraisal disappear — the same rule Phase 3 applied to a skipped
-- onboarding task.
ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_cancellation_complete" CHECK (
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL)
    OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL)
  );

-- A review past the self-assessment stage has a submitted self-assessment, and one
-- past the manager stage has a submitted manager review. This is the state machine
-- made true of the row rather than merely of the code path that wrote it.
ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_self_submitted_stamp" CHECK (
    "status" NOT IN ('PENDING_MANAGER', 'MANAGER_REVIEW', 'PENDING_APPROVAL', 'FINALIZED')
    OR "selfSubmittedAt" IS NOT NULL
  );

ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_manager_submitted_stamp" CHECK (
    "status" NOT IN ('PENDING_APPROVAL', 'FINALIZED')
    OR "managerSubmittedAt" IS NOT NULL
  );

-- Nobody reviews themselves. The one separation-of-duties rule that IS row-local,
-- because both columns are on this table — so it is enforced here as well as in
-- the service, and a reviewer cannot be set to the subject by any code path.
ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "performance_review_reviewer_not_subject" CHECK (
    "reviewerId" IS NULL OR "reviewerId" <> "employeeId"
  );

-- --- SelfAssessment and ManagerAssessment -----------------------------------

ALTER TABLE "SelfAssessment"
  ADD CONSTRAINT "self_assessment_rating_range" CHECK (
    "overallRating" IS NULL OR ("overallRating" >= 1 AND "overallRating" <= 5)
  );

ALTER TABLE "ManagerAssessment"
  ADD CONSTRAINT "manager_assessment_rating_range" CHECK (
    "overallRating" IS NULL OR ("overallRating" >= 1 AND "overallRating" <= 5)
  );

-- A submitted manager assessment records which account submitted it. HR may
-- legitimately write a review for an employee whose manager has left, and the
-- record should say who actually wrote it rather than implying the stored
-- reviewer did.
ALTER TABLE "ManagerAssessment"
  ADD CONSTRAINT "manager_assessment_submitter_paired" CHECK (
    ("submittedAt" IS NULL AND "submittedById" IS NULL)
    OR ("submittedAt" IS NOT NULL AND "submittedById" IS NOT NULL)
  );

-- --- CompetencyRating -------------------------------------------------------

ALTER TABLE "CompetencyRating"
  ADD CONSTRAINT "competency_rating_range" CHECK ("rating" >= 1 AND "rating" <= 5);

-- --- ReviewGoalLink ---------------------------------------------------------

ALTER TABLE "ReviewGoalLink"
  ADD CONSTRAINT "review_goal_attainment_non_negative" CHECK (
    "attainmentAtFinalisation" IS NULL OR "attainmentAtFinalisation" >= 0
  );

-- --- DevelopmentPlan --------------------------------------------------------

-- A formal improvement plan with no review date is not a plan, it is a complaint
-- on file. GROWTH plans may legitimately have no date.
ALTER TABLE "DevelopmentPlan"
  ADD CONSTRAINT "development_plan_improvement_has_review_date" CHECK (
    "kind" <> 'IMPROVEMENT' OR "reviewOn" IS NOT NULL
  );

ALTER TABLE "DevelopmentPlan"
  ADD CONSTRAINT "development_plan_closure_complete" CHECK (
    ("status" IN ('COMPLETED', 'ABANDONED') AND "closedById" IS NOT NULL AND "closedAt" IS NOT NULL)
    OR ("status" = 'OPEN' AND "closedById" IS NULL AND "closedAt" IS NULL)
  );

-- --- DevelopmentAction ------------------------------------------------------

ALTER TABLE "DevelopmentAction"
  ADD CONSTRAINT "development_action_sort_non_negative" CHECK ("sortOrder" >= 0);

-- A completed action records when and by whom; an open one claims neither.
ALTER TABLE "DevelopmentAction"
  ADD CONSTRAINT "development_action_completion_complete" CHECK (
    ("isCompleted" = true AND "completedAt" IS NOT NULL AND "completedById" IS NOT NULL)
    OR ("isCompleted" = false AND "completedAt" IS NULL AND "completedById" IS NULL)
  );

-- --- PerformanceCodeCounter -------------------------------------------------

ALTER TABLE "PerformanceCodeCounter"
  ADD CONSTRAINT "performance_counter_non_negative" CHECK ("lastValue" >= 0);
