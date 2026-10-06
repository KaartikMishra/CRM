'use server';

import { revalidatePath } from 'next/cache';
import type {
  AssignPostSalesCaseInput,
  CreatePostSalesCaseInput,
  PostSalesActivityInput,
  PostSalesAttachmentInput,
  PostSalesCaseStatusChangeInput,
  PostSalesCaseView,
  UpdatePostSalesCaseInput,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Post Sales mutations, as server actions.
 *
 * The session token never leaves the server: a form posts here, this attaches the
 * bearer and calls Express. Nothing decides business outcomes — each action
 * forwards the request and relays the backend's answer verbatim, so the API remains
 * the only authority on the transition map, the cross-order checks and the
 * permission behind each write.
 *
 * In particular **no actor identity is ever sent**. `raisedById`, `performedById`
 * and `uploadedById` come from the authenticated session on the server side, which
 * is what makes the audit trail trustworthy.
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
      And the board and overview, always. Status, priority, assignment and the
      last-activity moment are all columns or tiles on those screens, derived from
      the rows these writes touch — so a change has to reach every surface, not
      only the one the person is looking at.
    */
    revalidatePath('/post-sales/cases');
    revalidatePath('/post-sales');
  }

  return { ok: true, data: result.data };
}

type CaseResult = ActionResult<{ case: PostSalesCaseView }>;

export async function createCaseAction(
  input: CreatePostSalesCaseInput,
): Promise<CaseResult> {
  return call<{ case: PostSalesCaseView }>(
    '/api/post-sales/cases',
    { method: 'POST', body: JSON.stringify(input) },
    '/post-sales/cases',
  );
}

export async function updateCaseAction(
  caseId: string,
  input: UpdatePostSalesCaseInput,
): Promise<CaseResult> {
  return call<{ case: PostSalesCaseView }>(
    `/api/post-sales/cases/${caseId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
    `/post-sales/cases/${caseId}`,
  );
}

/**
 * Moves the case.
 *
 * The transition is validated server-side against the shared map, so an illegal
 * move returns a message naming both ends rather than being silently dropped.
 */
export async function changeCaseStatusAction(
  caseId: string,
  input: PostSalesCaseStatusChangeInput,
): Promise<CaseResult> {
  return call<{ case: PostSalesCaseView }>(
    `/api/post-sales/cases/${caseId}/status`,
    { method: 'POST', body: JSON.stringify(input) },
    `/post-sales/cases/${caseId}`,
  );
}

/**
 * Allocates a case, or clears the allocation.
 *
 * `assignedToId: null` unassigns. Who performed it is the authenticated actor and
 * is never sent — a caller must not be able to record a colleague as having made
 * their decision.
 */
export async function assignCaseAction(
  caseId: string,
  input: AssignPostSalesCaseInput,
): Promise<CaseResult> {
  return call<{ case: PostSalesCaseView }>(
    `/api/post-sales/cases/${caseId}/assign`,
    { method: 'POST', body: JSON.stringify(input) },
    `/post-sales/cases/${caseId}`,
  );
}

export async function addCaseActivityAction(
  caseId: string,
  input: PostSalesActivityInput,
): Promise<CaseResult> {
  return call<{ case: PostSalesCaseView }>(
    `/api/post-sales/cases/${caseId}/activities`,
    { method: 'POST', body: JSON.stringify(input) },
    `/post-sales/cases/${caseId}`,
  );
}

/** Also the "mark follow-up done" path: completion is a field like any other. */
export async function updateCaseActivityAction(
  caseId: string,
  activityId: string,
  input: { note?: string; dueAt?: string; completedAt?: string | null },
): Promise<CaseResult> {
  return call<{ case: PostSalesCaseView }>(
    `/api/post-sales/cases/${caseId}/activities/${activityId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
    `/post-sales/cases/${caseId}`,
  );
}

export async function addCaseAttachmentAction(
  caseId: string,
  input: PostSalesAttachmentInput,
): Promise<CaseResult> {
  return call<{ case: PostSalesCaseView }>(
    `/api/post-sales/cases/${caseId}/attachments`,
    { method: 'POST', body: JSON.stringify(input) },
    `/post-sales/cases/${caseId}`,
  );
}

/**
 * Detaches an attachment.
 *
 * The MediaAsset survives: it is referenced by seven tables and every foreign key
 * to it is SetNull, so this removes the link and nothing else.
 */
export async function removeCaseAttachmentAction(
  caseId: string,
  attachmentId: string,
): Promise<CaseResult> {
  return call<{ case: PostSalesCaseView }>(
    `/api/post-sales/cases/${caseId}/attachments/${attachmentId}`,
    { method: 'DELETE' },
    `/post-sales/cases/${caseId}`,
  );
}

/** One customer's orders and lines, for the create form's pickers. */
export async function fetchCustomerOrdersAction(customerId: string): Promise<
  ActionResult<{
    orders: {
      id: string;
      orderId: string;
      status: string;
      orderDate: string;
      items: { id: string; lineNo: number; productName: string; quantity: number }[];
    }[];
  }>
> {
  return call(`/api/post-sales/customers/${customerId}/orders`, {});
}

/** The active users a case may be allocated to. Names only, never credentials. */
export async function fetchCaseAssigneesAction(): Promise<
  ActionResult<{ assignees: { id: string; name: string; employeeId: string; role: string }[] }>
> {
  return call('/api/post-sales/assignees', {});
}
