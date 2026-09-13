'use server';

import { revalidatePath } from 'next/cache';
import type {
  CreateRsProductInput,
  RsProductDetail,
  RsProductListRow,
  UpdateRsProductInput,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * RS Products mutations, as server actions.
 *
 * The session token never leaves the server: a form posts here, this attaches
 * the bearer and calls Express. Nothing decides business outcomes — the action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on permissions and validation.
 *
 * Note what is absent: `source`. A product created here is MANUAL because the
 * backend fixes it so, not because the client asked. A client that could name
 * its own source could create a row the Shopify sync believes it owns.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

export async function createRsProductAction(
  input: CreateRsProductInput,
): Promise<ActionResult<{ product: RsProductListRow }>> {
  const result = await apiFetch<{ product: RsProductListRow }>('/api/rs-products', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  revalidatePath('/rs-products');
  return { ok: true, data: result.data };
}

/**
 * Applies a CRM-side edit.
 *
 * Nothing here reaches Shopify. The backend refuses a field Shopify owns
 * outright rather than accepting a change the next sync would silently undo,
 * and this relays that refusal verbatim.
 */
export async function updateRsProductAction(
  id: string,
  input: UpdateRsProductInput,
): Promise<ActionResult<{ product: RsProductDetail }>> {
  const result = await apiFetch<{ product: RsProductDetail }>(`/api/rs-products/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  revalidatePath('/rs-products');
  revalidatePath(`/rs-products/${id}/edit`);
  return { ok: true, data: result.data };
}

/** Archives a product. Soft: nothing is deleted, in the CRM or in Shopify. */
export async function archiveRsProductAction(
  id: string,
): Promise<ActionResult<{ product: RsProductDetail }>> {
  const result = await apiFetch<{ product: RsProductDetail }>(`/api/rs-products/${id}/archive`, {
    method: 'POST',
  });

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
    };
  }

  revalidatePath('/rs-products');
  return { ok: true, data: result.data };
}
