'use server';

import { revalidatePath } from 'next/cache';
import type {
  CreateEnquiryInput,
  CreateVendorResponseInput,
  EnquiryDetail,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Every Product Enquiry mutation, as server actions.
 *
 * The session token never leaves the server: a form posts here, this attaches
 * the bearer and calls Express (§36). Nothing decides business outcomes — each
 * action forwards the request and relays the backend's answer verbatim, so the
 * API remains the only authority on status, SLA and permissions.
 */

export type ActionResult<T = { enquiry: EnquiryDetail }> =
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
    revalidatePath('/product-enquiry');
  }

  return { ok: true, data: result.data };
}

export async function createEnquiryAction(
  input: CreateEnquiryInput,
): Promise<ActionResult> {
  return call('/api/product-enquiries', { method: 'POST', body: JSON.stringify(input) }, '/product-enquiry');
}

export async function addVendorResponseAction(
  enquiryId: string,
  productId: string,
  input: CreateVendorResponseInput,
): Promise<ActionResult> {
  return call(
    `/api/product-enquiries/${enquiryId}/products/${productId}/vendor-responses`,
    { method: 'POST', body: JSON.stringify(input) },
    `/product-enquiry/${enquiryId}`,
  );
}

export async function markNoVendorAction(
  enquiryId: string,
  productId: string,
  reason: string,
): Promise<ActionResult> {
  return call(
    `/api/product-enquiries/${enquiryId}/products/${productId}`,
    { method: 'PATCH', body: JSON.stringify({ status: 'NO_VENDOR', noVendorReason: reason }) },
    `/product-enquiry/${enquiryId}`,
  );
}

export async function partialSubmitAction(enquiryId: string): Promise<ActionResult> {
  return call(
    `/api/product-enquiries/${enquiryId}/partial-submit`,
    { method: 'POST' },
    `/product-enquiry/${enquiryId}`,
  );
}

export async function fullSubmitAction(enquiryId: string): Promise<ActionResult> {
  return call(
    `/api/product-enquiries/${enquiryId}/full-submit`,
    { method: 'POST' },
    `/product-enquiry/${enquiryId}`,
  );
}

export async function delayReasonAction(
  enquiryId: string,
  reason: string,
): Promise<ActionResult> {
  return call(
    `/api/product-enquiries/${enquiryId}/delay-reason`,
    { method: 'POST', body: JSON.stringify({ reason }) },
    `/product-enquiry/${enquiryId}`,
  );
}

export async function assignAction(
  enquiryId: string,
  assignedToId: string,
  note?: string,
): Promise<ActionResult> {
  return call(
    `/api/product-enquiries/${enquiryId}/assign`,
    { method: 'POST', body: JSON.stringify({ assignedToId, ...(note ? { note } : {}) }) },
    `/product-enquiry/${enquiryId}`,
  );
}

export async function reopenAction(
  enquiryId: string,
  reason: string,
): Promise<ActionResult> {
  return call(
    `/api/product-enquiries/${enquiryId}/reopen`,
    { method: 'POST', body: JSON.stringify({ reason }) },
    `/product-enquiry/${enquiryId}`,
  );
}

export async function addProductAction(
  enquiryId: string,
  input: { name: string; quantity: number; similarOptionNeeded: boolean },
): Promise<ActionResult> {
  return call(
    `/api/product-enquiries/${enquiryId}/products`,
    { method: 'POST', body: JSON.stringify(input) },
    `/product-enquiry/${enquiryId}`,
  );
}

/** Inline "+ Add Customer" during enquiry creation. */
export async function createCustomerAction(input: {
  name: string;
  type: string;
  phone?: string;
  email?: string;
  address?: string;
}): Promise<ActionResult<{ customer: { id: string; name: string; type: string } }>> {
  return call('/api/customers', { method: 'POST', body: JSON.stringify(input) });
}

/** Inline "+ Add Vendor" during a vendor response. */
export async function createVendorAction(input: {
  name: string;
  contactPerson?: string;
  phone?: string;
  city?: string;
}): Promise<ActionResult<{ vendor: { id: string; name: string } }>> {
  return call('/api/vendors', { method: 'POST', body: JSON.stringify(input) });
}
