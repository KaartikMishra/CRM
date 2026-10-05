'use server';

import { revalidatePath } from 'next/cache';
import type { CreateLeadInput, LeadCustomerLookupResult, LeadView } from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Create Lead / Deal mutations and lookups, as server actions.
 *
 * The session token never leaves the server: the form posts here, this attaches
 * the bearer and calls Express. Nothing decides business outcomes — each action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on validation, duplicate customers and permissions.
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

  if (revalidate) revalidatePath(revalidate);

  return { ok: true, data: result.data };
}

/**
 * Who already has this number.
 *
 * Returns a list, never "the" customer — see the backend service. The form runs
 * this as somebody types and decides what to show from how many came back.
 */
export async function lookupCustomerByPhoneAction(
  phone: string,
): Promise<ActionResult<LeadCustomerLookupResult>> {
  return call<LeadCustomerLookupResult>(
    `/api/leads/customer-lookup?phone=${encodeURIComponent(phone)}`,
    {},
  );
}

export async function createLeadAction(
  input: CreateLeadInput,
): Promise<ActionResult<{ lead: LeadView }>> {
  return call<{ lead: LeadView }>(
    '/api/leads',
    { method: 'POST', body: JSON.stringify(input) },
    '/create-lead',
  );
}
