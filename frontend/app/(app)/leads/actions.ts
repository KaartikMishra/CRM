'use server';

import { revalidatePath } from 'next/cache';
import type {
  LeadActivityInput,
  LeadProductRequirementInput,
  LeadRequirementView,
  LeadView,
  UpdateLeadActivityInput,
  UpdateLeadInput,
  UpdateLeadRequirementInput,
  UserRef,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Complete the Ideal mutations, as server actions.
 *
 * The session token never leaves the server: the form posts here, this attaches
 * the bearer and calls Express. Nothing decides business outcomes — each action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on the match-kind rule, the quantity rule and the
 * permission behind each write.
 *
 * In particular **nothing here computes volume**. It arrives derived on every
 * read, from the one definition in `lead.calc.ts`; a second multiplication in the
 * browser would be a second answer.
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

  if (revalidate) {
    revalidatePath(revalidate);
    /*
      And the board, always. Last Follow-up, Next Follow-up and the promptness
      rating are columns on /leads derived from the rows these writes touch, so a
      completed follow-up has to change both screens — not just the one the
      person is looking at.
    */
    revalidatePath('/leads');
  }

  return { ok: true, data: result.data };
}

// ---------------------------------------------------------------------------
//  Deal status
// ---------------------------------------------------------------------------

/**
 * Moves the deal — in process, won or lost.
 *
 * EDIT, not ASSIGN: saying where a deal stands is the work of whoever is handling
 * it, while deciding who handles it is a different capability. The contract
 * accepts only `dealStatus`, so this cannot reassign a lead as a side effect.
 */
export async function updateLeadAction(
  leadId: string,
  input: UpdateLeadInput,
): Promise<ActionResult<{ lead: LeadView }>> {
  return call<{ lead: LeadView }>(
    `/api/leads/${leadId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
    `/leads/${leadId}`,
  );
}

// ---------------------------------------------------------------------------
//  Allocation
// ---------------------------------------------------------------------------

/** The active users a lead may be allocated to. Names only, never credentials. */
export async function fetchAssigneesAction(): Promise<ActionResult<{ assignees: UserRef[] }>> {
  return call<{ assignees: UserRef[] }>('/api/leads/assignees', {});
}

/**
 * Allocates a lead to an associate, or clears the allocation.
 *
 * `associateId: null` means unassign — an explicit null rather than an absent
 * key, so "clear it" and "change nothing" cannot be confused.
 *
 * `allocatedById` is never sent: the backend takes it from the authenticated
 * actor, which is what makes "allocated by" trustworthy. A caller cannot record
 * a colleague as having made their decision.
 */
export async function assignLeadAction(
  leadId: string,
  associateId: string | null,
): Promise<ActionResult<{ lead: LeadView }>> {
  return call<{ lead: LeadView }>(
    `/api/leads/${leadId}/assign`,
    { method: 'POST', body: JSON.stringify({ associateId }) },
    `/leads/${leadId}`,
  );
}

// ---------------------------------------------------------------------------
//  Activities and follow-ups
// ---------------------------------------------------------------------------

/**
 * Records an expected action — a first contact, a follow-up or a result.
 *
 * Both activity endpoints return the whole `LeadView`, which is deliberate and
 * useful here: creating a follow-up changes `nextFollowUpAt`, completing one
 * changes `lastFollowUpAt`, and either can move the promptness rating. The
 * response carries all three recomputed, so the page never derives them itself.
 */
export async function createActivityAction(
  leadId: string,
  input: LeadActivityInput,
): Promise<ActionResult<{ lead: LeadView }>> {
  return call<{ lead: LeadView }>(
    `/api/leads/${leadId}/activities`,
    { method: 'POST', body: JSON.stringify(input) },
    `/leads/${leadId}`,
  );
}

/**
 * Edits one activity, or marks it done.
 *
 * The one write path for both, because they are the same operation to the API:
 * `completedAt` is a field like any other. `kind` is not accepted by the
 * contract, so an activity's kind cannot be changed through here — Phase 4D made
 * it immutable on purpose.
 *
 * Also revalidates the board, since Last and Next Follow-up are columns there.
 */
export async function updateActivityAction(
  leadId: string,
  activityId: string,
  input: UpdateLeadActivityInput,
): Promise<ActionResult<{ lead: LeadView }>> {
  return call<{ lead: LeadView }>(
    `/api/leads/${leadId}/activities/${activityId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
    `/leads/${leadId}`,
  );
}

// ---------------------------------------------------------------------------
//  Complete the Ideal
// ---------------------------------------------------------------------------

export async function createRequirementAction(
  leadId: string,
  input: LeadProductRequirementInput,
): Promise<ActionResult<{ requirement: LeadRequirementView }>> {
  return call<{ requirement: LeadRequirementView }>(
    `/api/leads/${leadId}/requirements`,
    { method: 'POST', body: JSON.stringify(input) },
    `/leads/${leadId}`,
  );
}

export async function updateRequirementAction(
  leadId: string,
  requirementId: string,
  input: UpdateLeadRequirementInput,
): Promise<ActionResult<{ requirement: LeadRequirementView }>> {
  return call<{ requirement: LeadRequirementView }>(
    `/api/leads/${leadId}/requirements/${requirementId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
    `/leads/${leadId}`,
  );
}

export async function deleteRequirementAction(
  leadId: string,
  requirementId: string,
): Promise<ActionResult<{ deleted: string }>> {
  return call<{ deleted: string }>(
    `/api/leads/${leadId}/requirements/${requirementId}`,
    { method: 'DELETE' },
    `/leads/${leadId}`,
  );
}
