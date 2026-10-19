'use server';

import { revalidatePath } from 'next/cache';
import type {
  EmployeeSalaryView,
  PayrollAdjustmentView,
  PayrollCalculationResultView,
  PayrollItemView,
  PayrollPeriodView,
  SalaryComponentView,
  SalaryStructureView,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * HR Phase 6 payroll mutations, as server actions.
 *
 * The session token never leaves the server: the form posts here, this attaches
 * the bearer and calls Express. Nothing decides a business outcome — each action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on every figure, every state transition and every
 * authorization question.
 *
 * ### The absences that matter
 *
 *   - **No action computes or sends a figure the server should compute.**
 *     `calculatePayrollAction` sends an optional list of employee ids and nothing
 *     else: no gross, no deduction, no net, no proration. A client-supplied
 *     amount would be a client-supplied salary.
 *   - **No action finalises on somebody's own behalf.** `finalizePayrollAction`
 *     posts to the API, which refuses any caller whose own salary is inside the
 *     run — **before** it consults any permission. The UI hides the control as a
 *     courtesy; the server is what enforces it.
 *   - **No action edits a finalised run.** Every write path checks
 *     `isPeriodSettled` first, so these return 400 on a FINALIZED period.
 *     Corrections go through `createAdjustmentAction` against a *later* period.
 *   - **No action sets a status, a timestamp, a finaliser or a total.** The
 *     schemas have no fields for them.
 *   - **There is no `updateSalaryAction`.** Salary assignments are append-only:
 *     changing pay creates a new assignment with a later effective date, so a
 *     historical payslip stays explicable. An action that edited one in place
 *     would silently restate what somebody was paid.
 *   - **There is no export action.** The register download is a GET the browser
 *     performs directly against a route gated on HR_PAYROLL:EXPORT, so the file
 *     never passes through a server action that could log it.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

async function call<T>(
  path: string,
  init: RequestInit,
  revalidate?: string[],
): Promise<ActionResult<T>> {
  const result = await apiFetch<T>(path, init);

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  for (const target of revalidate ?? []) revalidatePath(target);
  return { ok: true, data: result.data };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

const DASHBOARD = ['/hr/payroll'];
const COMPONENT_PATHS = ['/hr/payroll', '/hr/payroll/components'];
const STRUCTURE_PATHS = ['/hr/payroll', '/hr/payroll/structures'];
const SALARY_PATHS = ['/hr/payroll', '/hr/payroll/salaries'];
const PERIOD_PATHS = ['/hr/payroll', '/hr/payroll/periods'];
const SELF_PATHS = ['/hr/payroll', '/hr/payroll/my-payslips'];

// ---------------------------------------------------------------------------
//  Salary components
// ---------------------------------------------------------------------------

export async function createComponentAction(
  input: unknown,
): Promise<ActionResult<{ component: SalaryComponentView }>> {
  return call<{ component: SalaryComponentView }>(
    '/api/hr/payroll/components',
    json('POST', input),
    COMPONENT_PATHS,
  );
}

export async function updateComponentAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ component: SalaryComponentView }>> {
  return call<{ component: SalaryComponentView }>(
    `/api/hr/payroll/components/${id}`,
    json('PATCH', input),
    COMPONENT_PATHS,
  );
}

/**
 * Removing a component.
 *
 * The API refuses one that any structure or assignment references, because a
 * historical payslip line names it and the snapshot explaining that line is
 * keyed on its code. Deactivation is the path for a component in use, and the
 * refusal message says so.
 */
export async function deleteComponentAction(
  id: string,
): Promise<ActionResult<{ deleted: boolean }>> {
  return call<{ deleted: boolean }>(
    `/api/hr/payroll/components/${id}`,
    { method: 'DELETE' },
    COMPONENT_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Salary structures
// ---------------------------------------------------------------------------

export async function createStructureAction(
  input: unknown,
): Promise<ActionResult<{ structure: SalaryStructureView }>> {
  return call<{ structure: SalaryStructureView }>(
    '/api/hr/payroll/structures',
    json('POST', input),
    STRUCTURE_PATHS,
  );
}

export async function updateStructureAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ structure: SalaryStructureView }>> {
  return call<{ structure: SalaryStructureView }>(
    `/api/hr/payroll/structures/${id}`,
    json('PATCH', input),
    STRUCTURE_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Employee salary
// ---------------------------------------------------------------------------

/**
 * Assigning a salary, effective from a date.
 *
 * Append-only — see the note at the top of this file. The API refuses a caller
 * assigning to themselves, before consulting any permission.
 */
export async function assignSalaryAction(
  input: unknown,
): Promise<ActionResult<{ assignment: EmployeeSalaryView }>> {
  return call<{ assignment: EmployeeSalaryView }>(
    '/api/hr/payroll/salaries',
    json('POST', input),
    SALARY_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Periods
// ---------------------------------------------------------------------------

export async function createPeriodAction(
  input: unknown,
): Promise<ActionResult<{ period: PayrollPeriodView }>> {
  return call<{ period: PayrollPeriodView }>(
    '/api/hr/payroll/periods',
    json('POST', input),
    PERIOD_PATHS,
  );
}

export async function updatePeriodAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ period: PayrollPeriodView }>> {
  return call<{ period: PayrollPeriodView }>(
    `/api/hr/payroll/periods/${id}`,
    json('PATCH', input),
    PERIOD_PATHS,
  );
}

/**
 * Costing a run.
 *
 * Idempotent: calling it twice replaces the figures rather than adding to them,
 * which is what makes "fix the attendance and recalculate" safe. Sends no
 * amounts — the server reads the salary assignments, the attendance and the
 * configured components itself.
 *
 * The result carries `warnings` and `blockers`. Both are rendered: a run with
 * unvalued overtime or a missing salary assignment must say so rather than
 * quietly producing a smaller number.
 */
export async function calculatePayrollAction(
  id: string,
  employeeIds?: string[],
): Promise<ActionResult<{ result: PayrollCalculationResultView }>> {
  return call<{ result: PayrollCalculationResultView }>(
    `/api/hr/payroll/periods/${id}/calculate`,
    json('POST', employeeIds?.length ? { employeeIds } : {}),
    PERIOD_PATHS,
  );
}

export async function submitPayrollAction(
  id: string,
  reason?: string,
): Promise<ActionResult<{ period: PayrollPeriodView }>> {
  return call<{ period: PayrollPeriodView }>(
    `/api/hr/payroll/periods/${id}/submit`,
    json('POST', reason ? { reason } : {}),
    PERIOD_PATHS,
  );
}

/**
 * Deciding a submitted run.
 *
 * The API refuses an approver who is paid by the run, before any permission
 * check. A rejection requires a note; an approval does not.
 */
export async function decidePayrollAction(
  id: string,
  decision: 'APPROVE' | 'REJECT',
  note?: string,
): Promise<ActionResult<{ period: PayrollPeriodView }>> {
  return call<{ period: PayrollPeriodView }>(
    `/api/hr/payroll/periods/${id}/decide`,
    json('POST', { decision, ...(note ? { note } : {}) }),
    PERIOD_PATHS,
  );
}

/**
 * Finalising a run — the action that locks the figures.
 *
 * `acknowledgeNotStatutory` is required and must be literally `true`. That is
 * not box-ticking: this module computes what it is configured to compute and
 * makes no compliance claim, so the person locking a run that will be paid out
 * states that they know it. The API refuses finalisation without it, and refuses
 * any caller whose own salary is inside the run.
 */
export async function finalizePayrollAction(
  id: string,
  note?: string,
): Promise<ActionResult<{ period: PayrollPeriodView }>> {
  return call<{ period: PayrollPeriodView }>(
    `/api/hr/payroll/periods/${id}/finalize`,
    json('POST', { acknowledgeNotStatutory: true, ...(note ? { note } : {}) }),
    [...PERIOD_PATHS, ...SELF_PATHS],
  );
}

export async function cancelPayrollAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ period: PayrollPeriodView }>> {
  return call<{ period: PayrollPeriodView }>(
    `/api/hr/payroll/periods/${id}/cancel`,
    json('POST', { reason }),
    PERIOD_PATHS,
  );
}

/**
 * Holding one employee out of a run.
 *
 * The note is required and is shown to whoever asks why somebody was not paid —
 * which is the one question this module must always be able to answer.
 */
export async function excludeItemAction(
  periodId: string,
  itemId: string,
  note: string,
): Promise<ActionResult<{ item: PayrollItemView }>> {
  return call<{ item: PayrollItemView }>(
    `/api/hr/payroll/periods/${periodId}/items/${itemId}/exclude`,
    json('POST', { note }),
    PERIOD_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Adjustments — the correction path for a finalised run
// ---------------------------------------------------------------------------

/**
 * An arrear, recovery, bonus or reimbursement against a later period.
 *
 * The only way a finalised figure is corrected. The amount is positive and the
 * `kind` decides its direction, for the same reason a deduction is not a
 * negative earning. The API refuses a caller recording one against themselves.
 */
export async function createAdjustmentAction(
  input: unknown,
): Promise<ActionResult<{ adjustment: PayrollAdjustmentView }>> {
  return call<{ adjustment: PayrollAdjustmentView }>(
    '/api/hr/payroll/adjustments',
    json('POST', input),
    [...DASHBOARD, ...PERIOD_PATHS],
  );
}
