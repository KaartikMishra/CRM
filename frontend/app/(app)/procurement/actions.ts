'use server';

import { revalidatePath } from 'next/cache';
import type {
  AdjustInventoryInput,
  CreateAllocationInput,
  CreateProductInput,
  CreatePurchaseBillInput,
  LinkOrderLineInput,
  PutInCatalogueInput,
  SalesFulfillmentDetail,
  LinkPurchaseItemInput,
  RecordFulfillmentInput,
  SalesRequirementRow,
  OrderRequirementView,
  ProductView,
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

export async function createProductAction(
  input: CreateProductInput,
): Promise<ActionResult<{ product: ProductView }>> {
  return call('/api/procurement/products', { method: 'POST', body: JSON.stringify(input) }, '/procurement');
}

export async function adjustInventoryAction(
  productId: string,
  input: AdjustInventoryInput,
): Promise<ActionResult<{ product: ProductView }>> {
  return call(
    `/api/procurement/products/${productId}/inventory`,
    { method: 'POST', body: JSON.stringify(input) },
    '/procurement',
  );
}

/**
 * Attaches a free-text or legacy order line to a catalogue product, so
 * purchased stock can be matched to it. Writes only productId.
 */
/**
 * Catalogues an order line's product and links the line in one call.
 *
 * The server decides whether that means creating a product or reusing one that
 * already represents it, so two people doing this at once end up on the same
 * catalogue entry rather than racing to create rivals.
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

export async function putInCatalogueAction(
  input: PutInCatalogueInput,
): Promise<ActionResult<{ order: OrderRequirementView }>> {
  return call('/api/procurement/order-lines/put-in-catalogue', {
    method: 'POST',
    body: JSON.stringify(input),
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

/** Reconciles a free-text purchase line with a catalogue product. */
export async function linkPurchaseItemAction(
  billId: string,
  itemId: string,
  input: LinkPurchaseItemInput,
): Promise<ActionResult> {
  return call(
    `/api/procurement/bills/${billId}/items/${itemId}/link`,
    { method: 'POST', body: JSON.stringify(input) },
    `/procurement/${billId}`,
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
