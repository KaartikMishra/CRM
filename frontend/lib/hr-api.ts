import type {
  DepartmentPage,
  DepartmentView,
  DesignationPage,
  DesignationView,
  EmployeeDetail,
  EmployeeHistoryEntry,
  EmployeePage,
  HrOverview,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the HR API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the backend
 * changes a contract this file stops compiling. Mirrors lib/post-sales-api.ts and
 * lib/lead-api.ts.
 *
 * Nothing here computes a business figure. Head counts, display names, document
 * expiry and the permitted next statuses are all derived by the service from rows
 * the same request already fetched — a second calculation in the browser would be
 * a second answer.
 *
 * Note what is absent: any reader for a document's bytes or URL. A signed link is
 * minted by its own endpoint, per request, after the server has resolved
 * permission — so there is deliberately no way to obtain one as part of fetching a
 * profile.
 */

export async function fetchHrOverview(): Promise<ApiResult<{ overview: HrOverview }>> {
  return apiFetch<{ overview: HrOverview }>('/api/hr/overview');
}

export async function fetchEmployees(
  params: Record<string, string | undefined>,
): Promise<ApiResult<EmployeePage>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  return apiFetch<EmployeePage>(`/api/hr/employees?${query}`);
}

/** One employee in full, including their reporting line, history and documents. */
export async function fetchEmployee(
  id: string,
): Promise<ApiResult<{ employee: EmployeeDetail }>> {
  return apiFetch<{ employee: EmployeeDetail }>(`/api/hr/employees/${id}`);
}

export async function fetchEmployeeHistory(
  id: string,
): Promise<ApiResult<{ history: EmployeeHistoryEntry[] }>> {
  return apiFetch<{ history: EmployeeHistoryEntry[] }>(`/api/hr/employees/${id}/history`);
}

export async function fetchDepartments(
  params: Record<string, string | undefined> = {},
): Promise<ApiResult<DepartmentPage>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  return apiFetch<DepartmentPage>(`/api/hr/departments?${query}`);
}

export async function fetchDepartment(
  id: string,
): Promise<ApiResult<{ department: DepartmentView }>> {
  return apiFetch<{ department: DepartmentView }>(`/api/hr/departments/${id}`);
}

export async function fetchDesignations(
  params: Record<string, string | undefined> = {},
): Promise<ApiResult<DesignationPage>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  return apiFetch<DesignationPage>(`/api/hr/designations?${query}`);
}

export async function fetchDesignation(
  id: string,
): Promise<ApiResult<{ designation: DesignationView }>> {
  return apiFetch<{ designation: DesignationView }>(`/api/hr/designations/${id}`);
}
