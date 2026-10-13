'use server';

import { revalidatePath } from 'next/cache';
import type {
  AssignManagerInput,
  ChangeEmployeeStatusInput,
  CreateDepartmentInput,
  CreateDesignationInput,
  CreateEmployeeInput,
  DepartmentView,
  DesignationView,
  EmployeeDetail,
  LinkEmployeeUserInput,
  UpdateDepartmentInput,
  UpdateDesignationInput,
  UpdateEmployeeInput,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * HR mutations, as server actions.
 *
 * The session token never leaves the server: the form posts here, this attaches
 * the bearer and calls Express. Nothing decides a business outcome — each action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on the employee-id sequence, the manager cycle rule,
 * the status transitions and the permission behind every write.
 *
 * In particular **nothing here derives an employee id**. It is allocated from an
 * atomic counter inside the creating transaction; a browser-side guess would
 * collide under concurrent creates, which is the entire reason that counter exists.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

async function call<T>(
  path: string,
  init: RequestInit,
  revalidate?: string,
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

  if (revalidate) {
    revalidatePath(revalidate);
    /*
      And the directory, always. Department, designation, manager and status are
      all columns on /hr/employees derived from the rows these writes touch, so a
      transfer has to change both screens — not only the one the person is looking
      at. The overview counts come from the same rows, so it is revalidated too.
    */
    revalidatePath('/hr/employees');
    revalidatePath('/hr');
  }

  return { ok: true, data: result.data };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
//  Employees
// ---------------------------------------------------------------------------

export async function createEmployeeAction(
  input: CreateEmployeeInput,
): Promise<ActionResult<{ employee: EmployeeDetail }>> {
  return call<{ employee: EmployeeDetail }>('/api/hr/employees', json('POST', input));
}

export async function updateEmployeeAction(
  id: string,
  input: UpdateEmployeeInput,
): Promise<ActionResult<{ employee: EmployeeDetail }>> {
  return call<{ employee: EmployeeDetail }>(
    `/api/hr/employees/${id}`,
    json('PATCH', input),
    `/hr/employees/${id}`,
  );
}

/**
 * Moves somebody's reporting line.
 *
 * Its own action because it is its own endpoint: the cycle check needs the whole
 * ancestor chain, and keeping it separate means a routine profile edit cannot
 * restructure the hierarchy as a side effect.
 */
export async function assignManagerAction(
  id: string,
  input: AssignManagerInput,
): Promise<ActionResult<{ employee: EmployeeDetail }>> {
  return call<{ employee: EmployeeDetail }>(
    `/api/hr/employees/${id}/manager`,
    json('POST', input),
    `/hr/employees/${id}`,
  );
}

export async function changeEmployeeStatusAction(
  id: string,
  input: ChangeEmployeeStatusInput,
): Promise<ActionResult<{ employee: EmployeeDetail }>> {
  return call<{ employee: EmployeeDetail }>(
    `/api/hr/employees/${id}/status`,
    json('POST', input),
    `/hr/employees/${id}`,
  );
}

/**
 * Ties a CRM account to an HR record.
 *
 * Creates no account and grants no permission — it records a correspondence
 * between two rows that already exist. Creating logins is user management's job,
 * through its own audited screen.
 */
export async function linkEmployeeUserAction(
  id: string,
  input: LinkEmployeeUserInput,
): Promise<ActionResult<{ employee: EmployeeDetail }>> {
  return call<{ employee: EmployeeDetail }>(
    `/api/hr/employees/${id}/user`,
    json('POST', input),
    `/hr/employees/${id}`,
  );
}

export async function unlinkEmployeeUserAction(
  id: string,
  note?: string,
): Promise<ActionResult<{ employee: EmployeeDetail }>> {
  return call<{ employee: EmployeeDetail }>(
    `/api/hr/employees/${id}/user`,
    json('DELETE', { note }),
    `/hr/employees/${id}`,
  );
}

// ---------------------------------------------------------------------------
//  Organization
// ---------------------------------------------------------------------------

export async function createDepartmentAction(
  input: CreateDepartmentInput,
): Promise<ActionResult<{ department: DepartmentView }>> {
  return call<{ department: DepartmentView }>(
    '/api/hr/departments',
    json('POST', input),
    '/hr/departments',
  );
}

export async function updateDepartmentAction(
  id: string,
  input: UpdateDepartmentInput,
): Promise<ActionResult<{ department: DepartmentView }>> {
  return call<{ department: DepartmentView }>(
    `/api/hr/departments/${id}`,
    json('PATCH', input),
    '/hr/departments',
  );
}

export async function createDesignationAction(
  input: CreateDesignationInput,
): Promise<ActionResult<{ designation: DesignationView }>> {
  return call<{ designation: DesignationView }>(
    '/api/hr/designations',
    json('POST', input),
    '/hr/designations',
  );
}

export async function updateDesignationAction(
  id: string,
  input: UpdateDesignationInput,
): Promise<ActionResult<{ designation: DesignationView }>> {
  return call<{ designation: DesignationView }>(
    `/api/hr/designations/${id}`,
    json('PATCH', input),
    '/hr/designations',
  );
}
