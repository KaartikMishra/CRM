-- =============================================================================
--  HR Phase 1 — Employee & Organization.
--
--  Six new tables, seven new enums, and nothing else. No existing table is
--  altered except to add the nullable foreign keys these tables are reached by;
--  no existing column changes type, nullability or default; no row is inserted,
--  updated or deleted anywhere.
--
--  Depends on 20261007120000_hr_notification_types for the NotificationType
--  values the service writes.
--
--  ---------------------------------------------------------------------------
--  EMPLOYEE IS NOT USER
--
--  The central architectural decision, so it is stated here as well as in the
--  schema. `User` is the authenticated application account: an email, a password
--  hash, a role, and the permission rows that decide what it may do. `Employee`
--  is the HR record of a person the business employs.
--
--  They are separate tables joined by an optional 1:1 because the two populations
--  genuinely differ: most employees will never hold a CRM login, and a few logins
--  (a shared operations account) belong to no single person. Folding them into one
--  table would mean either rows with no credentials in a credentials table, or
--  credentials for people who must never sign in.
--
--  No password, session, role or permission exists on Employee. "May this person
--  do X" is always a question about the User and the existing permission resolver.
--
--  `Employee.userId` is UNIQUE, which is the whole safety property: one User maps
--  to at most one Employee and one Employee to at most one User, enforced by the
--  database rather than by a service remembering to check.
--
--  ---------------------------------------------------------------------------
--  WHY A COUNTER TABLE FOR EMPLOYEE IDS
--
--  `EmployeeIdCounter` exists because the obvious implementation is wrong under
--  concurrency. The existing user-management helper does
--  `findMany → max + 1` in application code; two simultaneous creates read the
--  same maximum and produce the same id, and the unique index then fails one of
--  them at random. This is not hypothetical — it is the reason
--  `PostSalesCaseCounter` exists, and this table follows it exactly:
--  INSERT … ON CONFLICT DO UPDATE … RETURNING, inside the creating transaction.
--
--  Keyed on `prefix` rather than being a single row, so the scheme can change
--  without a migration: a second prefix is a second row.
--
--  ---------------------------------------------------------------------------
--  WHAT IS DELIBERATELY NOT COLLECTED
--
--  No date of birth, gender, home address or emergency contact. Each needs a
--  stated purpose, a retention rule and a narrower read scope than "anybody with
--  HR_EMPLOYEE:VIEW", and collecting sensitive personal data before the rules that
--  protect it exist is the easy thing rather than the right one. Payroll, bank and
--  tax data are explicitly out of Phase 1 and have no column here at all.
--
--  ---------------------------------------------------------------------------
--  DELETE SEMANTICS
--
--  Nothing in HR is deleted as a lifecycle operation. An employee who leaves
--  becomes EXITED and keeps every row that references them; a department that is
--  dissolved becomes ARCHIVED. Hence SetNull on almost every foreign key:
--
--    Employee.userId        SetNull   deactivating an account must not delete the person
--    Employee.managerId     SetNull   a manager leaving must not delete their reports
--    Employee.departmentId  SetNull   archiving a department must not delete its people
--    Department.parentId    SetNull   dissolving a parent must not delete its teams
--    Department.headId      SetNull   a department between heads still exists
--
--  The two Cascades are deliberate and narrow: EmployeeHistory and
--  EmployeeDocument are *about* an employee and have no meaning without one.
--
--  EmployeeDocument.uploadedById is Restrict — a confidential document whose
--  uploader is unknown is a document nobody can account for.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

-- --- enums -------------------------------------------------------------------

-- Shared by Department and Designation: the same question about the same kind of
-- record, so one enum rather than two identical ones.
CREATE TYPE "OrgUnitStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- ON_NOTICE is its own state rather than a flag on ACTIVE: somebody serving
-- notice is still employed and still assignable, but not for work that outlives
-- their leaving date. EXITED does not record why — resignation, termination and
-- redundancy carry different process and different confidentiality, and one value
-- pretending to capture all three would be less honest than naming only the fact.
CREATE TYPE "EmployeeStatus" AS ENUM ('PROBATION', 'ACTIVE', 'ON_NOTICE', 'EXITED', 'INACTIVE');

CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT');

CREATE TYPE "WorkMode" AS ENUM ('ON_SITE', 'REMOTE', 'HYBRID');

-- A fixed vocabulary so the timeline can be filtered and a reader can tell a
-- transfer from a promotion without parsing prose. No generic PROFILE_UPDATED: a
-- changed phone number is not an event in somebody's employment, and recording it
-- as one would bury the ones that are.
CREATE TYPE "EmployeeEventType" AS ENUM (
  'JOINED',
  'DEPARTMENT_CHANGED',
  'DESIGNATION_CHANGED',
  'MANAGER_CHANGED',
  'STATUS_CHANGED',
  'EMPLOYMENT_TYPE_CHANGED',
  'WORK_MODE_CHANGED',
  'USER_LINKED',
  'USER_UNLINKED'
);

-- Narrower than SecureDocumentKind, which covers every confidential file the CRM
-- might hold. These are the ones an employee record carries.
CREATE TYPE "EmployeeDocumentType" AS ENUM (
  'IDENTITY_PROOF',
  'ADDRESS_PROOF',
  'EDUCATION_CERTIFICATE',
  'EXPERIENCE_LETTER',
  'OFFER_LETTER',
  'APPOINTMENT_LETTER',
  'CONTRACT',
  'RESUME',
  'OTHER'
);

CREATE TYPE "DocumentVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- --- Department --------------------------------------------------------------

CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "status" "OrgUnitStatus" NOT NULL DEFAULT 'ACTIVE',
    "parentId" TEXT,
    "headId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- `code` is unique and `name` is not: two eras of a company's history can contain
-- two "Operations", and the code is the identifier people quote and reconcile by.
CREATE UNIQUE INDEX "Department_code_key" ON "Department"("code");
CREATE INDEX "Department_status_name_idx" ON "Department"("status", "name");
CREATE INDEX "Department_parentId_idx" ON "Department"("parentId");
CREATE INDEX "Department_headId_idx" ON "Department"("headId");

-- --- Designation ------------------------------------------------------------

CREATE TABLE "Designation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "status" "OrgUnitStatus" NOT NULL DEFAULT 'ACTIVE',
    "departmentId" TEXT,
    -- Seniority, for ordering a list and nothing else. Explicitly NOT an
    -- authority model: a lower number grants nobody rights over a higher one.
    -- Reporting lines are Employee.managerId; permissions are the existing RBAC.
    -- Conflating rank with access is how an org chart quietly becomes a
    -- permission system.
    "level" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Designation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Designation_code_key" ON "Designation"("code");
CREATE INDEX "Designation_status_level_name_idx" ON "Designation"("status", "level", "name");
CREATE INDEX "Designation_departmentId_idx" ON "Designation"("departmentId");

-- --- Employee ---------------------------------------------------------------

CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "userId" TEXT,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "workEmail" TEXT NOT NULL,
    "phone" TEXT,
    "departmentId" TEXT,
    "designationId" TEXT,
    "managerId" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "workMode" "WorkMode" NOT NULL DEFAULT 'ON_SITE',
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "location" TEXT,
    "joiningDate" TIMESTAMP(3) NOT NULL,
    "exitDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Employee_employeeId_key" ON "Employee"("employeeId");
-- The one-to-one guarantee, in both directions, enforced here rather than by a
-- service remembering to check.
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");
-- Work email identifies a colleague; two people cannot share one.
CREATE UNIQUE INDEX "Employee_workEmail_key" ON "Employee"("workEmail");
-- The directory's default ordering and its commonest filters.
CREATE INDEX "Employee_status_lastName_firstName_idx" ON "Employee"("status", "lastName", "firstName");
CREATE INDEX "Employee_departmentId_status_idx" ON "Employee"("departmentId", "status");
CREATE INDEX "Employee_designationId_idx" ON "Employee"("designationId");
CREATE INDEX "Employee_managerId_idx" ON "Employee"("managerId");

-- --- EmployeeIdCounter ------------------------------------------------------

CREATE TABLE "EmployeeIdCounter" (
    "prefix" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeIdCounter_pkey" PRIMARY KEY ("prefix")
);

-- --- EmployeeHistory --------------------------------------------------------

CREATE TABLE "EmployeeHistory" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "eventType" "EmployeeEventType" NOT NULL,
    -- Display strings, not ids — "Sales" rather than a cuid — so the timeline
    -- stays readable after a department is renamed or archived, and so reading it
    -- needs no joins. Never a salary, bank detail, token or secret.
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "performedById" TEXT,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeHistory_pkey" PRIMARY KEY ("id")
);

-- No updatedAt, deliberately: this table is append-only, so a row is what actually
-- happened rather than what somebody later decided it should say.
CREATE INDEX "EmployeeHistory_employeeId_effectiveAt_idx" ON "EmployeeHistory"("employeeId", "effectiveAt");
CREATE INDEX "EmployeeHistory_eventType_idx" ON "EmployeeHistory"("eventType");

-- --- EmployeeDocument -------------------------------------------------------

CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    -- The stored file, in SecureDocument. The bytes are NOT here, and neither is
    -- any URL: Phase 0.5 stores these as authenticated Cloudinary objects and
    -- mints short-lived signed links per request, precisely so no durable link
    -- exists to outlive an access check.
    "secureDocumentId" TEXT NOT NULL,
    "documentType" "EmployeeDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "issuedOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "verificationStatus" "DocumentVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- One stored file is one employee document.
CREATE UNIQUE INDEX "EmployeeDocument_secureDocumentId_key" ON "EmployeeDocument"("secureDocumentId");
CREATE INDEX "EmployeeDocument_employeeId_documentType_idx" ON "EmployeeDocument"("employeeId", "documentType");
CREATE INDEX "EmployeeDocument_verificationStatus_idx" ON "EmployeeDocument"("verificationStatus");
CREATE INDEX "EmployeeDocument_expiresOn_idx" ON "EmployeeDocument"("expiresOn");

-- --- foreign keys -----------------------------------------------------------

ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Department" ADD CONSTRAINT "Department_headId_fkey" FOREIGN KEY ("headId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Designation" ADD CONSTRAINT "Designation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmployeeHistory" ADD CONSTRAINT "EmployeeHistory_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeHistory" ADD CONSTRAINT "EmployeeHistory_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_secureDocumentId_fkey" FOREIGN KEY ("secureDocumentId") REFERENCES "SecureDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- CHECK constraints ------------------------------------------------------
--
-- Paired with Zod schemas in shared/, as every other invariant in this database
-- is: the application rejects bad input with a message somebody can act on, and
-- the database refuses it again so no script, console or future endpoint can write
-- a row that contradicts itself.

-- An employee who has left has a last working day, and one who has not has none.
--
-- The failure this prevents is a record that says somebody left but cannot say
-- when, or one that carries a leaving date while reading as currently employed.
-- Either makes headcount and tenure wrong in a way nobody notices until a report
-- disagrees with reality.
ALTER TABLE "Employee" ADD CONSTRAINT "employee_exit_date_matches_status" CHECK (
  ("status" = 'EXITED' AND "exitDate" IS NOT NULL)
  OR ("status" <> 'EXITED' AND "exitDate" IS NULL)
);

-- Nobody leaves before they arrive.
ALTER TABLE "Employee" ADD CONSTRAINT "employee_exit_after_joining" CHECK (
  "exitDate" IS NULL OR "exitDate" >= "joiningDate"
);

-- Nobody manages themselves.
--
-- The one piece of hierarchy safety a row-local CHECK can express. Longer cycles
-- (A → B → A) need the whole ancestor chain and are refused by the service, where
-- the check can be tested; this closes the trivial case at the lowest level, so a
-- direct self-reference is impossible even from a console.
ALTER TABLE "Employee" ADD CONSTRAINT "employee_not_own_manager" CHECK (
  "managerId" IS NULL OR "managerId" <> "id"
);

-- Names and identifiers must not be blank. Without this, '' and '   ' are both
-- storable and both unreachable by any reader that trims its input.
ALTER TABLE "Employee" ADD CONSTRAINT "employee_names_present" CHECK (
  length(btrim("firstName")) > 0
  AND length(btrim("lastName")) > 0
  AND length(btrim("employeeId")) > 0
  AND length(btrim("workEmail")) > 0
);

-- A department is not its own parent. Deeper cycles are refused by the service.
ALTER TABLE "Department" ADD CONSTRAINT "department_not_own_parent" CHECK (
  "parentId" IS NULL OR "parentId" <> "id"
);

ALTER TABLE "Department" ADD CONSTRAINT "department_name_code_present" CHECK (
  length(btrim("name")) > 0 AND length(btrim("code")) > 0
);

ALTER TABLE "Designation" ADD CONSTRAINT "designation_name_code_present" CHECK (
  length(btrim("name")) > 0 AND length(btrim("code")) > 0
);

-- Seniority is an ordering, not a signed quantity.
ALTER TABLE "Designation" ADD CONSTRAINT "designation_level_non_negative" CHECK ("level" >= 0);

-- A verified or rejected document names who decided and when; a pending one names
-- neither. Same reasoning as the approval trail in Phase 0.5: a decision that
-- cannot say who made it is worthless exactly when somebody needs to audit it.
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "employee_document_verification_consistency" CHECK (
  ("verificationStatus" = 'PENDING' AND "verifiedById" IS NULL AND "verifiedAt" IS NULL)
  OR ("verificationStatus" <> 'PENDING' AND "verifiedById" IS NOT NULL AND "verifiedAt" IS NOT NULL)
);

-- A document does not expire before it was issued.
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "employee_document_expiry_after_issue" CHECK (
  "expiresOn" IS NULL OR "issuedOn" IS NULL OR "expiresOn" >= "issuedOn"
);

ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "employee_document_title_present" CHECK (
  length(btrim("title")) > 0
);

-- A counter counts up from zero.
ALTER TABLE "EmployeeIdCounter" ADD CONSTRAINT "employee_id_counter_non_negative" CHECK ("lastValue" >= 0);
