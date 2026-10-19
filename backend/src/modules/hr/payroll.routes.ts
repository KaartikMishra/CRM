/**
 * The payroll route table — the permission each endpoint needs, and nothing else.
 *
 * ### Every route is gated. None is gated by the UI.
 *
 * Hiding a button is not authorization. Every route below carries either
 * `requirePermission('HR_PAYROLL', …)` or the `SELF_FLOOR` described next, and
 * the service then re-checks scope and separation of duties on the specific
 * record. Two layers, because the route table cannot know whose salary a row is.
 *
 * ### `SELF_FLOOR` looks permissive and is not
 *
 * Three endpoints — the dashboard, an employee's own pay, and one payslip — are
 * gated on `HR_PAYROLL:VIEW` **or** `HR_EMPLOYEE:VIEW`, the same floor Phase 5
 * used for self-assessments.
 *
 * The reason is structural: **everybody is paid.** An employee reading their own
 * payslip holds no payroll grant, and requiring one would mean granting
 * HR_PAYROLL to the whole company — at which point the grant stops distinguishing
 * anybody and the module's confidentiality is gone. So the floor lets them reach
 * the route, and the service then returns only their own record:
 *
 *   - `GET /payroll/mine` takes **no employee id at all**. There is no way to ask
 *     it about somebody else, which is a stronger guarantee than checking an id.
 *   - `GET /payroll/payslips/:itemId` resolves ownership from `Employee.userId`
 *     against the actor and returns **404** for anything else, so a probe cannot
 *     even confirm that another employee's payslip exists.
 *   - `GET /payroll/overview` returns an aggregate-free shape for a reader
 *     without VIEW — their own latest payslip and nothing about the company.
 *
 * ### Why the grants split the way they do
 *
 *   VIEW     read other people's pay, periods, items, summaries
 *   CREATE   define components and structures, open a period
 *   EDIT     cost a run, recalculate, exclude an employee, submit for approval
 *   ASSIGN   put a salary figure against a named person — deliberately not EDIT
 *   APPROVE  decide, finalise, cancel, record an adjustment
 *   EXPORT   download the register — deliberately not VIEW
 *
 * EXPORT being separate is the one worth defending. Reading one payslip on
 * screen and downloading every salary in the company are different risks, and
 * only the second leaves the building. An administrator whose EXPORT has been
 * revoked by a per-user override can still read payroll and cannot download it,
 * which is the entire point of the two being distinct.
 *
 * ### Literal paths before parameterised ones
 *
 * `/payroll/periods/mine` would be parsed as `/payroll/periods/:id` if it came
 * second. Every literal segment below is declared before the `:id` route that
 * could swallow it, which is the convention the whole codebase follows.
 */

import { Router } from 'express';
import {
  assignEmployeeSalarySchema,
  calculatePayrollSchema,
  cancelPayrollSchema,
  createPayrollAdjustmentSchema,
  createPayrollPeriodSchema,
  createSalaryComponentSchema,
  createSalaryStructureSchema,
  decidePayrollSchema,
  employeeSalaryQuerySchema,
  excludePayrollItemSchema,
  finalizePayrollSchema,
  paginationSchema,
  payrollComponentParamSchema,
  payrollExportQuerySchema,
  payrollItemListQuerySchema,
  payrollItemParamSchema,
  payrollPeriodListQuerySchema,
  payrollPeriodParamSchema,
  payslipParamSchema,
  salaryComponentListQuerySchema,
  submitPayrollSchema,
  updatePayrollPeriodSchema,
  updateSalaryComponentSchema,
  updateSalaryStructureSchema,
} from '@rs/shared';
import { validate } from '../../middleware/validate.js';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import * as controller from './payroll.controller.js';

export const payrollRoutes = Router();

/**
 * The floor for self-service: either payroll access, or simply being staff.
 *
 * See the note at the top of this file. The service refuses anybody who is not
 * the subject, including an administrator holding every grant.
 */
const SELF_FLOOR = [
  ['HR_PAYROLL', 'VIEW'],
  ['HR_EMPLOYEE', 'VIEW'],
] as const;

// ---------------------------------------------------------------------------
//  Dashboard and self-service — declared first, all literal paths
// ---------------------------------------------------------------------------

payrollRoutes.get(
  '/payroll/overview',
  requireAnyPermission(...SELF_FLOOR),
  controller.getOverview,
);

/**
 * An employee's own pay.
 *
 * Takes no employee id. There is deliberately no `/payroll/employees/:id/pay`
 * equivalent for self-service — the absence of a parameter is what makes
 * cross-employee access impossible here rather than merely checked.
 */
payrollRoutes.get('/payroll/mine', requireAnyPermission(...SELF_FLOOR), controller.getMyPayroll);

payrollRoutes.get(
  '/payroll/payslips/:itemId',
  requireAnyPermission(...SELF_FLOOR),
  validate({ params: payslipParamSchema }),
  controller.getPayslip,
);

// ---------------------------------------------------------------------------
//  Salary components
// ---------------------------------------------------------------------------

payrollRoutes.get(
  '/payroll/components',
  requirePermission('HR_PAYROLL', 'VIEW'),
  validate({ query: salaryComponentListQuerySchema }),
  controller.listComponents,
);

payrollRoutes.post(
  '/payroll/components',
  requirePermission('HR_PAYROLL', 'CREATE'),
  validate({ body: createSalaryComponentSchema }),
  controller.createComponent,
);

payrollRoutes.patch(
  '/payroll/components/:id',
  requirePermission('HR_PAYROLL', 'EDIT'),
  validate({ params: payrollComponentParamSchema, body: updateSalaryComponentSchema }),
  controller.updateComponent,
);

payrollRoutes.delete(
  '/payroll/components/:id',
  requirePermission('HR_PAYROLL', 'EDIT'),
  validate({ params: payrollComponentParamSchema }),
  controller.deleteComponent,
);

// ---------------------------------------------------------------------------
//  Salary structures
// ---------------------------------------------------------------------------

payrollRoutes.get(
  '/payroll/structures',
  requirePermission('HR_PAYROLL', 'VIEW'),
  validate({ query: paginationSchema }),
  controller.listStructures,
);

payrollRoutes.post(
  '/payroll/structures',
  requirePermission('HR_PAYROLL', 'CREATE'),
  validate({ body: createSalaryStructureSchema }),
  controller.createStructure,
);

payrollRoutes.get(
  '/payroll/structures/:id',
  requirePermission('HR_PAYROLL', 'VIEW'),
  validate({ params: payrollComponentParamSchema }),
  controller.getStructure,
);

payrollRoutes.patch(
  '/payroll/structures/:id',
  requirePermission('HR_PAYROLL', 'EDIT'),
  validate({ params: payrollComponentParamSchema, body: updateSalaryStructureSchema }),
  controller.updateStructure,
);

// ---------------------------------------------------------------------------
//  Employee salary assignment
// ---------------------------------------------------------------------------

/**
 * Salary history.
 *
 * On the SELF floor: an employee reads their own history with no payroll grant,
 * and the service refuses any other employee id with a 404. Asking for somebody
 * else's salary must not even confirm what band they are in.
 */
payrollRoutes.get(
  '/payroll/salaries',
  requireAnyPermission(...SELF_FLOOR),
  validate({ query: employeeSalaryQuerySchema }),
  controller.listSalaries,
);

/**
 * Assigning a salary. ASSIGN, not EDIT — and the service refuses the subject
 * first, so nobody sets their own pay whatever grants they hold.
 */
payrollRoutes.post(
  '/payroll/salaries',
  requirePermission('HR_PAYROLL', 'ASSIGN'),
  validate({ body: assignEmployeeSalarySchema }),
  controller.assignSalary,
);

// ---------------------------------------------------------------------------
//  Adjustments — literal path before /periods/:id
// ---------------------------------------------------------------------------

payrollRoutes.get(
  '/payroll/adjustments',
  requireAnyPermission(...SELF_FLOOR),
  controller.listAdjustments,
);

payrollRoutes.post(
  '/payroll/adjustments',
  requirePermission('HR_PAYROLL', 'APPROVE'),
  validate({ body: createPayrollAdjustmentSchema }),
  controller.createAdjustment,
);

// ---------------------------------------------------------------------------
//  Periods
// ---------------------------------------------------------------------------

payrollRoutes.get(
  '/payroll/periods',
  requirePermission('HR_PAYROLL', 'VIEW'),
  validate({ query: payrollPeriodListQuerySchema }),
  controller.listPeriods,
);

payrollRoutes.post(
  '/payroll/periods',
  requirePermission('HR_PAYROLL', 'CREATE'),
  validate({ body: createPayrollPeriodSchema }),
  controller.createPeriod,
);

payrollRoutes.get(
  '/payroll/periods/:id',
  requirePermission('HR_PAYROLL', 'VIEW'),
  validate({ params: payrollPeriodParamSchema }),
  controller.getPeriod,
);

payrollRoutes.patch(
  '/payroll/periods/:id',
  requirePermission('HR_PAYROLL', 'EDIT'),
  validate({ params: payrollPeriodParamSchema, body: updatePayrollPeriodSchema }),
  controller.updatePeriod,
);

/**
 * Costing a run. EDIT, and idempotent: calling it twice replaces the figures
 * rather than adding to them.
 */
payrollRoutes.post(
  '/payroll/periods/:id/calculate',
  requirePermission('HR_PAYROLL', 'EDIT'),
  validate({ params: payrollPeriodParamSchema, body: calculatePayrollSchema }),
  controller.calculatePeriod,
);

payrollRoutes.post(
  '/payroll/periods/:id/submit',
  requirePermission('HR_PAYROLL', 'EDIT'),
  validate({ params: payrollPeriodParamSchema, body: submitPayrollSchema }),
  controller.submitPeriod,
);

/**
 * Deciding and finalising. APPROVE is necessary and **never sufficient**: the
 * service refuses anybody whose own salary is inside the run, before it consults
 * any permission.
 */
payrollRoutes.post(
  '/payroll/periods/:id/decide',
  requirePermission('HR_PAYROLL', 'APPROVE'),
  validate({ params: payrollPeriodParamSchema, body: decidePayrollSchema }),
  controller.decidePeriod,
);

payrollRoutes.post(
  '/payroll/periods/:id/finalize',
  requirePermission('HR_PAYROLL', 'APPROVE'),
  validate({ params: payrollPeriodParamSchema, body: finalizePayrollSchema }),
  controller.finalizePeriod,
);

payrollRoutes.post(
  '/payroll/periods/:id/cancel',
  requirePermission('HR_PAYROLL', 'APPROVE'),
  validate({ params: payrollPeriodParamSchema, body: cancelPayrollSchema }),
  controller.cancelPeriod,
);

// --- Period sub-resources: literal segments before the :itemId route ------

payrollRoutes.get(
  '/payroll/periods/:id/summary',
  requirePermission('HR_PAYROLL', 'VIEW'),
  validate({ params: payrollPeriodParamSchema }),
  controller.getSummary,
);

/**
 * The register export. **EXPORT, not VIEW** — see the note at the top.
 */
payrollRoutes.get(
  '/payroll/periods/:id/export',
  requirePermission('HR_PAYROLL', 'EXPORT'),
  validate({ params: payrollPeriodParamSchema, query: payrollExportQuerySchema }),
  controller.exportRegister,
);

/**
 * The lines in a run.
 *
 * On the SELF floor rather than VIEW: the service scopes the query through
 * `visiblePayrollItemFilter`, which narrows an employee to their own line and
 * returns nothing — not everything — for a reader entitled to nothing.
 */
payrollRoutes.get(
  '/payroll/periods/:id/items',
  requireAnyPermission(...SELF_FLOOR),
  validate({ params: payrollPeriodParamSchema, query: payrollItemListQuerySchema }),
  controller.listItems,
);

payrollRoutes.post(
  '/payroll/periods/:id/items/:itemId/exclude',
  requirePermission('HR_PAYROLL', 'EDIT'),
  validate({ params: payrollItemParamSchema, body: excludePayrollItemSchema }),
  controller.excludeItem,
);
