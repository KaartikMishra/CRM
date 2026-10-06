import type { LeadAnalyticsPage, LeadView } from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the Lead/Deal API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract this file stops compiling. Mirrors
 * lib/dispatch-api.ts.
 *
 * Nothing here computes promptness, allocation or order value. All three are
 * derived by the service from rows the same request already fetched, and a
 * second calculation in the browser would be a second answer.
 */
export async function fetchLeadAnalytics(
  params: Record<string, string | undefined>,
): Promise<ApiResult<LeadAnalyticsPage>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }

  return apiFetch<LeadAnalyticsPage>(`/api/leads?${query}`);
}

/** One lead in full, including its activity timeline. */
export async function fetchLead(id: string): Promise<ApiResult<{ lead: LeadView }>> {
  return apiFetch<{ lead: LeadView }>(`/api/leads/${id}`);
}
