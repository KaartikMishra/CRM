'use server';

import { revalidatePath } from 'next/cache';
import type {
  CreateAllocationInput,
  CreatePurchaseBillInput,
  LinkOrderLineInput,
  SalesFulfillmentDetail,
  MapPurchaseItemInput,
  RecordFulfillmentInput,
  RequestProductChangeInput,
  ReviewProductChangeInput,
  ReviewPurchaseBillInput,
  SalesRequirementRow,
  OrderRequirementView,
  PurchaseBillDetail,
  PurchaseDelayInput,
  ReceiveItemInput,
  UpdateAllocationInput,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Every Purchase & Procurement mutation, as server actions.
 *
 * The session token never leaves the server: a form posts here, this attaches
 * the bearer and calls Express. Nothing decides business outcomes — each action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on quantities, freezing and permissions.
 */

export type ActionResult<T = { bill: PurchaseBillDetail }> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

async function call<T>(path: string, init: RequestInit, revalidate?: string): Promise<ActionResult<T>> {
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
    revalidatePath('/procurement');
  }

  return { ok: true, data: result.data };
}

export async function createPurchaseBillAction(
  input: CreatePurchaseBillInput,
): Promise<ActionResult> {
  return call('/api/procurement/bills', { method: 'POST', body: JSON.stringify(input) }, '/procurement');
}

export async function receiveItemAction(
  billId: string,
  itemId: string,
  input: ReceiveItemInput,
): Promise<ActionResult> {
  return call(
    `/api/procurement/bills/${billId}/items/${itemId}/receive`,
    { method: 'POST', body: JSON.stringify(input) },
    `/procurement/${billId}`,
  );
}

export async function markDelayedAction(
  billId: string,
  input: PurchaseDelayInput,
): Promise<ActionResult> {
  return call(
    `/api/procurement/bills/${billId}/delay`,
    { method: 'POST', body: JSON.stringify(input) },
    `/procurement/${billId}`,
  );
}

export async function allocateAction(
  billId: string,
  itemId: string,
  input: CreateAllocationInput,
): Promise<ActionResult> {
  return call(
    `/api/procurement/bills/${billId}/items/${itemId}/allocations`,
    { method: 'POST', body: JSON.stringify(input) },
    `/procurement/${billId}`,
  );
}

/** Quantity 0 releases the allocation and returns the stock to standing. */
export async function updateAllocationAction(
  billId: string,
  itemId: string,
  allocationId: string,
  input: UpdateAllocationInput,
): Promise<ActionResult> {
  return call(
    `/api/procurement/bills/${billId}/items/${itemId}/allocations/${allocationId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
    `/procurement/${billId}`,
  );
}

/*
 * `createProductAction`, `adjustInventoryAction`, `putInCatalogueAction` and
 * `linkPurchaseItemAction` were all removed with the legacy Product master.
 *
 * Procurement creates no products and maintains no stock count of its own — RS
 * Products owns both — and there is no second identity left to link a line to.
 * Their endpoints are gone from the API rather than merely hidden from the UI.
 */

/**
 * One History row's fulfilment detail.
 *
 * Read-only: opening the popup must not touch a single record, so this issues
 * a GET and returns exactly what the server computed.
 */
export async function fulfillmentDetailAction(
  salesOrderItemId: string,
): Promise<ActionResult<{ detail: SalesFulfillmentDetail }>> {
  return call(`/api/procurement/order-lines/${salesOrderItemId}/fulfillment-detail`, {
    method: 'GET',
  });
}

export async function linkOrderLineAction(
  input: LinkOrderLineInput,
): Promise<ActionResult<{ order: OrderRequirementView }>> {
  return call('/api/procurement/order-lines/link', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Adds a vendor without leaving the bill form.
 *
 * The same endpoint Product Enquiry uses — one vendor master, one creation
 * path, one set of validation and permission rules. Only `name` is required by
 * the existing schema, so that is all this asks for.
 */
export async function createVendorAction(input: {
  name: string;
}): Promise<ActionResult<{ vendor: { id: string; name: string } }>> {
  return call('/api/vendors', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Maps a purchase line to an RS Product — Procurement's canonical identity.
 *
 * The id comes from the shared RsProductPicker, which returns the exact product
 * the person selected. Nothing here resolves a SKU or a name into a product:
 * RS SKUs repeat and are often absent, so only an explicit selection is sent.
 */
export async function mapPurchaseItemAction(
  billId: string,
  itemId: string,
  input: MapPurchaseItemInput,
): Promise<ActionResult> {
  return call(
    `/api/procurement/bills/${billId}/items/${itemId}/rs-product`,
    { method: 'POST', body: JSON.stringify(input) },
    `/procurement/${billId}`,
  );
}

/**
 * Signs a recorded bill off, or refuses it.
 *
 * Needs PROCUREMENT ASSIGN, and the API refuses self-approval regardless of
 * what anybody holds. This forwards the call and decides nothing itself.
 */
export async function reviewPurchaseBillAction(
  billId: string,
  decision: 'approve' | 'reject',
  input: ReviewPurchaseBillInput,
): Promise<ActionResult> {
  return call(
    `/api/procurement/bills/${billId}/${decision}`,
    { method: 'POST', body: JSON.stringify(input) },
    `/procurement/${billId}`,
  );
}

/**
 * Asks to move an already-mapped line to a different RS Product.
 *
 * A separate action from `mapPurchaseItemAction` above because it does a
 * different thing: that one writes a mapping, this one records a request and
 * writes nothing. The server decides which is permitted from the line's own
 * state — sending a new product through the mapping action on a mapped line is
 * refused there, so this is not a convention the UI could quietly break.
 */
export async function requestProductChangeAction(
  billId: string,
  itemId: string,
  input: RequestProductChangeInput,
): Promise<ActionResult> {
  return call(
    `/api/procurement/bills/${billId}/items/${itemId}/product-change`,
    { method: 'POST', body: JSON.stringify(input) },
    `/procurement/${billId}`,
  );
}

/**
 * Deciding a request. Needs PROCUREMENT ASSIGN, which the API enforces — this
 * forwards the call verbatim and does not decide anything itself.
 */
export async function reviewProductChangeAction(
  changeId: string,
  decision: 'approve' | 'reject',
  input: ReviewProductChangeInput,
  billId?: string,
): Promise<ActionResult> {
  return call(
    `/api/procurement/product-changes/${changeId}/${decision}`,
    { method: 'POST', body: JSON.stringify(input) },
    billId ? `/procurement/${billId}` : '/procurement',
  );
}

/** Records fulfilment that happened outside procurement. */
export async function recordFulfillmentAction(
  salesOrderItemId: string,
  input: RecordFulfillmentInput,
): Promise<ActionResult<{ requirements: SalesRequirementRow[] }>> {
  return call(
    `/api/procurement/order-lines/${salesOrderItemId}/fulfillment`,
    { method: 'PATCH', body: JSON.stringify(input) },
    '/procurement',
  );
}

/** Looks an order up by the number a human typed, to show its requirements. */
export async function lookupOrderAction(
  orderId: string,
): Promise<ActionResult<{ order: OrderRequirementView }>> {
  return call(
    `/api/procurement/order-requirements?orderId=${encodeURIComponent(orderId)}`,
    { method: 'GET' },
  );
}
