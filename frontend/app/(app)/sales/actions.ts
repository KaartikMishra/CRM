'use server';

import { revalidatePath } from 'next/cache';
import type {
  CancelSalesItemsInput,
  CreateChangeRequestInput,
  CreateSalesOrderInput,
  PaymentMethod,
  SalesOrderDetail,
  SetSalesChargesInput,
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

/**
 * Replaces the order's charges with the set that was sent.
 *
 * A whole set rather than one row at a time, matching the endpoint: the
 * editor holds the list and saves it, and there is no identity on these rows
 * anybody refers to. The backend refuses a discount larger than the order and
 * any set that would drop the payable below what has already been paid.
 */
export async function setSalesChargesAction(
  orderId: string,
  charges: SetSalesChargesInput['charges'],
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/charges`,
    { method: 'PUT', body: JSON.stringify({ charges }) },
    `/sales/${orderId}`,
  );
}

/**
 * Accumulates onto the paid amount; the backend refuses anything past the total.
 *
 * The reference travels with the instalment rather than with the order, which
 * is the whole reason SalesPayment is a table: an order collected in three
 * payments has three UTRs, and a field on the order could hold one of them.
 *
 * Every optional field is omitted rather than sent empty. The API reads an
 * absent `method` as "the arrangement is unchanged", which is the truthful
 * reading for a second instalment on an order already marked COD — sending an
 * empty string instead would fail validation for no reason.
 */
export async function recordPaymentAction(
  orderId: string,
  input: { amount: string; method?: PaymentMethod; reference?: string; note?: string },
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/payments`,
    {
      method: 'POST',
      body: JSON.stringify({
        amount: input.amount,
        ...(input.method ? { method: input.method } : {}),
        ...(input.reference?.trim() ? { reference: input.reference.trim() } : {}),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      }),
    },
    `/sales/${orderId}`,
  );
}

// ---------------------------------------------------------------------------
//  Cancellation
// ---------------------------------------------------------------------------

/**
 * Calls off the whole order. Nothing is deleted.
 *
 * The reason is required by the API and by a database constraint, so it is not
 * a courtesy field. Cancelling moves no money: what the customer has paid
 * becomes refundable, and a refund is a separate decision recorded below.
 */
export async function cancelOrderAction(
  orderId: string,
  reason: string,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/cancel`,
    { method: 'POST', body: JSON.stringify({ reason }) },
    `/sales/${orderId}`,
  );
}

/**
 * Calls off some units of some lines.
 *
 * Each entry says how many MORE units to cancel, never the new cancelled total
 * — the API adds them to what is already cancelled and refuses anything that
 * would take a line past its ordered quantity.
 */
export async function cancelSalesItemsAction(
  orderId: string,
  input: CancelSalesItemsInput,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/cancel-items`,
    { method: 'POST', body: JSON.stringify(input) },
    `/sales/${orderId}`,
  );
}

// ---------------------------------------------------------------------------
//  Refunds
// ---------------------------------------------------------------------------

/**
 * Records that money is owed back. It sends none.
 *
 * The refund lands PENDING: agreed, not gone. The API refuses more than the
 * order's own `refundable` figure, counting refunds already promised, so the
 * ceiling is never computed here.
 */
export async function createRefundAction(
  orderId: string,
  input: { amount: string; reason: string; note?: string },
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/refunds`,
    {
      method: 'POST',
      body: JSON.stringify({
        amount: input.amount,
        reason: input.reason,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      }),
    },
    `/sales/${orderId}`,
  );
}

/**
 * Marks a refund as actually sent.
 *
 * The reference is required — by this endpoint and by a CHECK constraint on the
 * row. Saying money moved without saying how it moved is the one claim the
 * system cannot check against a statement later.
 */
export async function settleRefundAction(
  orderId: string,
  refundId: string,
  input: { reference: string; note?: string },
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/refunds/${refundId}/settle`,
    {
      method: 'POST',
      body: JSON.stringify({
        reference: input.reference,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      }),
    },
    `/sales/${orderId}`,
  );
}

/** Refuses a refund that was agreed. The amount becomes refundable again. */
export async function rejectRefundAction(
  orderId: string,
  refundId: string,
  note?: string,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/refunds/${refundId}/reject`,
    {
      method: 'POST',
      body: JSON.stringify({ ...(note?.trim() ? { note: note.trim() } : {}) }),
    },
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

/**
 * Deciding a proposed change to an order's charges.
 *
 * The same shape as the item change-request actions above, because it is the
 * same workflow — SALES ASSIGN decides, the service refuses self-review, and a
 * rejection leaves the charges exactly as they were. Only the endpoint differs.
 */
export async function approveChargeChangeAction(
  orderId: string,
  requestId: string,
  note?: string,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/charge-requests/${requestId}/approve`,
    { method: 'POST', body: JSON.stringify(note ? { note } : {}) },
    `/sales/${orderId}`,
  );
}

/** Turns one down. The charges in force are left untouched. */
export async function rejectChargeChangeAction(
  orderId: string,
  requestId: string,
  note?: string,
): Promise<ActionResult> {
  return call(
    `/api/sales/${orderId}/charge-requests/${requestId}/reject`,
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
  address?: string;
  state?: string;
  gstNumber?: string;
}): Promise<ActionResult<{ customer: { id: string; name: string; type: string } }>> {
  return call('/api/customers', { method: 'POST', body: JSON.stringify(input) });
}
