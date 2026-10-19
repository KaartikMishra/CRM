import type {
  EmployeeSalaryListView,
  MyPayrollView,
  PayrollItemListView,
  PayrollOverviewView,
  PayrollPeriodListView,
  PayrollPeriodSummaryView,
  PayrollPeriodView,
  PayslipView,
  SalaryComponentListView,
  SalaryStructureListView,
  SalaryStructureView,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the HR Phase 6 payroll API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract this file stops compiling. Mirrors `lib/hr-api.ts`,
 * `lib/attendance-api.ts`, `lib/recruitment-api.ts`, `lib/training-api.ts` and
 * `lib/performance-api.ts`.
 *
 * ### Nothing here computes a figure
 *
 * Not a gross, not a deduction, not a net, not a proration, not whether a run
 * may be finalised. Every number and every `viewerCan` flag arrives already
 * decided by the service.
 *
 * That rule is stricter in this module than anywhere else in the system for two
 * reasons. A figure the browser computed would eventually disagree with the
 * figure the employee was paid, and the disagreement would surface as an
 * accusation. And a client that can compute pay is a client that has been sent
 * the inputs to compute it — the structure, the component rates — which is
 * exactly the data that must not reach a reader entitled only to a total.
 *
 * ### There is deliberately no reader that fetches somebody else's payslip
 *
 * `fetchMyPayroll` takes **no employee id**. There is no
 * `fetchPayrollFor(employeeId)` in this file, because the absence of the
 * parameter is a stronger guarantee than a check on it: the self-service surface
 * cannot be pointed at another person even by a caller who wants to.
 *
 * `fetchPayslip` takes an item id and the API answers **404** — not 403 — for one
 * outside the reader's scope, so a probe cannot confirm that another employee's
 * payslip exists.
 *
 * ### FINALIZED is not PAID
 *
 * No reader here reports payment. A finalised run means the figures are locked
 * and payslips may be issued; no bank integration exists in this system, so
 * nothing in this file claims money has moved.
 */

/** The payroll dashboard. Returns an aggregate-free shape for an employee. */
export function fetchPayrollOverview(): Promise<ApiResult<{ overview: PayrollOverviewView }>> {
  return apiFetch<{ overview: PayrollOverviewView }>('/api/hr/payroll/overview');
}

/**
 * The reader's own pay and payslips.
 *
 * No parameter, by design — see the note above.
 */
export function fetchMyPayroll(): Promise<ApiResult<{ mine: MyPayrollView }>> {
  return apiFetch<{ mine: MyPayrollView }>('/api/hr/payroll/mine');
}

/** One payslip, from the finalised snapshot. 404 when out of scope. */
export function fetchPayslip(itemId: string): Promise<ApiResult<{ payslip: PayslipView }>> {
  return apiFetch<{ payslip: PayslipView }>(`/api/hr/payroll/payslips/${itemId}`);
}

// ---------------------------------------------------------------------------
//  Compensation configuration
// ---------------------------------------------------------------------------

export function fetchSalaryComponents(
  params: { kind?: string; includeInactive?: boolean } = {},
): Promise<ApiResult<SalaryComponentListView>> {
  const query = new URLSearchParams();
  if (params.kind) query.set('kind', params.kind);
  if (params.includeInactive) query.set('includeInactive', 'true');
  const suffix = query.toString();
  return apiFetch<SalaryComponentListView>(
    `/api/hr/payroll/components${suffix ? `?${suffix}` : ''}`,
  );
}

export function fetchSalaryStructures(
  params: { cursor?: string; limit?: number } = {},
): Promise<ApiResult<SalaryStructureListView>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  query.set('limit', String(params.limit ?? 25));
  return apiFetch<SalaryStructureListView>(`/api/hr/payroll/structures?${query.toString()}`);
}

export function fetchSalaryStructure(
  id: string,
): Promise<ApiResult<{ structure: SalaryStructureView }>> {
  return apiFetch<{ structure: SalaryStructureView }>(`/api/hr/payroll/structures/${id}`);
}

/**
 * Salary assignments.
 *
 * With no `employeeId` the API returns the reader's own history; with one it
 * returns that employee's, or 404 if the reader is not entitled to it. The
 * decision is the server's.
 */
export function fetchSalaryAssignments(
  params: { employeeId?: string; includeHistory?: boolean } = {},
): Promise<ApiResult<EmployeeSalaryListView>> {
  const query = new URLSearchParams();
  if (params.employeeId) query.set('employeeId', params.employeeId);
  if (params.includeHistory) query.set('includeHistory', 'true');
  const suffix = query.toString();
  return apiFetch<EmployeeSalaryListView>(
    `/api/hr/payroll/salaries${suffix ? `?${suffix}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
//  Periods
// ---------------------------------------------------------------------------

export function fetchPayrollPeriods(
  params: { cursor?: string; limit?: number; status?: string; year?: number } = {},
): Promise<ApiResult<PayrollPeriodListView>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  query.set('limit', String(params.limit ?? 25));
  if (params.status) query.set('status', params.status);
  if (params.year) query.set('year', String(params.year));
  return apiFetch<PayrollPeriodListView>(`/api/hr/payroll/periods?${query.toString()}`);
}

/**
 * One period.
 *
 * `viewerCan` and `viewerIsPaidByThisRun` arrive decided. The page renders them
 * and must not re-derive either — `viewerCan.finalize` is false for a reader
 * whose own salary is in the run, whatever grants they hold, and recomputing
 * that in the browser would offer a control the API refuses.
 */
export function fetchPayrollPeriod(
  id: string,
): Promise<ApiResult<{ period: PayrollPeriodView }>> {
  return apiFetch<{ period: PayrollPeriodView }>(`/api/hr/payroll/periods/${id}`);
}

/**
 * The lines in a run.
 *
 * Already scoped by the server: an employee receives their own line only, and a
 * payroll administrator receives every line. The page does not filter.
 */
export function fetchPayrollItems(
  periodId: string,
  params: { cursor?: string; limit?: number; departmentId?: string; status?: string; search?: string } = {},
): Promise<ApiResult<PayrollItemListView>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  query.set('limit', String(params.limit ?? 50));
  if (params.departmentId) query.set('departmentId', params.departmentId);
  if (params.status) query.set('status', params.status);
  if (params.search) query.set('search', params.search);
  return apiFetch<PayrollItemListView>(
    `/api/hr/payroll/periods/${periodId}/items?${query.toString()}`,
  );
}

/** Aggregates only — never the individual salaries behind them. */
export function fetchPayrollSummary(
  periodId: string,
): Promise<ApiResult<{ summary: PayrollPeriodSummaryView }>> {
  return apiFetch<{ summary: PayrollPeriodSummaryView }>(
    `/api/hr/payroll/periods/${periodId}/summary`,
  );
}
