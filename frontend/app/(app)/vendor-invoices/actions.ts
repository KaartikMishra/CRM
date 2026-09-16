'use server';

import { revalidatePath } from 'next/cache';
import type {
  CreateMappingInput,
  CreateVendorInput,
  UpdateMappingInput,
  UpdateVendorInput,
  VendorListRow,
  VendorMappingRow,
  VendorSummary,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Vendor Invoices mutations, as server actions.
 *
 * The session token never leaves the server: a form posts here, this attaches
 * the bearer and calls Express. Nothing decides business outcomes — the action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on permissions and validation.
 *
 * Note what is absent from the edit path: `isActive`. Archiving a vendor is its
 * own operation behind its own permission, and the backend strips the field
 * even if it were sent. Keeping it out of the form as well means the UI tells
 * the same story the API enforces.
 *
 * There is also no action for a *historical* rate. Trade history is read from
 * Procurement's purchase records, and this module cannot write them at all.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

/** Turns an API failure into the shape every form in this module renders. */
function failure<T>(result: {
  message: string;
  code?: string;
  details?: { path: string; message: string }[];
}): ActionResult<T> {
  return {
    ok: false,
    message: result.message,
    ...(result.code ? { code: result.code } : {}),
    ...(result.details ? { details: result.details } : {}),
  };
}

// ---------------------------------------------------------------------------
//  Vendors
// ---------------------------------------------------------------------------

export async function createVendorAction(
  input: CreateVendorInput,
): Promise<ActionResult<{ vendor: VendorListRow }>> {
  const result = await apiFetch<{ vendor: VendorListRow }>('/api/vendor-invoices/vendors', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  if (!result.success) return failure(result);

  revalidatePath('/vendor-invoices');
  return { ok: true, data: result.data };
}

/**
 * Edits a vendor's details.
 *
 * `isActive` is deliberately not part of the input type used here — the caller
 * cannot supply it, so an edit can never archive or restore somebody.
 */
export async function updateVendorAction(
  id: string,
  input: Omit<UpdateVendorInput, 'isActive'>,
): Promise<ActionResult<{ vendor: VendorListRow }>> {
  const result = await apiFetch<{ vendor: VendorListRow }>(
    `/api/vendor-invoices/vendors/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );

  if (!result.success) return failure(result);

  revalidatePath('/vendor-invoices');
  return { ok: true, data: result.data };
}

/**
 * Archives a vendor. Soft: POST /archive, never DELETE.
 *
 * Purchase bills name this vendor and must stay readable, so nothing is
 * removed — the vendor stops appearing as active and everything else stands.
 */
export async function archiveVendorAction(
  id: string,
): Promise<ActionResult<{ vendor: VendorSummary }>> {
  const result = await apiFetch<{ vendor: VendorSummary }>(
    `/api/vendor-invoices/vendors/${id}/archive`,
    { method: 'POST' },
  );

  if (!result.success) return failure(result);

  revalidatePath('/vendor-invoices');
  return { ok: true, data: result.data };
}

// ---------------------------------------------------------------------------
//  Vendor ↔ product mappings
// ---------------------------------------------------------------------------

/**
 * Maps an RsProduct to a vendor at an agreed rate.
 *
 * `rsProductId`, never a legacy `Product` id: RS Products is the canonical
 * catalogue and the backend validates against it.
 *
 * A previously archived pair is revived by the backend rather than duplicated,
 * so the caller does not need to check for one first.
 */
export async function createMappingAction(
  input: CreateMappingInput,
): Promise<ActionResult<{ mapping: VendorMappingRow }>> {
  const result = await apiFetch<{ mapping: VendorMappingRow }>('/api/vendor-invoices/mappings', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  if (!result.success) return failure(result);

  revalidatePath('/vendor-invoices');
  return { ok: true, data: result.data };
}

/**
 * Changes what a vendor charges today.
 *
 * Only the mapping row is written. Past purchases keep the rate they were
 * recorded with — that is why the two numbers live in different tables and are
 * shown in different sections of the drawer.
 */
export async function updateMappingAction(
  id: string,
  input: UpdateMappingInput,
): Promise<ActionResult<{ mapping: VendorMappingRow }>> {
  const result = await apiFetch<{ mapping: VendorMappingRow }>(
    `/api/vendor-invoices/mappings/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );

  if (!result.success) return failure(result);

  revalidatePath('/vendor-invoices');
  return { ok: true, data: result.data };
}

/** Archives a mapping. Soft, so the same row can be reactivated later. */
export async function archiveMappingAction(
  id: string,
): Promise<ActionResult<{ mapping: VendorMappingRow }>> {
  const result = await apiFetch<{ mapping: VendorMappingRow }>(
    `/api/vendor-invoices/mappings/${id}/archive`,
    { method: 'POST' },
  );

  if (!result.success) return failure(result);

  revalidatePath('/vendor-invoices');
  return { ok: true, data: result.data };
}
