-- =============================================================================
--  HR Phase 3 — Recruitment / ATS, Onboarding & Probation.
--
--  Fifteen new tables, nineteen new enums. No existing table is altered, no
--  existing column changes type, nullability or default, and no row is inserted,
--  updated or deleted. Forward-only and additive, like every migration before it.
--
--  The three foreign keys this migration does NOT touch
--  ---------------------------------------------------------------------------
--  `prisma migrate diff` wanted to drop and re-create
--  PurchaseBill_reviewedById_fkey, PurchaseItemProductChange_reviewedById_fkey
--  and SalesOrder_cancelledById_fkey. That is pre-existing drift — the live
--  constraints are ON DELETE RESTRICT where the schema says SET NULL — in Sales
--  and Procurement, two shipped modules Phase 3 has no business changing. Those
--  six statements were removed deliberately. The drift is reported, not fixed
--  here: correcting it is a Sales/Procurement decision with its own blast radius.
--
--  ---------------------------------------------------------------------------
--  A CANDIDATE IS NOT AN EMPLOYEE
--
--  The decision the whole phase rests on. `Candidate` is somebody the business is
--  considering; `Employee` (Phase 1) is somebody it employs. Separate tables,
--  separate lifecycles, joined only at OnboardingRecord.employeeId — and even
--  then the candidate and application survive as history rather than being
--  transformed into the employee.
--
--  So there is no second employee identity, no second employee-id scheme
--  (allocateEmployeeId remains the only generator), no second department or
--  manager hierarchy, and no second approval, audit, notification or document
--  system. Offer letters and candidate files are SecureDocument rows, reached
--  through the polymorphic owner columns Phase 0.5 built for exactly this.
--
--  ---------------------------------------------------------------------------
--  TIME
--
--  Identical to Phase 2 and for the same reasons. DATE columns — proposedJoiningDate,
--  joiningDate, startDate, endDate, dueOn, scheduledOn, expiresOn — are calendar
--  days read in IST (+5:30 fixed). TIMESTAMP columns — scheduledAt, sentAt,
--  respondedAt, decidedAt, completedAt — are real moments taken from Postgres
--  now() through databaseNow(). A client clock is never authoritative.
--
--  Interview.scheduledAt is a TIMESTAMP rather than a date because an interview
--  happens at a time, and "Tuesday" is not a thing anybody can attend.
--
--  ---------------------------------------------------------------------------
--  WHAT THE UNIQUE CONSTRAINTS ARE ACTUALLY FOR
--
--  Four of them carry real safety weight, and none is merely tidiness:
--
--    Application (candidateId, jobRequisitionId)
--        One candidate pursues one role once. Two concurrent "apply" requests
--        cannot both pass a service-level check; they can both fail this.
--
--    OnboardingRecord.applicationId  and  OnboardingRecord.employeeId
--        The pair that stops one hire producing two employees. The first means
--        one application onboards once; the second means one onboarding creates
--        at most one employment record. Without them a double-submitted
--        "create employee" step mints two Employee rows with two employee-ids
--        for the same person, which is unrecoverable by anything but hand repair.
--
--    ProbationRecord.employeeId
--        A person is on probation once per employment. A second probation is a
--        second employment, which is a second Employee.
--
--  The rest — Offer.code, Candidate.email, (interviewId, employeeId) on both
--  participant and feedback, (applicationId, checkType), (probationRecordId,
--  reviewType) — prevent duplicates that would make a list ambiguous rather than
--  corrupt. Still enforced here, because a service that remembers to check is a
--  service that one day forgets.
--
--  ---------------------------------------------------------------------------
--  WHY THE CHECK CONSTRAINTS BELOW EXIST
--
--  Each one pairs with a Zod schema in shared/. Both are kept because they fail
--  at different moments and protect against different things: Zod gives the
--  person a useful message, and the CHECK means a bug, a migration or a hand-run
--  UPDATE cannot write the state at all. The ones that matter most are the
--  "decided rows are complete" family — a rejected application with no reason, a
--  responded offer with no response date, a decided probation with no decider.
--  Those are precisely the rows somebody disputes months later, and a null there
--  is an argument nobody can settle.
-- =============================================================================

-- CreateEnum
CREATE TYPE "JobRequisitionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'PAUSED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "CandidateSource" AS ENUM ('DIRECT', 'REFERRAL', 'JOB_PORTAL', 'WALK_IN', 'CAMPUS', 'AGENCY', 'SOCIAL_MEDIA', 'OTHER');

-- CreateEnum
CREATE TYPE "ApplicationStage" AS ENUM ('APPLICATION', 'SCREENING', 'SHORTLISTED', 'HR_INTERVIEW', 'DEPARTMENT_INTERVIEW', 'ASSESSMENT', 'FINAL_INTERVIEW', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'BACKGROUND_VERIFICATION', 'ONBOARDING', 'JOINED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('ACTIVE', 'REJECTED', 'WITHDRAWN', 'HIRED', 'DECLINED');

-- CreateEnum
CREATE TYPE "InterviewType" AS ENUM ('HR', 'DEPARTMENT', 'TECHNICAL', 'FINAL', 'OTHER');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "InterviewRecommendation" AS ENUM ('STRONG_YES', 'YES', 'MAYBE', 'NO', 'STRONG_NO');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BackgroundCheckType" AS ENUM ('IDENTITY', 'EDUCATION', 'EMPLOYMENT', 'CRIMINAL', 'REFERENCE', 'ADDRESS', 'OTHER');

-- CreateEnum
CREATE TYPE "BackgroundCheckStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'CLEAR', 'FLAGGED', 'FAILED', 'WAIVED');

-- CreateEnum
CREATE TYPE "OnboardingStage" AS ENUM ('OFFER_ACCEPTED', 'DOCUMENTS', 'VERIFICATION', 'EMPLOYEE_CREATED', 'ACCOUNT', 'ASSETS', 'POLICIES', 'TRAINING', 'DEPARTMENT_INTRODUCTION', 'MANAGER_ASSIGNED', 'FIRST_WEEK', 'DAY_30', 'DAY_60', 'DAY_90', 'PROBATION_DECISION', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OnboardingTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "OnboardingTaskCategory" AS ENUM ('DOCUMENTS', 'IT', 'HR', 'MANAGER', 'TRAINING', 'POLICY', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "ProbationStatus" AS ENUM ('NOT_STARTED', 'ACTIVE', 'EXTENDED', 'CONFIRMED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ProbationReviewType" AS ENUM ('FIRST_WEEK', 'DAY_30', 'DAY_60', 'DAY_90');

-- CreateEnum
CREATE TYPE "ProbationReviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'MISSED');

-- CreateEnum
CREATE TYPE "ProbationDecision" AS ENUM ('CONFIRM', 'EXTEND', 'TERMINATE');

-- CreateTable
CREATE TABLE "JobRequisition" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "departmentId" TEXT,
    "designationId" TEXT,
    "hiringManagerId" TEXT,
    "recruiterId" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "workMode" "WorkMode" NOT NULL DEFAULT 'ON_SITE',
    "location" TEXT,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "requirements" TEXT,
    "responsibilities" TEXT,
    "salaryRangeMin" DECIMAL(12,2),
    "salaryRangeMax" DECIMAL(12,2),
    "salaryCurrency" TEXT DEFAULT 'INR',
    "status" "JobRequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "targetJoinDate" DATE,
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRequisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "location" TEXT,
    "source" "CandidateSource" NOT NULL DEFAULT 'DIRECT',
    "sourceDetail" TEXT,
    "totalExperienceYears" DECIMAL(4,1),
    "currentEmployer" TEXT,
    "currentDesignation" TEXT,
    "skills" TEXT[],
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobRequisitionId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "CandidateSource" NOT NULL DEFAULT 'DIRECT',
    "currentStage" "ApplicationStage" NOT NULL DEFAULT 'APPLICATION',
    "status" "ApplicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "recruiterId" TEXT,
    "hiringManagerId" TEXT,
    "screeningScore" INTEGER,
    "screeningNotes" TEXT,
    "rejectionReason" TEXT,
    "selectedById" TEXT,
    "selectedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationStageHistory" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fromStage" "ApplicationStage",
    "toStage" "ApplicationStage" NOT NULL,
    "reason" TEXT,
    "performedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationStageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interview" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "interviewType" "InterviewType" NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "location" TEXT,
    "meetingUrl" TEXT,
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "interviewerId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Interview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewParticipant" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewFeedback" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "rating" INTEGER,
    "recommendation" "InterviewRecommendation" NOT NULL,
    "strengths" TEXT,
    "concerns" TEXT,
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "assessmentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "score" DECIMAL(6,2),
    "maxScore" DECIMAL(6,2),
    "status" "AssessmentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "jobRequisitionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "departmentId" TEXT,
    "designationId" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "workMode" "WorkMode" NOT NULL DEFAULT 'ON_SITE',
    "location" TEXT,
    "proposedJoiningDate" DATE NOT NULL,
    "annualPackage" DECIMAL(12,2),
    "packageCurrency" TEXT DEFAULT 'INR',
    "benefitsSummary" TEXT,
    "expiresOn" DATE,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "responseNote" TEXT,
    "secureDocumentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundCheck" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "checkType" "BackgroundCheckType" NOT NULL,
    "status" "BackgroundCheckStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "result" TEXT,
    "notes" TEXT,
    "verifierName" TEXT,
    "verifiedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateDocument" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "secureDocumentId" TEXT NOT NULL,
    "documentType" "EmployeeDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "backgroundCheckId" TEXT,
    "verificationStatus" "DocumentVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingRecord" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "employeeId" TEXT,
    "stage" "OnboardingStage" NOT NULL DEFAULT 'OFFER_ACCEPTED',
    "joiningDate" DATE NOT NULL,
    "actualJoiningDate" DATE,
    "departmentId" TEXT,
    "designationId" TEXT,
    "managerId" TEXT,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingTask" (
    "id" TEXT NOT NULL,
    "onboardingRecordId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "OnboardingTaskCategory" NOT NULL,
    "detail" TEXT,
    "assigneeId" TEXT,
    "dueOn" DATE,
    "status" "OnboardingTaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbationRecord" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "ProbationStatus" NOT NULL DEFAULT 'ACTIVE',
    "managerId" TEXT,
    "decision" "ProbationDecision",
    "decisionReason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "originalEndDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProbationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbationReview" (
    "id" TEXT NOT NULL,
    "probationRecordId" TEXT NOT NULL,
    "reviewType" "ProbationReviewType" NOT NULL,
    "scheduledOn" DATE NOT NULL,
    "status" "ProbationReviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "reviewerId" TEXT,
    "rating" INTEGER,
    "comments" TEXT,
    "recommendation" "InterviewRecommendation",
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProbationReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobRequisition_code_key" ON "JobRequisition"("code");

-- CreateIndex
CREATE INDEX "JobRequisition_status_priority_createdAt_idx" ON "JobRequisition"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "JobRequisition_departmentId_status_idx" ON "JobRequisition"("departmentId", "status");

-- CreateIndex
CREATE INDEX "JobRequisition_recruiterId_idx" ON "JobRequisition"("recruiterId");

-- CreateIndex
CREATE INDEX "JobRequisition_hiringManagerId_idx" ON "JobRequisition"("hiringManagerId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_email_key" ON "Candidate"("email");

-- CreateIndex
CREATE INDEX "Candidate_isActive_lastName_firstName_idx" ON "Candidate"("isActive", "lastName", "firstName");

-- CreateIndex
CREATE INDEX "Candidate_source_idx" ON "Candidate"("source");

-- CreateIndex
CREATE INDEX "Application_jobRequisitionId_currentStage_idx" ON "Application"("jobRequisitionId", "currentStage");

-- CreateIndex
CREATE INDEX "Application_currentStage_status_idx" ON "Application"("currentStage", "status");

-- CreateIndex
CREATE INDEX "Application_candidateId_idx" ON "Application"("candidateId");

-- CreateIndex
CREATE INDEX "Application_recruiterId_idx" ON "Application"("recruiterId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_candidateId_jobRequisitionId_key" ON "Application"("candidateId", "jobRequisitionId");

-- CreateIndex
CREATE INDEX "ApplicationStageHistory_applicationId_createdAt_idx" ON "ApplicationStageHistory"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "Interview_applicationId_scheduledAt_idx" ON "Interview"("applicationId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Interview_status_scheduledAt_idx" ON "Interview"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Interview_interviewerId_scheduledAt_idx" ON "Interview"("interviewerId", "scheduledAt");

-- CreateIndex
CREATE INDEX "InterviewParticipant_employeeId_idx" ON "InterviewParticipant"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewParticipant_interviewId_employeeId_key" ON "InterviewParticipant"("interviewId", "employeeId");

-- CreateIndex
CREATE INDEX "InterviewFeedback_employeeId_idx" ON "InterviewFeedback"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewFeedback_interviewId_employeeId_key" ON "InterviewFeedback"("interviewId", "employeeId");

-- CreateIndex
CREATE INDEX "Assessment_applicationId_status_idx" ON "Assessment"("applicationId", "status");

-- CreateIndex
CREATE INDEX "Assessment_status_dueAt_idx" ON "Assessment"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_code_key" ON "Offer"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_secureDocumentId_key" ON "Offer"("secureDocumentId");

-- CreateIndex
CREATE INDEX "Offer_applicationId_status_idx" ON "Offer"("applicationId", "status");

-- CreateIndex
CREATE INDEX "Offer_status_expiresOn_idx" ON "Offer"("status", "expiresOn");

-- CreateIndex
CREATE INDEX "BackgroundCheck_status_requestedAt_idx" ON "BackgroundCheck"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundCheck_applicationId_checkType_key" ON "BackgroundCheck"("applicationId", "checkType");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateDocument_secureDocumentId_key" ON "CandidateDocument"("secureDocumentId");

-- CreateIndex
CREATE INDEX "CandidateDocument_candidateId_documentType_idx" ON "CandidateDocument"("candidateId", "documentType");

-- CreateIndex
CREATE INDEX "CandidateDocument_backgroundCheckId_idx" ON "CandidateDocument"("backgroundCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingRecord_applicationId_key" ON "OnboardingRecord"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingRecord_employeeId_key" ON "OnboardingRecord"("employeeId");

-- CreateIndex
CREATE INDEX "OnboardingRecord_stage_joiningDate_idx" ON "OnboardingRecord"("stage", "joiningDate");

-- CreateIndex
CREATE INDEX "OnboardingRecord_joiningDate_idx" ON "OnboardingRecord"("joiningDate");

-- CreateIndex
CREATE INDEX "OnboardingTask_onboardingRecordId_sortOrder_idx" ON "OnboardingTask"("onboardingRecordId", "sortOrder");

-- CreateIndex
CREATE INDEX "OnboardingTask_status_dueOn_idx" ON "OnboardingTask"("status", "dueOn");

-- CreateIndex
CREATE INDEX "OnboardingTask_assigneeId_status_idx" ON "OnboardingTask"("assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProbationRecord_employeeId_key" ON "ProbationRecord"("employeeId");

-- CreateIndex
CREATE INDEX "ProbationRecord_status_endDate_idx" ON "ProbationRecord"("status", "endDate");

-- CreateIndex
CREATE INDEX "ProbationRecord_managerId_status_idx" ON "ProbationRecord"("managerId", "status");

-- CreateIndex
CREATE INDEX "ProbationReview_status_scheduledOn_idx" ON "ProbationReview"("status", "scheduledOn");

-- CreateIndex
CREATE UNIQUE INDEX "ProbationReview_probationRecordId_reviewType_key" ON "ProbationReview"("probationRecordId", "reviewType");

-- AddForeignKey
ALTER TABLE "JobRequisition" ADD CONSTRAINT "JobRequisition_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequisition" ADD CONSTRAINT "JobRequisition_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequisition" ADD CONSTRAINT "JobRequisition_hiringManagerId_fkey" FOREIGN KEY ("hiringManagerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequisition" ADD CONSTRAINT "JobRequisition_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequisition" ADD CONSTRAINT "JobRequisition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobRequisitionId_fkey" FOREIGN KEY ("jobRequisitionId") REFERENCES "JobRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_hiringManagerId_fkey" FOREIGN KEY ("hiringManagerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_selectedById_fkey" FOREIGN KEY ("selectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationStageHistory" ADD CONSTRAINT "ApplicationStageHistory_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationStageHistory" ADD CONSTRAINT "ApplicationStageHistory_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_interviewerId_fkey" FOREIGN KEY ("interviewerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewParticipant" ADD CONSTRAINT "InterviewParticipant_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewParticipant" ADD CONSTRAINT "InterviewParticipant_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewFeedback" ADD CONSTRAINT "InterviewFeedback_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewFeedback" ADD CONSTRAINT "InterviewFeedback_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_jobRequisitionId_fkey" FOREIGN KEY ("jobRequisitionId") REFERENCES "JobRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_secureDocumentId_fkey" FOREIGN KEY ("secureDocumentId") REFERENCES "SecureDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundCheck" ADD CONSTRAINT "BackgroundCheck_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundCheck" ADD CONSTRAINT "BackgroundCheck_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_secureDocumentId_fkey" FOREIGN KEY ("secureDocumentId") REFERENCES "SecureDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_backgroundCheckId_fkey" FOREIGN KEY ("backgroundCheckId") REFERENCES "BackgroundCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateDocument" ADD CONSTRAINT "CandidateDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingRecord" ADD CONSTRAINT "OnboardingRecord_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingRecord" ADD CONSTRAINT "OnboardingRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingRecord" ADD CONSTRAINT "OnboardingRecord_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingRecord" ADD CONSTRAINT "OnboardingRecord_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingRecord" ADD CONSTRAINT "OnboardingRecord_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingRecord" ADD CONSTRAINT "OnboardingRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_onboardingRecordId_fkey" FOREIGN KEY ("onboardingRecordId") REFERENCES "OnboardingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbationRecord" ADD CONSTRAINT "ProbationRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbationRecord" ADD CONSTRAINT "ProbationRecord_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbationRecord" ADD CONSTRAINT "ProbationRecord_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbationReview" ADD CONSTRAINT "ProbationReview_probationRecordId_fkey" FOREIGN KEY ("probationRecordId") REFERENCES "ProbationRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbationReview" ADD CONSTRAINT "ProbationReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
--  CHECK CONSTRAINTS
--
--  Each pairs with a Zod schema in shared/. Both exist on purpose: Zod explains
--  the problem to a person, and the CHECK means no code path, migration or
--  hand-run UPDATE can write the state at all.
-- =============================================================================

-- --- JobRequisition ----------------------------------------------------------

-- A requisition hires at least one person. Zero openings is a requisition that
-- does nothing, and a negative one is nonsense.
ALTER TABLE "JobRequisition"
  ADD CONSTRAINT "job_openings_positive" CHECK ("openings" > 0);

-- A range is a range. Both-null is fine (most roles do not advertise one), but a
-- maximum below the minimum would be shown to candidates as written.
ALTER TABLE "JobRequisition"
  ADD CONSTRAINT "job_salary_range_ordered" CHECK (
    "salaryRangeMin" IS NULL
    OR "salaryRangeMax" IS NULL
    OR "salaryRangeMax" >= "salaryRangeMin"
  );

ALTER TABLE "JobRequisition"
  ADD CONSTRAINT "job_salary_non_negative" CHECK (
    ("salaryRangeMin" IS NULL OR "salaryRangeMin" >= 0)
    AND ("salaryRangeMax" IS NULL OR "salaryRangeMax" >= 0)
  );

-- A published requisition knows when it was published, and a closed one when it
-- closed. Both stamps are set with the status, so "when did this go live" has an
-- answer that survives a later pause. PUBLISHED/PAUSED/CLOSED were all published
-- at some point — pausing does not unpublish.
ALTER TABLE "JobRequisition"
  ADD CONSTRAINT "job_published_stamp" CHECK (
    ("status" IN ('PUBLISHED', 'PAUSED', 'CLOSED') AND "publishedAt" IS NOT NULL)
    OR "status" NOT IN ('PUBLISHED', 'PAUSED', 'CLOSED')
  );

ALTER TABLE "JobRequisition"
  ADD CONSTRAINT "job_closed_stamp" CHECK (
    ("status" = 'CLOSED') = ("closedAt" IS NOT NULL)
  );

-- --- Candidate ---------------------------------------------------------------

-- Stored lower-cased, which is what makes the unique index a real duplicate
-- guard: without this, "A@x.com" and "a@x.com" are two candidates.
ALTER TABLE "Candidate"
  ADD CONSTRAINT "candidate_email_lowercase" CHECK ("email" = lower("email"));

ALTER TABLE "Candidate"
  ADD CONSTRAINT "candidate_experience_sane" CHECK (
    "totalExperienceYears" IS NULL
    OR ("totalExperienceYears" >= 0 AND "totalExperienceYears" <= 70)
  );

-- --- Application -------------------------------------------------------------

-- A rejection says why. This is the constraint most likely to be thanked for:
-- "we decided not to proceed" with no reason recorded is the single commonest
-- complaint about a hiring process, and it is unanswerable six months later.
ALTER TABLE "Application"
  ADD CONSTRAINT "application_rejection_reason" CHECK (
    "status" <> 'REJECTED'
    OR ("rejectionReason" IS NOT NULL AND length(btrim("rejectionReason")) > 0)
  );

-- Selection is recorded completely or not at all: who and when move together.
ALTER TABLE "Application"
  ADD CONSTRAINT "application_selection_complete" CHECK (
    ("selectedById" IS NULL) = ("selectedAt" IS NULL)
  );

-- Anything at SELECTED or beyond was selected by somebody. The stages after it
-- are all downstream of that decision, so none of them can lack it.
ALTER TABLE "Application"
  ADD CONSTRAINT "application_selected_stage_has_decision" CHECK (
    "currentStage" NOT IN (
      'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'BACKGROUND_VERIFICATION',
      'ONBOARDING', 'JOINED'
    )
    OR "selectedAt" IS NOT NULL
  );

-- Only an application that reached JOINED is HIRED, and a HIRED one is at JOINED.
-- The two columns say different things — where it is, and whether it is live —
-- and this is the one place they must agree.
ALTER TABLE "Application"
  ADD CONSTRAINT "application_hired_at_joined" CHECK (
    ("status" = 'HIRED') = ("currentStage" = 'JOINED')
  );

ALTER TABLE "Application"
  ADD CONSTRAINT "application_screening_score_range" CHECK (
    "screeningScore" IS NULL OR ("screeningScore" >= 0 AND "screeningScore" <= 100)
  );

-- --- ApplicationStageHistory -------------------------------------------------

-- A move goes somewhere. A row recording a transition from X to X is noise in
-- the one table whose entire value is being a faithful record.
ALTER TABLE "ApplicationStageHistory"
  ADD CONSTRAINT "stage_history_moves" CHECK (
    "fromStage" IS NULL OR "fromStage" <> "toStage"
  );

-- --- Interview ---------------------------------------------------------------

ALTER TABLE "Interview"
  ADD CONSTRAINT "interview_duration_positive" CHECK (
    "durationMinutes" > 0 AND "durationMinutes" <= 480
  );

ALTER TABLE "Interview"
  ADD CONSTRAINT "interview_round_positive" CHECK ("round" > 0);

-- A completed interview knows when it finished; one that is not completed has
-- not finished. NO_SHOW and CANCELLED are outcomes, not completions.
ALTER TABLE "Interview"
  ADD CONSTRAINT "interview_completed_stamp" CHECK (
    ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
  );

-- --- InterviewFeedback -------------------------------------------------------

ALTER TABLE "InterviewFeedback"
  ADD CONSTRAINT "interview_feedback_rating_range" CHECK (
    "rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5)
  );

-- --- Assessment --------------------------------------------------------------

ALTER TABLE "Assessment"
  ADD CONSTRAINT "assessment_scores_non_negative" CHECK (
    ("score" IS NULL OR "score" >= 0)
    AND ("maxScore" IS NULL OR "maxScore" > 0)
  );

-- A score needs something to be out of, and cannot exceed it. A score with no
-- maximum is a number nobody can interpret.
ALTER TABLE "Assessment"
  ADD CONSTRAINT "assessment_score_within_max" CHECK (
    "score" IS NULL OR ("maxScore" IS NOT NULL AND "score" <= "maxScore")
  );

-- A concluded assessment has a result and a reviewer's moment. PENDING and
-- IN_PROGRESS have neither yet.
ALTER TABLE "Assessment"
  ADD CONSTRAINT "assessment_review_complete" CHECK (
    "status" NOT IN ('COMPLETED', 'PASSED', 'FAILED')
    OR "reviewedAt" IS NOT NULL
  );

ALTER TABLE "Assessment"
  ADD CONSTRAINT "assessment_due_after_assigned" CHECK (
    "dueAt" IS NULL OR "dueAt" >= "assignedAt"
  );

-- --- Offer -------------------------------------------------------------------

ALTER TABLE "Offer"
  ADD CONSTRAINT "offer_package_non_negative" CHECK (
    "annualPackage" IS NULL OR "annualPackage" >= 0
  );

-- An offer that has left the building knows when it did. DRAFT has not.
ALTER TABLE "Offer"
  ADD CONSTRAINT "offer_sent_stamp" CHECK (
    "status" = 'DRAFT' OR "sentAt" IS NOT NULL
  );

-- A decided offer says when it was decided. This is the row somebody disputes —
-- "I accepted on the 3rd" — and a null here makes that unanswerable.
ALTER TABLE "Offer"
  ADD CONSTRAINT "offer_response_stamp" CHECK (
    ("status" IN ('ACCEPTED', 'REJECTED', 'WITHDRAWN')) = ("respondedAt" IS NOT NULL)
  );

-- A refusal from either side says why.
ALTER TABLE "Offer"
  ADD CONSTRAINT "offer_refusal_note" CHECK (
    "status" NOT IN ('REJECTED', 'WITHDRAWN')
    OR ("responseNote" IS NOT NULL AND length(btrim("responseNote")) > 0)
  );

-- An expiry after the proposed start is meaningless: the offer would lapse after
-- the day it was meant to begin.
ALTER TABLE "Offer"
  ADD CONSTRAINT "offer_expiry_before_joining" CHECK (
    "expiresOn" IS NULL OR "expiresOn" <= "proposedJoiningDate"
  );

-- --- BackgroundCheck ---------------------------------------------------------

-- A concluded check knows when it concluded; an unconcluded one does not.
ALTER TABLE "BackgroundCheck"
  ADD CONSTRAINT "background_check_completed_stamp" CHECK (
    ("status" IN ('CLEAR', 'FLAGGED', 'FAILED', 'WAIVED')) = ("completedAt" IS NOT NULL)
  );

-- A flagged or failed check says what was found. "Failed" with no result is an
-- accusation with no evidence, and this is somebody's livelihood.
ALTER TABLE "BackgroundCheck"
  ADD CONSTRAINT "background_check_adverse_result" CHECK (
    "status" NOT IN ('FLAGGED', 'FAILED')
    OR ("result" IS NOT NULL AND length(btrim("result")) > 0)
  );

-- A waived check records the decision to waive it.
ALTER TABLE "BackgroundCheck"
  ADD CONSTRAINT "background_check_waiver_reason" CHECK (
    "status" <> 'WAIVED'
    OR ("notes" IS NOT NULL AND length(btrim("notes")) > 0)
  );

-- --- CandidateDocument -------------------------------------------------------

-- A verification decision is complete or absent: who and when move together with
-- the status leaving PENDING.
ALTER TABLE "CandidateDocument"
  ADD CONSTRAINT "candidate_document_verification_complete" CHECK (
    ("verificationStatus" = 'PENDING')
      = ("verifiedById" IS NULL AND "verifiedAt" IS NULL)
  );

-- --- OnboardingRecord --------------------------------------------------------

-- The hinge of the whole onboarding. From EMPLOYEE_CREATED onwards the employment
-- record exists, and before it there is nothing to point at. Without this a
-- checklist could reach DAY_90 for somebody who was never actually hired.
ALTER TABLE "OnboardingRecord"
  ADD CONSTRAINT "onboarding_employee_after_creation" CHECK (
    "stage" IN (
      'OFFER_ACCEPTED', 'DOCUMENTS', 'VERIFICATION'
    )
    OR "employeeId" IS NOT NULL
  );

ALTER TABLE "OnboardingRecord"
  ADD CONSTRAINT "onboarding_no_employee_before_creation" CHECK (
    "stage" NOT IN ('OFFER_ACCEPTED', 'DOCUMENTS', 'VERIFICATION')
    OR "employeeId" IS NULL
  );

ALTER TABLE "OnboardingRecord"
  ADD CONSTRAINT "onboarding_completed_stamp" CHECK (
    ("stage" = 'COMPLETED') = ("completedAt" IS NOT NULL)
  );

-- --- OnboardingTask ----------------------------------------------------------

-- A finished task knows when and by whom. SKIPPED counts as finished — deciding
-- not to do something is a decision somebody made and should be attributable.
ALTER TABLE "OnboardingTask"
  ADD CONSTRAINT "onboarding_task_completion_complete" CHECK (
    ("status" IN ('COMPLETED', 'SKIPPED'))
      = ("completedAt" IS NOT NULL AND "completedById" IS NOT NULL)
  );

-- A skipped task says why it was skipped.
ALTER TABLE "OnboardingTask"
  ADD CONSTRAINT "onboarding_task_skip_reason" CHECK (
    "status" <> 'SKIPPED'
    OR ("notes" IS NOT NULL AND length(btrim("notes")) > 0)
  );

ALTER TABLE "OnboardingTask"
  ADD CONSTRAINT "onboarding_task_sort_non_negative" CHECK ("sortOrder" >= 0);

-- --- ProbationRecord ---------------------------------------------------------

ALTER TABLE "ProbationRecord"
  ADD CONSTRAINT "probation_period_ordered" CHECK ("endDate" > "startDate");

-- The decision moves as one. A confirmed or terminated probation that cannot say
-- who decided, when, or on what grounds is the exact record an employment dispute
-- turns on.
ALTER TABLE "ProbationRecord"
  ADD CONSTRAINT "probation_decision_complete" CHECK (
    ("decision" IS NULL AND "decidedById" IS NULL AND "decidedAt" IS NULL
     AND "decisionReason" IS NULL)
    OR ("decision" IS NOT NULL AND "decidedById" IS NOT NULL
        AND "decidedAt" IS NOT NULL
        AND "decisionReason" IS NOT NULL
        AND length(btrim("decisionReason")) > 0)
  );

-- A settled probation has been decided, and the decision matches the status.
-- ACTIVE and NOT_STARTED have not been decided at all.
ALTER TABLE "ProbationRecord"
  ADD CONSTRAINT "probation_status_matches_decision" CHECK (
    ("status" = 'CONFIRMED' AND "decision" = 'CONFIRM')
    OR ("status" = 'TERMINATED' AND "decision" = 'TERMINATE')
    OR ("status" = 'EXTENDED' AND "decision" = 'EXTEND')
    OR ("status" IN ('NOT_STARTED', 'ACTIVE') AND "decision" IS NULL)
  );

-- An extension moved the end date, so the original is kept and the new one is
-- later. Without this the original term is simply lost to an UPDATE.
ALTER TABLE "ProbationRecord"
  ADD CONSTRAINT "probation_extension_keeps_original" CHECK (
    ("status" <> 'EXTENDED' AND "originalEndDate" IS NULL)
    OR ("status" = 'EXTENDED' AND "originalEndDate" IS NOT NULL
        AND "endDate" > "originalEndDate")
  );

-- --- ProbationReview ---------------------------------------------------------

ALTER TABLE "ProbationReview"
  ADD CONSTRAINT "probation_review_rating_range" CHECK (
    "rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5)
  );

-- A completed review knows when it happened and who gave it; one that has not
-- happened has neither. A MISSED review is a recorded fact with no content.
ALTER TABLE "ProbationReview"
  ADD CONSTRAINT "probation_review_completion" CHECK (
    ("status" = 'COMPLETED')
      = ("completedAt" IS NOT NULL AND "reviewerId" IS NOT NULL)
  );

-- A completed review says something. A rating with no comment is a number
-- somebody is expected to act on with no explanation.
ALTER TABLE "ProbationReview"
  ADD CONSTRAINT "probation_review_has_comments" CHECK (
    "status" <> 'COMPLETED'
    OR ("comments" IS NOT NULL AND length(btrim("comments")) > 0)
  );
