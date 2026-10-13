-- =============================================================================
--  The HR permission vocabulary: seven AppModule values and three
--  PermissionAction values.
--
--  Enum members only. No table is created, altered or dropped; no row is
--  inserted, updated or deleted.
--
--  SEPARATE FROM THE TABLES on purpose, exactly as LEAD_DEAL was separated
--  before it. Postgres will not let a value added by ALTER TYPE be used inside
--  the same transaction that added it, and the next migration declares
--  `"action" "PermissionAction" NOT NULL DEFAULT 'APPROVE'` — a default that
--  references 'APPROVE'. One migration would fail on that line. Two makes both
--  safe to run in a single deploy.
--
--  `IF NOT EXISTS` on every statement, so re-running this is a no-op.
--
--  ---------------------------------------------------------------------------
--  WHY SEVEN MODULES AND NOT ONE
--
--  HR is the first area where holding one capability must not imply another.
--  The manager who approves leave has no business reading salaries; the
--  recruiter has no business reading appraisals. A single 'HR' value would make
--  every one of those the same grant, and no amount of application code could
--  separate them afterwards without inventing a second permission system.
--
--  These are registered before any HR page exists, deliberately. An AppModule is
--  a permission namespace; a namespace may precede the screen that uses it. That
--  is recorded in MODULES_WITHOUT_NAVIGATION in shared/src/enums.ts and asserted
--  by frontend/__tests__/navigation.test.ts, so an unused namespace is a stated
--  decision rather than an oversight.
--
--  ---------------------------------------------------------------------------
--  WHY THE THREE ACTIONS CHANGE NOTHING FOR EXISTING MODULES
--
--  This is the part worth reading twice, because adding an enum value is exactly
--  the kind of change that widens access by accident.
--
--  Access is resolved in two layers: ROLE_DEFAULTS in permission.service.ts,
--  overridden by UserModulePermission rows. After this migration:
--
--    * ROLE_DEFAULTS grants APPROVE and EXPORT on the seven HR_* namespaces and
--      on nothing else. The nine shipped modules use a constant that lists the
--      original five actions and no others. (It was called ALL, which would have
--      silently stopped meaning "all" the moment these values existed; it is now
--      called CRUD_ASSIGN, and the rename is the point.)
--    * SELF is granted nowhere at all. It narrows access rather than widening
--      it — "your own record only" — so granting it to an administrator who
--      already reads everything would make can(…, 'SELF') true for somebody
--      whose access is not self-scoped, which is the opposite of what any caller
--      asking that question means.
--    * No UserModulePermission row exists for any of these actions, and this
--      migration creates none. An absent row means "use the role default", and
--      the role default for every pre-existing module is false.
--    * The grant UI writes rows from GRANTED_ACTIONS in user.service.ts, which
--      is an explicit allowlist of VIEW, CREATE and EDIT. A newly granted module
--      therefore gets APPROVE/EXPORT/SELF rows that say `allowed = false`.
--
--  So the nine shipped modules retain exactly the effective permissions they
--  had before these three values existed. Nobody gains any capability from this
--  statement. Verified by assertion in
--  backend/src/services/__tests__/hr-permissions.test.ts rather than asserted
--  here in a comment.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

-- --- the seven HR permission namespaces --------------------------------------

ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'HR_EMPLOYEE';
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'HR_ATTENDANCE';
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'HR_LEAVE';
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'HR_PAYROLL';
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'HR_RECRUITMENT';
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'HR_PERFORMANCE';
ALTER TYPE "AppModule" ADD VALUE IF NOT EXISTS 'HR_ADMIN';

-- --- the three new actions ---------------------------------------------------
--
-- APPROVE  deciding somebody else's request. Until now the entire approval
--          "engine" was `requiresApproval = actor.role !== 'ADMIN'` in
--          policies/approval.ts — four lines, with no way to express that a
--          particular person may approve a particular kind of thing.
-- EXPORT   taking data out of the system. Separate from VIEW because reading one
--          payslip on screen and downloading the payroll register are different
--          risks, and only the second leaves the building.
-- SELF     acting on one's own record only. Lets one endpoint serve an employee
--          and their manager without a second route or a second table.

ALTER TYPE "PermissionAction" ADD VALUE IF NOT EXISTS 'APPROVE';
ALTER TYPE "PermissionAction" ADD VALUE IF NOT EXISTS 'EXPORT';
ALTER TYPE "PermissionAction" ADD VALUE IF NOT EXISTS 'SELF';
