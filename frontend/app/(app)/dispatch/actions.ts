'use server';

import { revalidatePath } from 'next/cache';
import type {
  CreateDispatchInput,
  CreatePartialDispatchRequestInput,
  DecidePartialDispatchInput,
  DispatchDetail,
  DispatchOrderInput,
  DispatchView,
  PartialDispatchRequestView,
  UpdateDispatchInput,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Every Packing & Dispatch mutation, as server actions.
 *
 * The session token never leaves the server: a form posts here, this attaches
 * the bearer and calls Express. Nothing decides business outcomes — each action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on quantities, state transitions and permissions.
 *
 * In particular, none of these re-check what the backend checks. A dispatcher
 * whose screen is a minute stale will be refused by the API with a message this
 * relays, rather than by a browser-side rule that could disagree with it.
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
    revalidatePath('/dispatch');
  }

  return { ok: true, data: result.data };
}

// ---------------------------------------------------------------------------
//  Reading — for dialogs that open on demand
// ---------------------------------------------------------------------------

/** One order's picture, refetched after a mutation without a full navigation. */
export async function dispatchDetailAction(
  salesOrderId: string,
): Promise<ActionResult<{ detail: DispatchDetail }>> {
  return call<{ detail: DispatchDetail }>(`/api/dispatch/orders/${salesOrderId}`, {});
}

// ---------------------------------------------------------------------------
//  A shipment's lifecycle
// ---------------------------------------------------------------------------

export async function createDispatchAction(
  input: CreateDispatchInput,
): Promise<ActionResult<{ dispatch: DispatchView }>> {
  return call<{ dispatch: DispatchView }>(
    '/api/dispatch/shipments',
    { method: 'POST', body: JSON.stringify(input) },
    `/dispatch/${input.salesOrderId}`,
  );
}

/** Records how the shipment travels, while it is still being packed. */
export async function updateDispatchAction(
  id: string,
  salesOrderId: string,
  input: UpdateDispatchInput,
): Promise<ActionResult<{ dispatch: DispatchView }>> {
  return call<{ dispatch: DispatchView }>(
    `/api/dispatch/shipments/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
    `/dispatch/${salesOrderId}`,
  );
}

export async function startPackingAction(
  id: string,
  salesOrderId: string,
): Promise<ActionResult<{ dispatch: DispatchView }>> {
  return call<{ dispatch: DispatchView }>(
    `/api/dispatch/shipments/${id}/pack`,
    { method: 'POST' },
    `/dispatch/${salesOrderId}`,
  );
}

export async function completePackingAction(
  id: string,
  salesOrderId: string,
): Promise<ActionResult<{ dispatch: DispatchView }>> {
  return call<{ dispatch: DispatchView }>(
    `/api/dispatch/shipments/${id}/packed`,
    { method: 'POST' },
    `/dispatch/${salesOrderId}`,
  );
}

export async function cancelDispatchAction(
  id: string,
  salesOrderId: string,
): Promise<ActionResult<{ dispatch: DispatchView }>> {
  return call<{ dispatch: DispatchView }>(
    `/api/dispatch/shipments/${id}/cancel`,
    { method: 'POST' },
    `/dispatch/${salesOrderId}`,
  );
}

/**
 * Sending the goods — the point of no return.
 *
 * The backend revalidates the customer's name, address and phone here even
 * though the screen showed them, and refuses with a validation error listing
 * what is missing. A missing email is a warning there and is deliberately not
 * a blocker here either.
 */
export async function dispatchShipmentAction(
  id: string,
  salesOrderId: string,
  input: DispatchOrderInput,
): Promise<ActionResult<{ dispatch: DispatchView }>> {
  return call<{ dispatch: DispatchView }>(
    `/api/dispatch/shipments/${id}/dispatch`,
    { method: 'POST', body: JSON.stringify(input) },
    `/dispatch/${salesOrderId}`,
  );
}

// ---------------------------------------------------------------------------
//  Partial dispatch
// ---------------------------------------------------------------------------

/**
 * Asking whether the ready part of an order may go.
 *
 * A USER's request is born PENDING and waits for Procurement; an
 * administrator's is allowed the moment it is made, and the API requires their
 * reason. Which of the two happened is in the returned request's own status —
 * this action does not predict it, because the rule belongs to the backend.
 */
export async function createPartialRequestAction(
  input: CreatePartialDispatchRequestInput,
): Promise<ActionResult<{ request: PartialDispatchRequestView }>> {
  return call<{ request: PartialDispatchRequestView }>(
    '/api/dispatch/partial-requests',
    { method: 'POST', body: JSON.stringify(input) },
    `/dispatch/${input.salesOrderId}`,
  );
}

/**
 * Procurement's answer.
 *
 * ALLOW needs a reason and may carry a plan of action; DISALLOW needs both.
 * The shared schema states that, the database's CHECK constraints enforce it,
 * and the dialog asks for it — three statements of one rule, none of them
 * inventing a fourth.
 */
export async function decidePartialRequestAction(
  requestId: string,
  salesOrderId: string,
  input: DecidePartialDispatchInput,
): Promise<ActionResult<{ request: PartialDispatchRequestView }>> {
  return call<{ request: PartialDispatchRequestView }>(
    `/api/dispatch/partial-requests/${requestId}/decide`,
    { method: 'POST', body: JSON.stringify(input) },
    `/dispatch/${salesOrderId}`,
  );
}

/** Every request an order has carried, for the history panel. */
export async function partialRequestsAction(
  salesOrderId: string,
): Promise<ActionResult<{ requests: PartialDispatchRequestView[] }>> {
  return call<{ requests: PartialDispatchRequestView[] }>(
    `/api/dispatch/orders/${salesOrderId}/partial-requests`,
    {},
  );
}
