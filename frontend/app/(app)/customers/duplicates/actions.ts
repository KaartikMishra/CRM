'use server';

import { revalidatePath } from 'next/cache';
import type { CustomerDuplicateCandidateView } from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Recording a duplicate-review decision.
 *
 * The session token never leaves the server: the form posts here, this attaches
 * the bearer and calls Express. Nothing decides a business outcome — the action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on permissions and on what a decision means.
 *
 * ### There is no merge action here, and that is deliberate
 *
 * Confirming a pair records that somebody looked at it and agreed. It changes
 * no customer row, enquiry, lead or order, and no endpoint exists that would.
 * Merging is a separate decision with rules nobody has approved, and a reviewer
 * who could trigger one from this screen by accident is the exact risk the
 * review queue exists to avoid.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

export async function decideDuplicateAction(
  candidateId: string,
  status: 'CONFIRMED' | 'DISMISSED',
): Promise<ActionResult<{ candidate: CustomerDuplicateCandidateView }>> {
  const result = await apiFetch<{ candidate: CustomerDuplicateCandidateView }>(
    `/api/customers/duplicates/${candidateId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
  );

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  /*
    The queue and the directory both change: a decided pair leaves the
    SUGGESTED list, and the directory's "possible duplicate" badge is derived
    from open suggestions, so a stale page would keep flagging a customer whose
    pair has just been dismissed.
  */
  revalidatePath('/customers/duplicates');
  revalidatePath('/customers');

  return { ok: true, data: result.data };
}
