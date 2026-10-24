/**
 * All Customers — the server-side API client.
 *
 * Thin by design: each function builds a query string and returns the API
 * envelope unchanged, so a page decides what to render for a failure rather
 * than this layer inventing a fallback. Mirrors `rs-product-api.ts`.
 *
 * Nothing here computes money or counts. Every figure is already derived by the
 * backend through Sales' own `toMoney`, and recomputing anything in the browser
 * would be a second definition of a customer's purchase value.
 */

import type {
  CustomerAnalytics,
  CustomerDuplicateCandidateView,
  CustomerDirectoryPage,
  CustomerEnquiryRow,
  CustomerLeadRow,
  CustomerOrderRow,
  CustomerProfile,
  CustomerTimelineEntry,
} from '@rs/shared';
import { apiFetch } from './api-server';

/** Drops empty values so the URL carries only filters that were actually set. */
function queryOf(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export async function fetchCustomerDirectory(
  params: Record<string, string | number | boolean | undefined> = {},
) {
  const query = queryOf(params);
  return apiFetch<{ customers: CustomerDirectoryPage['customers'] }>(
    `/api/customers/directory${query ? `?${query}` : ''}`,
  );
}

/**
 * Reads the pagination descriptor out of `meta`.
 *
 * `ApiSuccess.meta` is `Record<string, unknown>`, so this narrows rather than
 * casts: the server sends either a keyset descriptor or an offset one, and a
 * page that assumed the wrong shape would render a "next" link that skips rows
 * or page numbers that do not exist. An unrecognised shape falls back to a
 * single keyset page with no cursor, which is the safe reading — it offers no
 * navigation rather than broken navigation.
 */
export function readPagination(
  meta: Record<string, unknown> | undefined,
): CustomerDirectoryPage['pagination'] {
  const raw = meta?.pagination;
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    if (candidate.mode === 'keyset') {
      const cursor = candidate.nextCursor;
      return { mode: 'keyset', nextCursor: typeof cursor === 'string' ? cursor : null };
    }
    if (candidate.mode === 'offset') {
      const num = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
      return {
        mode: 'offset',
        page: num(candidate.page, 1),
        total: num(candidate.total, 0),
        totalPages: num(candidate.totalPages, 0),
      };
    }
  }
  return { mode: 'keyset', nextCursor: null };
}

export async function fetchCustomerAnalytics(
  params: Record<string, string | number | boolean | undefined> = {},
) {
  const query = queryOf(params);
  return apiFetch<{ analytics: CustomerAnalytics }>(
    `/api/customers/analytics${query ? `?${query}` : ''}`,
  );
}

export async function fetchCustomerProfile(id: string) {
  return apiFetch<{ customer: CustomerProfile }>(`/api/customers/${id}/profile`);
}

export async function fetchCustomerEnquiries(id: string, limit = 25) {
  return apiFetch<{ enquiries: CustomerEnquiryRow[] }>(
    `/api/customers/${id}/enquiries?limit=${limit}`,
  );
}

export async function fetchCustomerLeads(id: string, limit = 25) {
  return apiFetch<{ leads: CustomerLeadRow[] }>(`/api/customers/${id}/leads?limit=${limit}`);
}

export async function fetchCustomerOrders(id: string, limit = 25) {
  return apiFetch<{ orders: CustomerOrderRow[] }>(`/api/customers/${id}/orders?limit=${limit}`);
}

export async function fetchCustomerTimeline(id: string) {
  return apiFetch<{ timeline: CustomerTimelineEntry[] }>(`/api/customers/${id}/timeline`);
}

/**
 * A page of duplicate candidates at one status.
 *
 * `counts` arrives for every status, so the filter tabs can show a real zero
 * rather than a blank where a count failed to load.
 */
export async function fetchDuplicateCandidates(
  params: Record<string, string | number | boolean | undefined> = {},
) {
  const query = queryOf(params);
  return apiFetch<{
    candidates: CustomerDuplicateCandidateView[];
    counts: { SUGGESTED: number; CONFIRMED: number; DISMISSED: number };
  }>(`/api/customers/duplicates${query ? `?${query}` : ''}`);
}
