'use server';

import { revalidatePath } from 'next/cache';
import type { CreateUserInput, ManagedUser, SetUserModulesInput, UpdateUserInput } from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * User-management mutations, as server actions.
 *
 * The same pattern as every other module: the form posts here, this attaches
 * the bearer token and calls Express, and the backend's answer is relayed
 * verbatim. Nothing here decides whether the caller is an administrator — the
 * API answers that on its own authority, so a client that reached this action
 * some other way still gets a 403.
 *
 * Passwords pass through on their way to the API and are never logged, never
 * revalidated into a cache key, and never returned.
 */

export type ActionResult<T = { user: ManagedUser }> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

async function call<T>(path: string, init: RequestInit): Promise<ActionResult<T>> {
  const result = await apiFetch<T>(path, init);

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  revalidatePath('/users');
  return { ok: true, data: result.data };
}

export async function createUserAction(input: CreateUserInput): Promise<ActionResult> {
  return call('/api/users', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateUserAction(
  id: string,
  input: UpdateUserInput,
): Promise<ActionResult> {
  return call(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function setUserModulesAction(
  id: string,
  input: SetUserModulesInput,
): Promise<ActionResult> {
  return call(`/api/users/${id}/modules`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** Activate/deactivate, which is the one-click action on the list row. */
export async function setUserActiveAction(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  return call(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
}
