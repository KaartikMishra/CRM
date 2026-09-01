'use server';

import { revalidatePath } from 'next/cache';
import type {
  CreateChangeRequestInput,
  CreateSalesOrderInput,
  SalesOrderDetail,
  UpdateSalesOrderInput,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Every Sales Order mutation, as server actions.
 *
 * The session token never leaves the server: a form posts here, this attaches
 * the bearer and calls Express. Nothing decides business outcomes — each action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on status, money and permissions.
 */

export type ActionResult<T = { order: SalesOrderDetail }> =
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
    revalidatePath('/sales');
  }

  return { ok: true, data: result.data };
}

export async function createSalesOrderAction(
  input: CreateSalesOrderInput,
): Promise<ActionResult> {
  return call('/api/sales', { method: 'POST', body: JSON.stringify(input) }, '/sales');
}

export async function updateSalesOrderAction(
  orderId: string,
  input: UpdateSalesOrderInput,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
    `/sales/${orderId}`,
  );
}

/** Accumulates onto the paid amount; the backend refuses anything past the total. */
export async function recordPaymentAction(
  orderId: string,
  amount: string,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/payments`,
    { method: 'POST', body: JSON.stringify({ amount }) },
    `/sales/${orderId}`,
  );
}

/** OPEN → DISPATCHED. The backend freezes the efficiency verdict at this moment. */
export async function dispatchOrderAction(orderId: string): Promise<ActionResult> {
  return call(`/api/sales/${orderId}/dispatch`, { method: 'POST' }, `/sales/${orderId}`);
}

/** DISPATCHED → CLOSED. Final: there is no reopen. */
export async function closeOrderAction(orderId: string): Promise<ActionResult> {
  return call(`/api/sales/${orderId}/close`, { method: 'POST' }, `/sales/${orderId}`);
}

/**
 * Files a change request against an order's products.
 *
 * Nothing here decides whether the change happens — the API records what was
 * asked for, and somebody else decides it. The live products are untouched
 * either way.
 */
export async function createChangeRequestAction(
  orderId: string,
  input: CreateChangeRequestInput,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/change-requests`,
    { method: 'POST', body: JSON.stringify(input) },
    `/sales/${orderId}`,
  );
}

/** Accepts a request and applies it. Refused by the API without SALES ASSIGN. */
export async function approveChangeRequestAction(
  orderId: string,
  requestId: string,
  note?: string,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/change-requests/${requestId}/approve`,
    { method: 'POST', body: JSON.stringify(note ? { note } : {}) },
    `/sales/${orderId}`,
  );
}

/** Turns a request down. The products are left exactly as they were. */
export async function rejectChangeRequestAction(
  orderId: string,
  requestId: string,
  note?: string,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/change-requests/${requestId}/reject`,
    { method: 'POST', body: JSON.stringify(note ? { note } : {}) },
    `/sales/${orderId}`,
  );
}

/** Inline "+ Add Customer" during order creation. */
export async function createSalesCustomerAction(input: {
  name: string;
  type: string;
  phone?: string;
  email?: string;
}): Promise<ActionResult<{ customer: { id: string; name: string; type: string } }>> {
  return call('/api/customers', { method: 'POST', body: JSON.stringify(input) });
}
