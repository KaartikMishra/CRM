-- =============================================================================
--  HR Phase 2 — Attendance & Leave.
--
--  Ten new tables, eight new enums. No existing table is altered except to add
--  the nullable foreign keys these tables are reached by; no existing column
--  changes type, nullability or default; no row is inserted, updated or deleted.
--
--  Every record references the Phase 1 `Employee`. There is no second employee,
--  department or manager hierarchy, no second approval engine, no second audit or
--  notification system.
--
--  ---------------------------------------------------------------------------
--  TIME: THE DECISION THIS WHOLE MIGRATION RESTS ON
--
--  Two kinds of value, typed differently on purpose:
--
--    DATE      attendanceDate, startDate, holidayDate, overtimeDate.
--              Calendar days, `@db.Date`. Interpreted in IST (+5:30 fixed), the
--              timezone the business works in — the same convention
--              sales-efficiency.ts uses for dispatch deadlines and
--              frontend/lib/format.ts uses to render every timestamp. India
--              observes no daylight saving, so a constant offset is exact.
--
--    TIMESTAMP clockInAt, clockOutAt, startedAt, decidedAt.
--              Real moments, always taken from Postgres `now()` through
--              databaseNow(). A client-supplied time is NEVER authoritative: a
--              browser clock can be wrong by hours or set deliberately, and
--              attendance is exactly the feature somebody would try that on.
--
--  Conflating the two is the classic attendance bug. 00:30 IST belongs to today's
--  attendanceDate but is 19:00 UTC *yesterday*; truncating the instant to a UTC
--  day would file it against the wrong date for every late-evening shift.
--
--  ---------------------------------------------------------------------------
--  WHY SOME DERIVED VALUES ARE STORED HERE
--
--  This codebase's standing rule is derive-don't-store, and Phase 2 deliberately
--  breaks it for workedMinutes, lateMinutes, earlyExitMinutes, overtimeMinutes
--  and requestedDays. The reason is that their inputs are *policy*, and policy
--  legitimately changes: recomputing a 2024 attendance day against 2026's
--  expected hours, or restating how much leave somebody took against a holiday
--  calendar edited since, would silently rewrite history. These are frozen facts
--  about what happened under the rules in force at the time.
--
--  `available` leave balance is NOT stored, for the opposite reason: its inputs
--  are all in the same row and never change retroactively, so a stored copy would
--  be a fifth number free to disagree with the four it comes from.
--
--  ---------------------------------------------------------------------------
--  WHY A LEDGER BESIDE THE BALANCE
--
--  LeaveBalance holds six columns and LeaveLedgerEntry holds every movement.
--  Both exist because each answers a question the other cannot: the balance
--  answers "how much is left" in one indexed read, and the ledger answers "why" —
--  which is the question that actually gets asked when somebody disputes a number.
--  A balance that is the sum of an append-only ledger can always be explained and
--  a wrong one traced to the row that caused it; a bare number somebody edited
--  cannot be defended.
--
--  ---------------------------------------------------------------------------
--  CONCURRENCY, ENFORCED BY THE DATABASE
--
--  Application checks alone cannot stop two simultaneous requests — both read
--  "no record" and both insert. So:
--
--    AttendanceRecord(employeeId, attendanceDate) UNIQUE
--        makes a double clock-in impossible. Two concurrent clock-ins: one wins,
--        the other gets a unique violation the service turns into a clear error.
--
--    one open break per record, PARTIAL UNIQUE on (recordId) WHERE endedAt IS NULL
--        makes a double break-start impossible.
--
--    OvertimeRecord(employeeId, overtimeDate) UNIQUE
--    LeaveBalance(employeeId, leaveTypeId, periodYear) UNIQUE
--    LeavePolicy(leaveTypeId, departmentId) UNIQUE
--    LeaveType.code / AttendancePolicy.code UNIQUE
--
--    Holiday: PARTIAL UNIQUE indexes, because a plain composite unique cannot
--        express "one company-wide holiday per date" — NULLs never collide in
--        Postgres, so (date, NULL) could be inserted twice.
--
--    AttendancePolicy.isDefault: PARTIAL UNIQUE, so exactly one default exists.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

-- --- enums -------------------------------------------------------------------

-- Status and work mode are separate enums on purpose: "present" and "worked from
-- home" are different questions, and one enum carrying both would make "present
-- in the office" and "present at home" different statuses, so every query about
-- presence would have to enumerate work modes.
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEK_OFF');

-- Deliberately NOT the Phase 1 "WorkMode" (ON_SITE/REMOTE/HYBRID), which is the
-- employee's contractual arrangement. A HYBRID employee works some days in the
-- office and some at home, so a HYBRID value on an attendance row would say
-- nothing about that particular day.
CREATE TYPE "AttendanceWorkMode" AS ENUM ('OFFICE', 'WFH', 'REMOTE');

-- The session state machine. This is what makes clock-in/clock-out/break
-- transitions decidable rather than inferred from which timestamps are null.
CREATE TYPE "AttendanceSessionState" AS ENUM ('OPEN', 'ON_BREAK', 'CLOSED', 'NONE');

-- An auto-resolved ABSENT and a manually corrected one are very different claims,
-- and a future Payroll phase must be able to tell them apart.
CREATE TYPE "AttendanceSource" AS ENUM ('SELF', 'SYSTEM', 'MANUAL', 'CORRECTION');

CREATE TYPE "AttendanceCorrectionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TYPE "OvertimeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- "Half a day off" without saying which half cannot be rostered against, which is
-- why a CHECK below pairs this with isHalfDay.
CREATE TYPE "HalfDayPeriod" AS ENUM ('FIRST_HALF', 'SECOND_HALF');

-- The ledger's vocabulary. Every balance movement is one of these, so a balance is
-- always explainable by replaying its rows.
CREATE TYPE "LeaveLedgerReason" AS ENUM (
  'ALLOCATION',
  'ACCRUAL',
  'CARRY_FORWARD',
  'RESERVATION',
  'RESERVATION_RELEASE',
  'CONSUMPTION',
  'CONSUMPTION_REVERSAL',
  'ADJUSTMENT',
  'LAPSE'
);

-- --- AttendancePolicy -------------------------------------------------------

CREATE TABLE "AttendancePolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    -- Minutes from midnight IST, not timestamps: "09:30" is a wall-clock rule
    -- that applies every day, and storing it as a Date would attach it to one.
    "expectedStartMinute" INTEGER NOT NULL DEFAULT 570,
    "expectedEndMinute" INTEGER NOT NULL DEFAULT 1110,
    "graceMinutes" INTEGER NOT NULL DEFAULT 15,
    "fullDayMinutes" INTEGER NOT NULL DEFAULT 480,
    "halfDayMinutes" INTEGER NOT NULL DEFAULT 240,
    "overtimeThresholdMinutes" INTEGER NOT NULL DEFAULT 540,
    -- ISO weekday numbers (1=Mon … 7=Sun). An array rather than seven booleans or
    -- a table: the pattern is read as a whole and never queried by single day.
    -- Deliberately not assumed — plenty of businesses work Saturdays.
    "weekOffDays" INTEGER[] DEFAULT ARRAY[6, 7],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendancePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttendancePolicy_code_key" ON "AttendancePolicy"("code");
CREATE UNIQUE INDEX "AttendancePolicy_departmentId_key" ON "AttendancePolicy"("departmentId");
CREATE INDEX "AttendancePolicy_isActive_idx" ON "AttendancePolicy"("isActive");

-- Exactly one company default. A plain unique on isDefault would forbid more than
-- one `false`, which is the opposite of what is wanted.
CREATE UNIQUE INDEX "attendance_policy_single_default" ON "AttendancePolicy"("isDefault")
  WHERE "isDefault" = true;

-- --- Holiday ----------------------------------------------------------------

CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "holidayDate" DATE NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Holiday_holidayDate_isActive_idx" ON "Holiday"("holidayDate", "isActive");
CREATE INDEX "Holiday_departmentId_idx" ON "Holiday"("departmentId");

-- Two partial indexes rather than one composite unique, because NULLs never
-- collide in Postgres: (date, NULL) could otherwise be inserted twice, giving two
-- company-wide holidays on the same day.
CREATE UNIQUE INDEX "holiday_unique_company_wide" ON "Holiday"("holidayDate")
  WHERE "departmentId" IS NULL;
CREATE UNIQUE INDEX "holiday_unique_per_department" ON "Holiday"("holidayDate", "departmentId")
  WHERE "departmentId" IS NOT NULL;

-- --- LeaveType --------------------------------------------------------------

CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    -- Recorded for a future Payroll phase. Phase 2 computes no money from it.
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "halfDayAllowed" BOOLEAN NOT NULL DEFAULT true,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "accrualEnabled" BOOLEAN NOT NULL DEFAULT false,
    "carryForwardEnabled" BOOLEAN NOT NULL DEFAULT false,
    -- Null means unlimited, which is different from zero.
    "carryForwardLimit" DECIMAL(5,2),
    -- Foundation only: the flag is stored and no payout is implemented.
    "encashmentAllowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaveType_code_key" ON "LeaveType"("code");
CREATE INDEX "LeaveType_isActive_name_idx" ON "LeaveType"("isActive", "name");

-- --- LeavePolicy ------------------------------------------------------------

CREATE TABLE "LeavePolicy" (
    "id" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "departmentId" TEXT,
    -- Decimal because half days are real.
    "annualEntitlement" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "accrualPerPeriod" DECIMAL(5,2),
    "minNoticeDays" INTEGER NOT NULL DEFAULT 0,
    -- Null means no limit.
    "maxConsecutiveDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeavePolicy_leaveTypeId_departmentId_key" ON "LeavePolicy"("leaveTypeId", "departmentId");
CREATE INDEX "LeavePolicy_isActive_idx" ON "LeavePolicy"("isActive");

-- --- LeaveRequest -----------------------------------------------------------

CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "isHalfDay" BOOLEAN NOT NULL DEFAULT false,
    "halfDayPeriod" "HalfDayPeriod",
    -- Working days, holidays and week-offs excluded. Computed once by the shared
    -- calculator and frozen: recomputing later against an edited holiday calendar
    -- would silently restate how much leave somebody took.
    "requestedDays" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeaveRequest_employeeId_startDate_idx" ON "LeaveRequest"("employeeId", "startDate");
CREATE INDEX "LeaveRequest_employeeId_status_idx" ON "LeaveRequest"("employeeId", "status");
CREATE INDEX "LeaveRequest_status_startDate_idx" ON "LeaveRequest"("status", "startDate");
CREATE INDEX "LeaveRequest_leaveTypeId_idx" ON "LeaveRequest"("leaveTypeId");

-- --- LeaveBalance -----------------------------------------------------------

CREATE TABLE "LeaveBalance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    -- A plain year, because every policy here is annual. A mid-year policy change
    -- does not create a second period.
    "periodYear" INTEGER NOT NULL,
    "allocated" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "accrued" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "carriedForward" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "used" DECIMAL(6,2) NOT NULL DEFAULT 0,
    -- Held by pending requests, so two of them cannot both be approved into the
    -- same remaining day.
    "reserved" DECIMAL(6,2) NOT NULL DEFAULT 0,
    -- Signed: an HR correction may add or remove.
    "adjusted" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaveBalance_employeeId_leaveTypeId_periodYear_key" ON "LeaveBalance"("employeeId", "leaveTypeId", "periodYear");
CREATE INDEX "LeaveBalance_employeeId_periodYear_idx" ON "LeaveBalance"("employeeId", "periodYear");

-- --- LeaveLedgerEntry -------------------------------------------------------

CREATE TABLE "LeaveLedgerEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "reason" "LeaveLedgerReason" NOT NULL,
    -- Signed: positive adds, negative takes away.
    "days" DECIMAL(6,2) NOT NULL,
    "leaveRequestId" TEXT,
    "note" TEXT,
    -- Null for system accrual.
    "performedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- No updatedAt, deliberately: append-only. A correction is a new row, not an edit.
CREATE INDEX "LeaveLedgerEntry_employeeId_leaveTypeId_periodYear_idx" ON "LeaveLedgerEntry"("employeeId", "leaveTypeId", "periodYear");
CREATE INDEX "LeaveLedgerEntry_leaveRequestId_idx" ON "LeaveLedgerEntry"("leaveRequestId");

-- --- AttendanceRecord -------------------------------------------------------

CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    -- The IST calendar day, stored at midnight UTC. Not an instant.
    "attendanceDate" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "workMode" "AttendanceWorkMode",
    "sessionState" "AttendanceSessionState" NOT NULL DEFAULT 'NONE',
    "source" "AttendanceSource" NOT NULL DEFAULT 'SYSTEM',
    -- Real moments, always from Postgres now().
    "clockInAt" TIMESTAMP(3),
    "clockOutAt" TIMESTAMP(3),
    -- Frozen at clock-out: see the note at the top on why these are stored.
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyExitMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "leaveRequestId" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- THE constraint that makes clock-in concurrency-safe. Two simultaneous
-- clock-ins both read "no record"; one insert wins and the other gets a unique
-- violation the service turns into a clear "already clocked in".
CREATE UNIQUE INDEX "AttendanceRecord_employeeId_attendanceDate_key" ON "AttendanceRecord"("employeeId", "attendanceDate");
CREATE INDEX "AttendanceRecord_employeeId_attendanceDate_idx" ON "AttendanceRecord"("employeeId", "attendanceDate");
CREATE INDEX "AttendanceRecord_attendanceDate_status_idx" ON "AttendanceRecord"("attendanceDate", "status");
CREATE INDEX "AttendanceRecord_leaveRequestId_idx" ON "AttendanceRecord"("leaveRequestId");

-- --- AttendanceBreak --------------------------------------------------------

CREATE TABLE "AttendanceBreak" (
    "id" TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "minutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceBreak_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttendanceBreak_attendanceRecordId_startedAt_idx" ON "AttendanceBreak"("attendanceRecordId", "startedAt");

-- At most one open break per attendance record, enforced by the database rather
-- than by an application check that two concurrent requests would both pass.
CREATE UNIQUE INDEX "attendance_break_single_open" ON "AttendanceBreak"("attendanceRecordId")
  WHERE "endedAt" IS NULL;

-- --- AttendanceCorrectionRequest --------------------------------------------

CREATE TABLE "AttendanceCorrectionRequest" (
    "id" TEXT NOT NULL,
    "attendanceRecordId" TEXT,
    "employeeId" TEXT NOT NULL,
    -- Kept even when there is no record, because the commonest correction is for
    -- a day with no attendance row at all.
    "attendanceDate" DATE NOT NULL,
    -- What the record held when the request was raised: evidence for the reviewer
    -- and afterwards, without the record having to be mutated first.
    "currentClockInAt" TIMESTAMP(3),
    "currentClockOutAt" TIMESTAMP(3),
    "requestedClockInAt" TIMESTAMP(3),
    "requestedClockOutAt" TIMESTAMP(3),
    "requestedWorkMode" "AttendanceWorkMode",
    "reason" TEXT NOT NULL,
    "status" "AttendanceCorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceCorrectionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttendanceCorrectionRequest_employeeId_attendanceDate_idx" ON "AttendanceCorrectionRequest"("employeeId", "attendanceDate");
CREATE INDEX "AttendanceCorrectionRequest_status_createdAt_idx" ON "AttendanceCorrectionRequest"("status", "createdAt");

-- Only one undecided correction per employee per date. Without this, somebody
-- could raise five requests for the same day and five reviewers could decide them
-- independently, each overwriting the last.
CREATE UNIQUE INDEX "attendance_correction_single_pending" ON "AttendanceCorrectionRequest"("employeeId", "attendanceDate")
  WHERE "status" = 'PENDING';

-- --- OvertimeRecord ---------------------------------------------------------

CREATE TABLE "OvertimeRecord" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "overtimeDate" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "status" "OvertimeStatus" NOT NULL DEFAULT 'PENDING',
    "source" "AttendanceSource" NOT NULL DEFAULT 'SYSTEM',
    "remarks" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OvertimeRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OvertimeRecord_employeeId_overtimeDate_key" ON "OvertimeRecord"("employeeId", "overtimeDate");
CREATE INDEX "OvertimeRecord_status_overtimeDate_idx" ON "OvertimeRecord"("status", "overtimeDate");

-- --- foreign keys -----------------------------------------------------------
--
-- Cascade from Employee on the records that are *about* an employee and have no
-- meaning without one. SetNull on every decider, so a departed reviewer's
-- decision stays readable rather than deleting the trail. Restrict on
-- LeaveRequest.leaveTypeId: a type with requests against it is referenced
-- history and must be deactivated rather than removed.

ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "AttendancePolicy_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AttendanceBreak" ADD CONSTRAINT "AttendanceBreak_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OvertimeRecord" ADD CONSTRAINT "OvertimeRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OvertimeRecord" ADD CONSTRAINT "OvertimeRecord_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- CHECK constraints ------------------------------------------------------
--
-- Paired with Zod schemas, as every other invariant in this database is: the
-- application rejects bad input with a message somebody can act on, and the
-- database refuses it again so no script, console or future endpoint can write a
-- row that contradicts itself.

-- Minutes are durations, and a negative duration is a bug upstream, not a row.
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "attendance_minutes_non_negative" CHECK (
  "workedMinutes" >= 0 AND "breakMinutes" >= 0 AND "lateMinutes" >= 0
  AND "earlyExitMinutes" >= 0 AND "overtimeMinutes" >= 0
);

-- Nobody clocks out before clocking in.
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "attendance_clock_out_after_in" CHECK (
  "clockOutAt" IS NULL OR "clockInAt" IS NULL OR "clockOutAt" >= "clockInAt"
);

-- A clock-out with no clock-in is not a day anybody worked.
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "attendance_clock_out_needs_in" CHECK (
  "clockOutAt" IS NULL OR "clockInAt" IS NOT NULL
);

-- The session state machine, enforced rather than assumed:
--   OPEN / ON_BREAK  must have a clock-in and no clock-out
--   CLOSED           must have both
--   NONE             must have neither — a holiday, week-off or leave row
--
-- This is what makes "clocked in twice" and "clocked out without clocking in"
-- unrepresentable rather than merely rejected by a service.
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "attendance_session_state_consistency" CHECK (
  ("sessionState" IN ('OPEN', 'ON_BREAK') AND "clockInAt" IS NOT NULL AND "clockOutAt" IS NULL)
  OR ("sessionState" = 'CLOSED' AND "clockInAt" IS NOT NULL AND "clockOutAt" IS NOT NULL)
  OR ("sessionState" = 'NONE' AND "clockInAt" IS NULL AND "clockOutAt" IS NULL)
);

-- Breaks cannot exceed the session they sit in. Checked at clock-out, when both
-- numbers are known.
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "attendance_break_within_session" CHECK (
  "clockOutAt" IS NULL
  OR "breakMinutes" <= CEIL(EXTRACT(EPOCH FROM ("clockOutAt" - "clockInAt")) / 60) + 1
);

-- A break ends after it starts, and its duration is non-negative.
ALTER TABLE "AttendanceBreak" ADD CONSTRAINT "attendance_break_end_after_start" CHECK (
  "endedAt" IS NULL OR "endedAt" >= "startedAt"
);
ALTER TABLE "AttendanceBreak" ADD CONSTRAINT "attendance_break_minutes_non_negative" CHECK (
  "minutes" IS NULL OR "minutes" >= 0
);
-- An ended break has a duration and an open one does not.
ALTER TABLE "AttendanceBreak" ADD CONSTRAINT "attendance_break_minutes_paired" CHECK (
  ("endedAt" IS NULL AND "minutes" IS NULL) OR ("endedAt" IS NOT NULL AND "minutes" IS NOT NULL)
);

-- A decided correction names who decided and when; a pending one names neither.
-- Same reasoning as the Phase 0.5 approval trail: a decision that cannot say who
-- made it is worthless exactly when somebody needs to audit it.
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "attendance_correction_decision_consistency" CHECK (
  ("status" IN ('PENDING', 'CANCELLED') AND "decidedById" IS NULL AND "decidedAt" IS NULL)
  OR ("status" IN ('APPROVED', 'REJECTED') AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
);

-- A rejection must say why. "No" with no reason is the commonest complaint about
-- every approval system.
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "attendance_correction_rejection_needs_note" CHECK (
  "status" <> 'REJECTED' OR ("decisionNote" IS NOT NULL AND length(btrim("decisionNote")) > 0)
);

ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "attendance_correction_reason_present" CHECK (
  length(btrim("reason")) > 0
);

-- A correction that asks for nothing is not a correction.
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "attendance_correction_requests_something" CHECK (
  "requestedClockInAt" IS NOT NULL OR "requestedClockOutAt" IS NOT NULL OR "requestedWorkMode" IS NOT NULL
);

ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "attendance_correction_times_ordered" CHECK (
  "requestedClockOutAt" IS NULL OR "requestedClockInAt" IS NULL
  OR "requestedClockOutAt" >= "requestedClockInAt"
);

-- Leave ends on or after it starts.
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_end_after_start" CHECK ("endDate" >= "startDate");

-- A half day is a single date, and names which half. "Half a day off" spanning a
-- week, or without saying which half, cannot be rostered against.
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_half_day_single_date" CHECK (
  NOT "isHalfDay" OR ("startDate" = "endDate" AND "halfDayPeriod" IS NOT NULL)
);
-- And a full-day request never carries a half-day period.
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_half_day_period_paired" CHECK (
  "isHalfDay" OR "halfDayPeriod" IS NULL
);

-- A request for no days is not a request.
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_requested_days_positive" CHECK ("requestedDays" > 0);

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_reason_present" CHECK (length(btrim("reason")) > 0);

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_decision_consistency" CHECK (
  ("status" IN ('PENDING', 'CANCELLED') AND "decidedById" IS NULL AND "decidedAt" IS NULL)
  OR ("status" IN ('APPROVED', 'REJECTED') AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
);

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_rejection_needs_note" CHECK (
  "status" <> 'REJECTED' OR ("decisionNote" IS NOT NULL AND length(btrim("decisionNote")) > 0)
);

-- A cancelled request records when, and a live one does not.
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "leave_cancelled_stamped" CHECK (
  ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
  OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL)
);

-- Balance components are counts of days. `adjusted` is deliberately excluded —
-- it is signed, because an HR correction may remove days as well as add them.
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "leave_balance_components_non_negative" CHECK (
  "allocated" >= 0 AND "accrued" >= 0 AND "carriedForward" >= 0
  AND "used" >= 0 AND "reserved" >= 0
);

ALTER TABLE "LeaveBalance" ADD CONSTRAINT "leave_balance_period_sane" CHECK (
  "periodYear" >= 2000 AND "periodYear" <= 2200
);

-- A ledger row of zero days explains nothing.
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "leave_ledger_days_non_zero" CHECK ("days" <> 0);

ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "leave_ledger_period_sane" CHECK (
  "periodYear" >= 2000 AND "periodYear" <= 2200
);

ALTER TABLE "LeaveType" ADD CONSTRAINT "leave_type_name_code_present" CHECK (
  length(btrim("name")) > 0 AND length(btrim("code")) > 0
);

-- A carry-forward limit is a number of days, or absent meaning unlimited.
ALTER TABLE "LeaveType" ADD CONSTRAINT "leave_type_carry_forward_limit_non_negative" CHECK (
  "carryForwardLimit" IS NULL OR "carryForwardLimit" >= 0
);

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "leave_policy_values_sane" CHECK (
  "annualEntitlement" >= 0
  AND "minNoticeDays" >= 0
  AND ("accrualPerPeriod" IS NULL OR "accrualPerPeriod" >= 0)
  AND ("maxConsecutiveDays" IS NULL OR "maxConsecutiveDays" > 0)
);

-- Policy times are minutes within a day, and the day ends after it starts.
ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "attendance_policy_minutes_in_day" CHECK (
  "expectedStartMinute" >= 0 AND "expectedStartMinute" < 1440
  AND "expectedEndMinute" > 0 AND "expectedEndMinute" <= 1440
  AND "expectedEndMinute" > "expectedStartMinute"
);

ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "attendance_policy_thresholds_sane" CHECK (
  "graceMinutes" >= 0
  AND "halfDayMinutes" > 0
  AND "fullDayMinutes" > "halfDayMinutes"
  AND "overtimeThresholdMinutes" > 0
);

ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "attendance_policy_name_code_present" CHECK (
  length(btrim("name")) > 0 AND length(btrim("code")) > 0
);

ALTER TABLE "Holiday" ADD CONSTRAINT "holiday_name_present" CHECK (length(btrim("name")) > 0);

ALTER TABLE "OvertimeRecord" ADD CONSTRAINT "overtime_minutes_positive" CHECK ("minutes" > 0);

ALTER TABLE "OvertimeRecord" ADD CONSTRAINT "overtime_decision_consistency" CHECK (
  ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL)
  OR ("status" <> 'PENDING' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
);
