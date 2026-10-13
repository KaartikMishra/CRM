-- =============================================================================
--  HR Phase 4 — Training & Learning Management.
--
--  Fifteen new tables, eight new enums, one nullable column added to
--  OnboardingTask. Forward-only and additive: no existing column changes type,
--  nullability or default, and no row is inserted, updated or deleted.
--
--  The three foreign keys this migration does NOT touch
--  ---------------------------------------------------------------------------
--  `prisma migrate diff` again wanted to drop and re-create
--  PurchaseBill_reviewedById_fkey, PurchaseItemProductChange_reviewedById_fkey and
--  SalesOrder_cancelledById_fkey. That is the same pre-existing drift Phase 3
--  reported — live is ON DELETE RESTRICT where the schema says SET NULL — in Sales
--  and Procurement, two shipped modules Phase 4 has no business changing. Those six
--  statements were removed deliberately, for the third time. The drift stays
--  reported, not fixed.
--
--  ---------------------------------------------------------------------------
--  THE JOURNEY IS DATA
--
--  The required sequence — company introduction, product training, customer
--  psychology, communication, customer experience, productivity tools, policies,
--  knowledge test, department training, department test, practical, shadowing,
--  final assessment, qualified — is ordered TrainingModule rows inside a
--  TrainingProgram, gated by that program's requirement flags.
--
--  It is deliberately not a chain of service conditionals. A compiled-in sequence
--  means every department that trains differently needs a code change, and the
--  first exception becomes an `if` nobody finds later. TrainingProgram therefore
--  carries the policy (passingScore, maxAttempts, requiresPractical,
--  requiresShadowing, requiresFinalAssessment) and TrainingModule.sortOrder
--  carries the order.
--
--  ---------------------------------------------------------------------------
--  SCORES ARE DECIMAL, NEVER FLOAT
--
--  Every score, percentage and points column is NUMERIC(5,2). A pass mark of 80
--  against a computed 79.995 must not round into a pass, and `0.1 + 0.2 !== 0.3`
--  is precisely the class of defect that would decide whether somebody is
--  qualified to do live customer work. The arithmetic happens in Postgres and in
--  Prisma.Decimal; nothing in this phase uses a JavaScript number for a score.
--
--  ---------------------------------------------------------------------------
--  WHAT THE UNIQUE CONSTRAINTS ARE ACTUALLY FOR
--
--  Five carry real safety weight:
--
--    TrainingModule (programId, sortOrder)
--        One module per position, so "the next module" is never ambiguous. Without
--        it a learner's path depends on insertion order.
--
--    TrainingAttempt (enrollmentId, assessmentId, attemptNumber)
--        THE attempt-limit guard. Two simultaneous starts cannot both claim
--        attempt 3, so the maximum cannot be exceeded by racing — a service-level
--        count would pass in both requests.
--
--    TrainingAnswer (attemptId, questionId)
--        One answer per question per attempt. Stops a double-submit scoring a
--        question twice.
--
--    TrainingModuleProgress (enrollmentId, moduleId)
--        One progress row per module, so "completed" cannot be recorded twice.
--
--    TrainingQualification.enrollmentId
--        One enrollment grants qualification once.
--
--  Plus two partial unique indexes below, which Prisma cannot express.
--
--  ---------------------------------------------------------------------------
--  WHY THE CHECK CONSTRAINTS EXIST
--
--  Each pairs with a Zod schema in shared/. Both are kept because they fail at
--  different moments: Zod gives the person a useful message, and the CHECK means a
--  bug, a migration or a hand-run UPDATE cannot write the state at all. The ones
--  doing the most work are the "settled rows are complete" family — an attempt with
--  a score but no pass decision, an exemption with no reason, a sign-off with no
--  signer. Those are exactly the rows somebody disputes when they are told they
--  cannot start live work.
-- =============================================================================

-- CreateEnum
CREATE TYPE "TrainingProgramStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TrainingModuleKind" AS ENUM ('LESSON', 'ASSESSMENT', 'PRACTICAL', 'SHADOWING');

-- CreateEnum
CREATE TYPE "TrainingEnrollmentStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'EXEMPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrainingObligation" AS ENUM ('MANDATORY', 'OPTIONAL');

-- CreateEnum
CREATE TYPE "AssessmentQuestionKind" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE');

-- CreateEnum
CREATE TYPE "TrainingAttemptStatus" AS ENUM ('IN_PROGRESS', 'PASSED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PracticalSubmissionStatus" AS ENUM ('NOT_STARTED', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ShadowingStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "OnboardingTask" ADD COLUMN     "trainingEnrollmentId" TEXT;

-- CreateTable
CREATE TABLE "TrainingCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingProgram" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "objectives" TEXT,
    "categoryId" TEXT,
    "targetDepartmentId" TEXT,
    "targetDesignationId" TEXT,
    "status" "TrainingProgramStatus" NOT NULL DEFAULT 'DRAFT',
    "obligation" "TrainingObligation" NOT NULL DEFAULT 'OPTIONAL',
    "estimatedMinutes" INTEGER,
    "passingScore" DECIMAL(5,2) NOT NULL DEFAULT 80.00,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "requiresPractical" BOOLEAN NOT NULL DEFAULT false,
    "requiresShadowing" BOOLEAN NOT NULL DEFAULT false,
    "requiresFinalAssessment" BOOLEAN NOT NULL DEFAULT true,
    "dueWithinDays" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingModule" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "TrainingModuleKind" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "content" TEXT,
    "referenceUrl" TEXT,
    "secureDocumentId" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT,
    "estimatedMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingEnrollment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "status" "TrainingEnrollmentStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "obligation" "TrainingObligation" NOT NULL DEFAULT 'OPTIONAL',
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueOn" DATE,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "assignedVia" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
    "exemptedById" TEXT,
    "exemptedAt" TIMESTAMP(3),
    "exemptionReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingModuleProgress" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "timeSpentMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingModuleProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAssessment" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "moduleId" TEXT,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "passingScore" DECIMAL(5,2),
    "maxAttempts" INTEGER,
    "timeLimitMinutes" INTEGER,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingQuestion" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "kind" "AssessmentQuestionKind" NOT NULL,
    "prompt" TEXT NOT NULL,
    "explanation" TEXT,
    "points" DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingQuestionOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingQuestionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAttempt" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "TrainingAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "score" DECIMAL(5,2),
    "maxScore" DECIMAL(5,2),
    "percentage" DECIMAL(5,2),
    "passed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "pointsAwarded" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAnswerOption" (
    "id" TEXT NOT NULL,
    "answerId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,

    CONSTRAINT "TrainingAnswerOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticalSubmission" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "status" "PracticalSubmissionStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "submissionNotes" TEXT,
    "secureDocumentId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticalSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShadowingRecord" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "mentorId" TEXT,
    "status" "ShadowingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFrom" DATE,
    "scheduledTo" DATE,
    "checklist" TEXT,
    "feedback" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "signedOffById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShadowingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingQualification" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "qualifiedAt" TIMESTAMP(3) NOT NULL,
    "grantedById" TEXT NOT NULL,
    "finalAttemptId" TEXT,
    "finalScore" DECIMAL(5,2),
    "notes" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revocationReason" TEXT,
    "certificateCode" TEXT,
    "certificateIssuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingCodeCounter" (
    "scope" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingCodeCounter_pkey" PRIMARY KEY ("scope")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrainingCategory_code_key" ON "TrainingCategory"("code");

-- CreateIndex
CREATE INDEX "TrainingCategory_isActive_sortOrder_name_idx" ON "TrainingCategory"("isActive", "sortOrder", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingProgram_code_key" ON "TrainingProgram"("code");

-- CreateIndex
CREATE INDEX "TrainingProgram_status_title_idx" ON "TrainingProgram"("status", "title");

-- CreateIndex
CREATE INDEX "TrainingProgram_categoryId_status_idx" ON "TrainingProgram"("categoryId", "status");

-- CreateIndex
CREATE INDEX "TrainingProgram_targetDepartmentId_idx" ON "TrainingProgram"("targetDepartmentId");

-- CreateIndex
CREATE INDEX "TrainingModule_programId_sortOrder_idx" ON "TrainingModule"("programId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingModule_programId_sortOrder_key" ON "TrainingModule"("programId", "sortOrder");

-- CreateIndex
CREATE INDEX "TrainingEnrollment_employeeId_status_idx" ON "TrainingEnrollment"("employeeId", "status");

-- CreateIndex
CREATE INDEX "TrainingEnrollment_programId_status_idx" ON "TrainingEnrollment"("programId", "status");

-- CreateIndex
CREATE INDEX "TrainingEnrollment_status_dueOn_idx" ON "TrainingEnrollment"("status", "dueOn");

-- CreateIndex
CREATE INDEX "TrainingModuleProgress_enrollmentId_idx" ON "TrainingModuleProgress"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingModuleProgress_enrollmentId_moduleId_key" ON "TrainingModuleProgress"("enrollmentId", "moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAssessment_moduleId_key" ON "TrainingAssessment"("moduleId");

-- CreateIndex
CREATE INDEX "TrainingAssessment_programId_isActive_idx" ON "TrainingAssessment"("programId", "isActive");

-- CreateIndex
CREATE INDEX "TrainingQuestion_assessmentId_sortOrder_idx" ON "TrainingQuestion"("assessmentId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingQuestion_assessmentId_sortOrder_key" ON "TrainingQuestion"("assessmentId", "sortOrder");

-- CreateIndex
CREATE INDEX "TrainingQuestionOption_questionId_idx" ON "TrainingQuestionOption"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingQuestionOption_questionId_sortOrder_key" ON "TrainingQuestionOption"("questionId", "sortOrder");

-- CreateIndex
CREATE INDEX "TrainingAttempt_enrollmentId_status_idx" ON "TrainingAttempt"("enrollmentId", "status");

-- CreateIndex
CREATE INDEX "TrainingAttempt_assessmentId_status_idx" ON "TrainingAttempt"("assessmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttempt_enrollmentId_assessmentId_attemptNumber_key" ON "TrainingAttempt"("enrollmentId", "assessmentId", "attemptNumber");

-- CreateIndex
CREATE INDEX "TrainingAnswer_attemptId_idx" ON "TrainingAnswer"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAnswer_attemptId_questionId_key" ON "TrainingAnswer"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "TrainingAnswerOption_optionId_idx" ON "TrainingAnswerOption"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAnswerOption_answerId_optionId_key" ON "TrainingAnswerOption"("answerId", "optionId");

-- CreateIndex
CREATE INDEX "PracticalSubmission_reviewerId_status_idx" ON "PracticalSubmission"("reviewerId", "status");

-- CreateIndex
CREATE INDEX "PracticalSubmission_status_idx" ON "PracticalSubmission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PracticalSubmission_enrollmentId_moduleId_key" ON "PracticalSubmission"("enrollmentId", "moduleId");

-- CreateIndex
CREATE INDEX "ShadowingRecord_mentorId_status_idx" ON "ShadowingRecord"("mentorId", "status");

-- CreateIndex
CREATE INDEX "ShadowingRecord_status_idx" ON "ShadowingRecord"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ShadowingRecord_enrollmentId_moduleId_key" ON "ShadowingRecord"("enrollmentId", "moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingQualification_enrollmentId_key" ON "TrainingQualification"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingQualification_certificateCode_key" ON "TrainingQualification"("certificateCode");

-- CreateIndex
CREATE INDEX "TrainingQualification_qualifiedAt_idx" ON "TrainingQualification"("qualifiedAt");

-- AddForeignKey
ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_trainingEnrollmentId_fkey" FOREIGN KEY ("trainingEnrollmentId") REFERENCES "TrainingEnrollment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingCategory" ADD CONSTRAINT "TrainingCategory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingProgram" ADD CONSTRAINT "TrainingProgram_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "TrainingCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingProgram" ADD CONSTRAINT "TrainingProgram_targetDepartmentId_fkey" FOREIGN KEY ("targetDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingProgram" ADD CONSTRAINT "TrainingProgram_targetDesignationId_fkey" FOREIGN KEY ("targetDesignationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingProgram" ADD CONSTRAINT "TrainingProgram_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingModule" ADD CONSTRAINT "TrainingModule_programId_fkey" FOREIGN KEY ("programId") REFERENCES "TrainingProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingModule" ADD CONSTRAINT "TrainingModule_secureDocumentId_fkey" FOREIGN KEY ("secureDocumentId") REFERENCES "SecureDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEnrollment" ADD CONSTRAINT "TrainingEnrollment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEnrollment" ADD CONSTRAINT "TrainingEnrollment_programId_fkey" FOREIGN KEY ("programId") REFERENCES "TrainingProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEnrollment" ADD CONSTRAINT "TrainingEnrollment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEnrollment" ADD CONSTRAINT "TrainingEnrollment_exemptedById_fkey" FOREIGN KEY ("exemptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingModuleProgress" ADD CONSTRAINT "TrainingModuleProgress_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "TrainingEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingModuleProgress" ADD CONSTRAINT "TrainingModuleProgress_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "TrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssessment" ADD CONSTRAINT "TrainingAssessment_programId_fkey" FOREIGN KEY ("programId") REFERENCES "TrainingProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssessment" ADD CONSTRAINT "TrainingAssessment_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "TrainingModule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssessment" ADD CONSTRAINT "TrainingAssessment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingQuestion" ADD CONSTRAINT "TrainingQuestion_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "TrainingAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingQuestionOption" ADD CONSTRAINT "TrainingQuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TrainingQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttempt" ADD CONSTRAINT "TrainingAttempt_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "TrainingEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttempt" ADD CONSTRAINT "TrainingAttempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "TrainingAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAnswer" ADD CONSTRAINT "TrainingAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "TrainingAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAnswer" ADD CONSTRAINT "TrainingAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TrainingQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAnswerOption" ADD CONSTRAINT "TrainingAnswerOption_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "TrainingAnswer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAnswerOption" ADD CONSTRAINT "TrainingAnswerOption_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "TrainingQuestionOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticalSubmission" ADD CONSTRAINT "PracticalSubmission_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "TrainingEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticalSubmission" ADD CONSTRAINT "PracticalSubmission_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "TrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticalSubmission" ADD CONSTRAINT "PracticalSubmission_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticalSubmission" ADD CONSTRAINT "PracticalSubmission_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticalSubmission" ADD CONSTRAINT "PracticalSubmission_secureDocumentId_fkey" FOREIGN KEY ("secureDocumentId") REFERENCES "SecureDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShadowingRecord" ADD CONSTRAINT "ShadowingRecord_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "TrainingEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShadowingRecord" ADD CONSTRAINT "ShadowingRecord_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "TrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShadowingRecord" ADD CONSTRAINT "ShadowingRecord_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShadowingRecord" ADD CONSTRAINT "ShadowingRecord_signedOffById_fkey" FOREIGN KEY ("signedOffById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingQualification" ADD CONSTRAINT "TrainingQualification_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "TrainingEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingQualification" ADD CONSTRAINT "TrainingQualification_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingQualification" ADD CONSTRAINT "TrainingQualification_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
--  PARTIAL UNIQUE INDEXES
--
--  Prisma cannot express a WHERE clause on a unique index, so these live here —
--  the same reason Phase 2's leave balances and Phase 3's live-application guard
--  are written by hand.
-- =============================================================================

/*
  One live enrollment per employee per program.

  Partial, and that is the point: somebody legitimately retakes an induction two
  years later, and a plain unique would refuse it. Scoped to the statuses that mean
  "still in play", so a completed, exempted or cancelled enrollment does not block
  a fresh assignment — while two concurrent assign requests still cannot both land.
*/
CREATE UNIQUE INDEX "training_enrollment_one_live_per_program"
  ON "TrainingEnrollment" ("employeeId", "programId")
  WHERE "status" IN ('NOT_STARTED', 'IN_PROGRESS');

/*
  One final assessment per program.

  `requiresFinalAssessment` refers to "the" final assessment, so there has to be
  exactly one for that to mean anything. Without this, two finals would make
  qualification depend on which one the query happened to return first.
*/
CREATE UNIQUE INDEX "training_assessment_one_final_per_program"
  ON "TrainingAssessment" ("programId")
  WHERE "isFinal" = true;

-- =============================================================================
--  CHECK CONSTRAINTS
--
--  Each pairs with a Zod schema. Both exist on purpose: Zod explains the problem
--  to a person, and the CHECK means no code path, migration or hand-run UPDATE can
--  write the state at all.
-- =============================================================================

-- --- TrainingCategory ---------------------------------------------------------

ALTER TABLE "TrainingCategory"
  ADD CONSTRAINT "training_category_code_uppercase" CHECK ("code" = upper("code"));

ALTER TABLE "TrainingCategory"
  ADD CONSTRAINT "training_category_sort_non_negative" CHECK ("sortOrder" >= 0);

-- --- TrainingProgram ----------------------------------------------------------

/*
  A pass mark is a percentage. The business default is 80 and the column default
  says so, but a program may set its own — what it may not be is 0 (everybody
  passes, so the test means nothing) or above 100 (nobody can pass, so the
  programme is unfinishable and nobody would know why).
*/
ALTER TABLE "TrainingProgram"
  ADD CONSTRAINT "training_program_passing_score_range" CHECK (
    "passingScore" > 0 AND "passingScore" <= 100
  );

/*
  At least one attempt, or the assessment is undoable. An upper bound too: 50
  attempts is not a retake policy, it is a missing one, and it usually means
  somebody typed a year into the field.
*/
ALTER TABLE "TrainingProgram"
  ADD CONSTRAINT "training_program_attempts_range" CHECK (
    "maxAttempts" >= 1 AND "maxAttempts" <= 50
  );

ALTER TABLE "TrainingProgram"
  ADD CONSTRAINT "training_program_duration_positive" CHECK (
    "estimatedMinutes" IS NULL OR "estimatedMinutes" > 0
  );

ALTER TABLE "TrainingProgram"
  ADD CONSTRAINT "training_program_due_days_positive" CHECK (
    "dueWithinDays" IS NULL OR "dueWithinDays" > 0
  );

/*
  A published programme knows when it was published, and an archived one when it
  was archived. Both stamps move with the status, so "when did this become
  assignable" survives a later archive — the same pairing the job requisition uses.
*/
ALTER TABLE "TrainingProgram"
  ADD CONSTRAINT "training_program_published_stamp" CHECK (
    ("status" IN ('ACTIVE', 'ARCHIVED') AND "publishedAt" IS NOT NULL)
    OR "status" = 'DRAFT'
  );

ALTER TABLE "TrainingProgram"
  ADD CONSTRAINT "training_program_archived_stamp" CHECK (
    ("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL)
  );

-- --- TrainingModule -----------------------------------------------------------

ALTER TABLE "TrainingModule"
  ADD CONSTRAINT "training_module_sort_non_negative" CHECK ("sortOrder" >= 0);

ALTER TABLE "TrainingModule"
  ADD CONSTRAINT "training_module_duration_positive" CHECK (
    "estimatedMinutes" IS NULL OR "estimatedMinutes" > 0
  );

/*
  A practical or shadowing module says what to do.

  Without instructions the learner is told "complete the practical exercise" and
  nothing else, and the reviewer has no stated basis for approving or rejecting it.
  A lesson needs no instructions — its content *is* the instruction.
*/
ALTER TABLE "TrainingModule"
  ADD CONSTRAINT "training_module_practical_has_instructions" CHECK (
    "kind" NOT IN ('PRACTICAL', 'SHADOWING')
    OR ("instructions" IS NOT NULL AND length(btrim("instructions")) > 0)
  );

-- --- TrainingEnrollment -------------------------------------------------------

/*
  An exemption is complete or absent: who, when and why move together.

  This is the one somebody disputes. "I was excused from that course" is
  unanswerable if the record cannot say who excused them or on what grounds.
*/
ALTER TABLE "TrainingEnrollment"
  ADD CONSTRAINT "training_enrollment_exemption_complete" CHECK (
    ("exemptedById" IS NULL AND "exemptedAt" IS NULL AND "exemptionReason" IS NULL)
    OR (
      "exemptedById" IS NOT NULL
      AND "exemptedAt" IS NOT NULL
      AND "exemptionReason" IS NOT NULL
      AND length(btrim("exemptionReason")) > 0
    )
  );

/* An exempted enrollment has been exempted, and only an exempted one has. */
ALTER TABLE "TrainingEnrollment"
  ADD CONSTRAINT "training_enrollment_exempt_status" CHECK (
    ("status" = 'EXEMPTED') = ("exemptedAt" IS NOT NULL)
  );

/* Cancellation says why, for the same reason an exemption does. */
ALTER TABLE "TrainingEnrollment"
  ADD CONSTRAINT "training_enrollment_cancellation_complete" CHECK (
    ("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)
  );

ALTER TABLE "TrainingEnrollment"
  ADD CONSTRAINT "training_enrollment_cancellation_reason" CHECK (
    "cancelledAt" IS NULL
    OR ("cancellationReason" IS NOT NULL AND length(btrim("cancellationReason")) > 0)
  );

/*
  A completed enrollment knows when it completed, and an uncompleted one does not
  claim to. The pairing is what stops a half-written transition leaving a course
  that reads as finished with no date — which is how somebody ends up "qualified"
  on a report and not in the record.
*/
ALTER TABLE "TrainingEnrollment"
  ADD CONSTRAINT "training_enrollment_completed_stamp" CHECK (
    ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
  );

/* Work cannot finish before it starts. */
ALTER TABLE "TrainingEnrollment"
  ADD CONSTRAINT "training_enrollment_order" CHECK (
    "completedAt" IS NULL OR "startedAt" IS NULL OR "completedAt" >= "startedAt"
  );

/*
  How the assignment came about. A named set rather than free text, because the
  point of recording it is to answer "why is this person enrolled" later, and three
  spellings of "department" would make that unanswerable.
*/
ALTER TABLE "TrainingEnrollment"
  ADD CONSTRAINT "training_enrollment_assigned_via" CHECK (
    "assignedVia" IN ('INDIVIDUAL', 'DEPARTMENT', 'DESIGNATION', 'ONBOARDING')
  );

-- --- TrainingModuleProgress ---------------------------------------------------

ALTER TABLE "TrainingModuleProgress"
  ADD CONSTRAINT "training_progress_order" CHECK (
    "completedAt" IS NULL OR "startedAt" IS NULL OR "completedAt" >= "startedAt"
  );

ALTER TABLE "TrainingModuleProgress"
  ADD CONSTRAINT "training_progress_time_non_negative" CHECK (
    "timeSpentMinutes" IS NULL OR "timeSpentMinutes" >= 0
  );

-- --- TrainingAssessment -------------------------------------------------------

/* Null means "inherit the program's"; a stated one obeys the same range. */
ALTER TABLE "TrainingAssessment"
  ADD CONSTRAINT "training_assessment_passing_score_range" CHECK (
    "passingScore" IS NULL OR ("passingScore" > 0 AND "passingScore" <= 100)
  );

ALTER TABLE "TrainingAssessment"
  ADD CONSTRAINT "training_assessment_attempts_range" CHECK (
    "maxAttempts" IS NULL OR ("maxAttempts" >= 1 AND "maxAttempts" <= 50)
  );

ALTER TABLE "TrainingAssessment"
  ADD CONSTRAINT "training_assessment_time_limit_positive" CHECK (
    "timeLimitMinutes" IS NULL OR "timeLimitMinutes" > 0
  );

-- --- TrainingQuestion ---------------------------------------------------------

/*
  A question is worth something. A zero-point question cannot affect a score, so
  it is either a mistake or a comment pretending to be a question — and it would
  quietly dilute nothing while looking like it counted.
*/
ALTER TABLE "TrainingQuestion"
  ADD CONSTRAINT "training_question_points_positive" CHECK ("points" > 0);

ALTER TABLE "TrainingQuestion"
  ADD CONSTRAINT "training_question_sort_non_negative" CHECK ("sortOrder" >= 0);

ALTER TABLE "TrainingQuestion"
  ADD CONSTRAINT "training_question_prompt_present" CHECK (
    length(btrim("prompt")) > 0
  );

-- --- TrainingQuestionOption ---------------------------------------------------

ALTER TABLE "TrainingQuestionOption"
  ADD CONSTRAINT "training_option_label_present" CHECK (length(btrim("label")) > 0);

ALTER TABLE "TrainingQuestionOption"
  ADD CONSTRAINT "training_option_sort_non_negative" CHECK ("sortOrder" >= 0);

-- --- TrainingAttempt ----------------------------------------------------------

ALTER TABLE "TrainingAttempt"
  ADD CONSTRAINT "training_attempt_number_positive" CHECK ("attemptNumber" >= 1);

/*
  A settled attempt carries its whole result; an unsettled one carries none of it.

  The most important constraint in this migration. Without it a score can exist
  with no pass decision beside it — and then two readers of the same row disagree
  about whether somebody passed, which is the exact question the row exists to
  answer. IN_PROGRESS is the only status allowed to have nothing.
*/
ALTER TABLE "TrainingAttempt"
  ADD CONSTRAINT "training_attempt_result_complete" CHECK (
    ("status" = 'IN_PROGRESS' AND "submittedAt" IS NULL AND "score" IS NULL
      AND "maxScore" IS NULL AND "percentage" IS NULL AND "passed" IS NULL)
    OR ("status" = 'EXPIRED')
    OR (
      "status" IN ('PASSED', 'FAILED')
      AND "submittedAt" IS NOT NULL
      AND "score" IS NOT NULL
      AND "maxScore" IS NOT NULL
      AND "percentage" IS NOT NULL
      AND "passed" IS NOT NULL
    )
  );

/* The status and the boolean say the same thing, so they must agree. */
ALTER TABLE "TrainingAttempt"
  ADD CONSTRAINT "training_attempt_status_matches_passed" CHECK (
    "passed" IS NULL
    OR ("passed" = true AND "status" = 'PASSED')
    OR ("passed" = false AND "status" = 'FAILED')
  );

/* A score cannot exceed what was available, and neither can be negative. */
ALTER TABLE "TrainingAttempt"
  ADD CONSTRAINT "training_attempt_score_within_max" CHECK (
    "score" IS NULL OR "maxScore" IS NULL OR ("score" >= 0 AND "score" <= "maxScore")
  );

ALTER TABLE "TrainingAttempt"
  ADD CONSTRAINT "training_attempt_percentage_range" CHECK (
    "percentage" IS NULL OR ("percentage" >= 0 AND "percentage" <= 100)
  );

ALTER TABLE "TrainingAttempt"
  ADD CONSTRAINT "training_attempt_order" CHECK (
    "submittedAt" IS NULL OR "submittedAt" >= "startedAt"
  );

-- --- TrainingAnswer -----------------------------------------------------------

ALTER TABLE "TrainingAnswer"
  ADD CONSTRAINT "training_answer_points_non_negative" CHECK ("pointsAwarded" >= 0);

/* An incorrect answer scores nothing. The grader sets both; this keeps them honest. */
ALTER TABLE "TrainingAnswer"
  ADD CONSTRAINT "training_answer_incorrect_scores_zero" CHECK (
    "isCorrect" = true OR "pointsAwarded" = 0
  );

-- --- PracticalSubmission ------------------------------------------------------

/*
  A submitted practical knows when it was submitted; an unstarted one does not.
*/
ALTER TABLE "PracticalSubmission"
  ADD CONSTRAINT "practical_submitted_stamp" CHECK (
    ("status" = 'NOT_STARTED') = ("submittedAt" IS NULL)
  );

/*
  A reviewed practical says who reviewed it and when. All three move together, so
  an approval can always be attributed — this is the record that lets somebody
  start live work, and an unattributable approval is worth nothing.
*/
ALTER TABLE "PracticalSubmission"
  ADD CONSTRAINT "practical_review_complete" CHECK (
    ("status" IN ('APPROVED', 'REJECTED'))
      = ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL)
  );

/* A rejection says what to fix, or the learner cannot act on it. */
ALTER TABLE "PracticalSubmission"
  ADD CONSTRAINT "practical_rejection_has_notes" CHECK (
    "status" <> 'REJECTED'
    OR ("reviewNotes" IS NOT NULL AND length(btrim("reviewNotes")) > 0)
  );

-- --- ShadowingRecord ----------------------------------------------------------

ALTER TABLE "ShadowingRecord"
  ADD CONSTRAINT "shadowing_dates_ordered" CHECK (
    "scheduledFrom" IS NULL OR "scheduledTo" IS NULL
    OR "scheduledTo" >= "scheduledFrom"
  );

/*
  A completed shadowing is signed off, by somebody, with something said.

  The sign-off is the gate on live work for this module, so it carries the same
  completeness requirement as the practical approval: who, when, and an account of
  what was observed.
*/
ALTER TABLE "ShadowingRecord"
  ADD CONSTRAINT "shadowing_signoff_complete" CHECK (
    ("status" = 'COMPLETED')
      = ("signedOffAt" IS NOT NULL AND "signedOffById" IS NOT NULL)
  );

ALTER TABLE "ShadowingRecord"
  ADD CONSTRAINT "shadowing_signoff_has_feedback" CHECK (
    "signedOffAt" IS NULL
    OR ("feedback" IS NOT NULL AND length(btrim("feedback")) > 0)
  );

-- --- TrainingQualification ----------------------------------------------------

ALTER TABLE "TrainingQualification"
  ADD CONSTRAINT "training_qualification_score_range" CHECK (
    "finalScore" IS NULL OR ("finalScore" >= 0 AND "finalScore" <= 100)
  );

/*
  Revocation is complete or absent, and says why.

  Revoking somebody's clearance to do live work is as consequential as granting it.
  The record is kept rather than deleted — that somebody was qualified and then was
  not is exactly the history worth having — so it has to be able to explain itself.
*/
ALTER TABLE "TrainingQualification"
  ADD CONSTRAINT "training_qualification_revocation_complete" CHECK (
    ("revokedAt" IS NULL AND "revokedById" IS NULL AND "revocationReason" IS NULL)
    OR (
      "revokedAt" IS NOT NULL
      AND "revokedById" IS NOT NULL
      AND "revocationReason" IS NOT NULL
      AND length(btrim("revocationReason")) > 0
    )
  );

/* A certificate has a date if it has a number, and the reverse. */
ALTER TABLE "TrainingQualification"
  ADD CONSTRAINT "training_qualification_certificate_paired" CHECK (
    ("certificateCode" IS NULL) = ("certificateIssuedAt" IS NULL)
  );

-- --- TrainingCodeCounter ------------------------------------------------------

/* A counter cannot run backwards: a wrong UPDATE becomes a failure, not a reissue. */
ALTER TABLE "TrainingCodeCounter"
  ADD CONSTRAINT "training_counter_non_negative" CHECK ("lastValue" >= 0);
