/**
 * The route table for HR Phase 1 — Employee & Organization.
 *
 * Every route carries `requireAuth` and a `requirePermission`. **No new permission
 * vocabulary is introduced**: the namespaces and actions below all exist from
 * Phase 0.5, and USER holds nothing on either HR namespace by default, so a plain
 * employee reaches this only once an administrator grants it through the existing
 * overrides screen.
 *
 * ### How the two namespaces divide
 *
 *   HR_EMPLOYEE   the people — directory, profile, employment changes, documents
 *   HR_ADMIN      the structure — departments and designations
 *
 * Two rather than one, because they are different jobs with different risk. An HR
 * coordinator who maintains employee records has no reason to restructure the
 * company, and somebody setting up the org chart has no reason to read everyone's
 * identity documents. One namespace would make those the same grant.
 *
 * ### Why the actions land where they do
 *
 *   VIEW      the directory, a profile, history, document metadata
 *   CREATE    adding an employee, a department, a designation
 *   EDIT      employment changes, status, documents, verification requests
 *   ASSIGN    moving somebody's reporting line, and linking an account
 *   APPROVE   verifying a document against its original
 *
 * ASSIGN covers both the manager hierarchy and account linking, following the
 * precedent Lead and Post Sales set: deciding *who owns what* is a different
 * privilege from doing the work. Linking a CRM account to an HR record is exactly
 * that kind of decision, and it is the one HR operation that touches the
 * authentication side of the system.
 *
 * APPROVE on verification because that is what the action means — somebody with
 * authority confirming a claim. It is the first real use of the APPROVE action
 * Phase 0.5 added, and deliberately narrow: nothing else here needs it.
 *
 * ### What has no route, deliberately
 *
 * There is no DELETE on anything. An employee who leaves becomes EXITED; a
 * department that is dissolved becomes ARCHIVED. HR records are the business's
 * history of its people, and an endpoint that erases them would make that history
 * optional. Nor is there an EXPORT route: the action exists, but a payroll-register
 * style export belongs with the data it exports, which is Phase 5.
 *
 * Literal paths are declared before any parameterised one, so `/overview`,
 * `/departments` and `/designations` are never read as employee ids.
 */

import { Router } from 'express';
import {
  assignManagerSchema,
  changeEmployeeStatusSchema,
  createDepartmentSchema,
  createDesignationSchema,
  createEmployeeDocumentSchema,
  createEmployeeSchema,
  departmentListQuerySchema,
  departmentParamSchema,
  designationListQuerySchema,
  designationParamSchema,
  employeeDocumentParamSchema,
  employeeListQuerySchema,
  employeeParamSchema,
  linkEmployeeUserSchema,
  unlinkEmployeeUserSchema,
  updateDepartmentSchema,
  updateDesignationSchema,
  updateEmployeeSchema,
  verifyEmployeeDocumentSchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './hr.controller.js';
import { attendanceRoutes } from './attendance.routes.js';
import { recruitmentRoutes } from './recruitment.routes.js';
import { trainingRoutes } from './training.routes.js';
import { performanceRoutes } from './performance.routes.js';
import { payrollRoutes } from './payroll.routes.js';

export const hrRoutes = Router();

hrRoutes.use(requireAuth);

/*
  HR Phase 2 — Attendance and Leave, mounted FIRST.

  Order matters: Phase 1 declares `/employees/:id`, and Express matches in
  declaration order. Mounting Phase 2 after it would be harmless today because
  Phase 2's paths start with different segments — but the rule this codebase
  follows everywhere is literal-before-parameterised, and putting the newer table
  first keeps that true without anybody having to check which segments collide.

  A separate Router rather than more lines here: the two phases use different
  permission namespaces and different reasoning, and one route file carrying both
  would make neither readable. `requireAuth` above applies to both.
*/
hrRoutes.use(attendanceRoutes);

/*
  HR Phase 3 — Recruitment, Onboarding and Probation, mounted alongside Phase 2 and
  for the same reason: a separate Router, before Phase 1's `/employees/:id`, so the
  literal-before-parameterised rule stays true without anybody having to check which
  segments collide.

  Its paths start `/recruitment`, `/onboarding`, `/onboarding-tasks`, `/probation` and
  `/probation-reviews` — none of which overlaps Phase 1 or Phase 2. `requireAuth`
  above applies to all of them.
*/
hrRoutes.use(recruitmentRoutes);

/*
  HR Phase 4 — Training & Learning Management, mounted alongside Phases 2 and 3 and
  for the same reason: a separate Router, ahead of Phase 1's `/employees/:id`, so the
  literal-before-parameterised rule stays true without anybody checking which
  segments collide.

  Its paths all start `/training`, which overlaps nothing in the earlier phases.
  `requireAuth` above applies to all of them.
*/
hrRoutes.use(trainingRoutes);

/*
  HR Phase 5 — Performance Management, mounted alongside Phases 2, 3 and 4 and for
  the same reason: a separate Router, ahead of Phase 1's `/employees/:id`, so the
  literal-before-parameterised rule stays true without anybody checking which
  segments collide.

  Its paths all start `/performance`, which overlaps nothing in the earlier phases —
  including `/performance/employees/:id/history`, whose first segment keeps it clear
  of Phase 1's `/employees/:id`. `requireAuth` above applies to all of them.
*/
hrRoutes.use(performanceRoutes);

/*
  HR Phase 6 — Payroll & Compensation, mounted on the same basis as Phases 2-5: a
  separate Router, ahead of Phase 1's `/employees/:id`, so the
  literal-before-parameterised rule stays true without anybody checking which
  segments collide.

  Its paths all start `/payroll`, which overlaps nothing in the earlier phases.
  `requireAuth` above applies to all of them, and every route carries its own
  HR_PAYROLL permission — three self-service routes sit on a VIEW floor that the
  service then narrows to the reader's own record. See payroll.routes.ts.
*/
hrRoutes.use(payrollRoutes);

// --- overview ---------------------------------------------------------------

/**
 * The HR landing figures.
 *
 * Either namespace, because the four counts span both: an org administrator
 * needs the department and designation totals, an HR coordinator the headcount.
 * Reading a count is reading.
 */
hrRoutes.get(
  '/overview',
  requireAnyPermission(['HR_EMPLOYEE', 'VIEW'], ['HR_ADMIN', 'VIEW']),
  controller.overview,
);

// --- departments ------------------------------------------------------------

/**
 * Either namespace: an employee form needs the department list to offer a choice,
 * so reading the structure comes with reading the people. The reverse is not true —
 * restructuring the company needs HR_ADMIN specifically.
 */
hrRoutes.get(
  '/departments',
  requireAnyPermission(['HR_ADMIN', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ query: departmentListQuerySchema }),
  controller.listDepartments,
);

hrRoutes.post(
  '/departments',
  requirePermission('HR_ADMIN', 'CREATE'),
  validate({ body: createDepartmentSchema }),
  controller.createDepartment,
);

hrRoutes.get(
  '/departments/:id',
  requireAnyPermission(['HR_ADMIN', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: departmentParamSchema }),
  controller.getDepartment,
);

hrRoutes.patch(
  '/departments/:id',
  requirePermission('HR_ADMIN', 'EDIT'),
  validate({ params: departmentParamSchema, body: updateDepartmentSchema }),
  controller.updateDepartment,
);

// --- designations -----------------------------------------------------------

hrRoutes.get(
  '/designations',
  requireAnyPermission(['HR_ADMIN', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ query: designationListQuerySchema }),
  controller.listDesignations,
);

hrRoutes.post(
  '/designations',
  requirePermission('HR_ADMIN', 'CREATE'),
  validate({ body: createDesignationSchema }),
  controller.createDesignation,
);

hrRoutes.get(
  '/designations/:id',
  requireAnyPermission(['HR_ADMIN', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: designationParamSchema }),
  controller.getDesignation,
);

hrRoutes.patch(
  '/designations/:id',
  requirePermission('HR_ADMIN', 'EDIT'),
  validate({ params: designationParamSchema, body: updateDesignationSchema }),
  controller.updateDesignation,
);

// --- the employee collection ------------------------------------------------

/**
 * The directory.
 *
 * VIEW on HR_EMPLOYEE is *not* the only way in, which is the point of the scope
 * rules in hr-access.ts: a manager who holds no HR permission still reaches this
 * and sees their own reports. The permission here is therefore deliberately
 * permissive and the *scope* does the narrowing — a manager is identified by being
 * somebody's manager, which is a fact about employee rows and cannot be expressed
 * in a route table.
 *
 * `requireAuth` above is the floor: an unauthenticated request never arrives, and
 * a signed-in person with neither HR permission nor any reports receives an empty
 * directory rather than an error.
 */
hrRoutes.get(
  '/employees',
  validate({ query: employeeListQuerySchema }),
  controller.listEmployees,
);

hrRoutes.post(
  '/employees',
  requirePermission('HR_EMPLOYEE', 'CREATE'),
  validate({ body: createEmployeeSchema }),
  controller.createEmployee,
);

// --- one employee -----------------------------------------------------------

/** Scoped the same way the directory is — see the note above. */
hrRoutes.get(
  '/employees/:id',
  validate({ params: employeeParamSchema }),
  controller.getEmployee,
);

hrRoutes.get(
  '/employees/:id/history',
  validate({ params: employeeParamSchema }),
  controller.getEmployeeHistory,
);

hrRoutes.patch(
  '/employees/:id',
  requirePermission('HR_EMPLOYEE', 'EDIT'),
  validate({ params: employeeParamSchema, body: updateEmployeeSchema }),
  controller.updateEmployee,
);

/**
 * Moving somebody's reporting line. ASSIGN, deliberately not EDIT.
 *
 * A manager who may see their team may not re-grade them or move them — a
 * reporting line is not authority over somebody's employment terms.
 */
hrRoutes.post(
  '/employees/:id/manager',
  requirePermission('HR_EMPLOYEE', 'ASSIGN'),
  validate({ params: employeeParamSchema, body: assignManagerSchema }),
  controller.assignManager,
);

/** Employment status. EDIT: this is HR doing its own work. */
hrRoutes.post(
  '/employees/:id/status',
  requirePermission('HR_EMPLOYEE', 'EDIT'),
  validate({ params: employeeParamSchema, body: changeEmployeeStatusSchema }),
  controller.changeStatus,
);

// --- account linking --------------------------------------------------------
//
// ASSIGN on both: tying a login to a person is the one HR operation that touches
// the authentication side of the system, and it is a decision about who somebody
// *is* rather than about their employment terms.
//
// Neither route creates an account, sets a password or grants a permission. They
// set and clear `Employee.userId` and nothing else — creating logins is user
// management's job, through its own audited endpoint.

hrRoutes.post(
  '/employees/:id/user',
  requirePermission('HR_EMPLOYEE', 'ASSIGN'),
  validate({ params: employeeParamSchema, body: linkEmployeeUserSchema }),
  controller.linkUser,
);

hrRoutes.delete(
  '/employees/:id/user',
  requirePermission('HR_EMPLOYEE', 'ASSIGN'),
  validate({ params: employeeParamSchema, body: unlinkEmployeeUserSchema }),
  controller.unlinkUser,
);

// --- documents --------------------------------------------------------------

/**
 * Records an already-uploaded confidential file.
 *
 * The bytes go through the secure-document service, which is the one place binary
 * data is handled for HR and which stores them as authenticated Cloudinary objects
 * with no public URL. This records that the file belongs to this employee.
 */
hrRoutes.post(
  '/employees/:id/documents',
  requirePermission('HR_EMPLOYEE', 'EDIT'),
  validate({ params: employeeParamSchema, body: createEmployeeDocumentSchema }),
  controller.addDocument,
);

/** Confirming a document against its original. APPROVE — see the note at the top. */
hrRoutes.post(
  '/employees/:id/documents/:documentId/verify',
  requirePermission('HR_EMPLOYEE', 'APPROVE'),
  validate({ params: employeeDocumentParamSchema, body: verifyEmployeeDocumentSchema }),
  controller.verifyDocument,
);

/**
 * A short-lived signed link to one document.
 *
 * VIEW on HR_EMPLOYEE, and deliberately not reachable through the manager scope:
 * an identity proof or a contract is confidential in a way a department name is
 * not, so a manager sees who is on their team and not their team's passports.
 * Every call is audited as an access event.
 */
hrRoutes.get(
  '/employees/:id/documents/:documentId/link',
  requirePermission('HR_EMPLOYEE', 'VIEW'),
  validate({ params: employeeDocumentParamSchema }),
  controller.documentLink,
);
