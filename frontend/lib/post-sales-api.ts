import type {
  PostSalesCasePage,
  PostSalesCaseView,
  PostSalesOverview,
  UserRef,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the Post Sales & Grievance API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the backend
 * changes a contract this file stops compiling. Mirrors lib/lead-api.ts.
 *
 * Nothing here computes a business figure. The order total, the last-activity
 * moment and the permitted next statuses are all derived by the service from rows
 * the same request already fetched — a second calculation in the browser would be
 * a second answer.
 */

export async function fetchPostSalesCases(
  params: Record<string, string | undefined>,
): Promise<ApiResult<PostSalesCasePage>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  return apiFetch<PostSalesCasePage>(`/api/post-sales/cases?${query}`);
}

export async function fetchPostSalesOverview(): Promise<
  ApiResult<{ overview: PostSalesOverview }>
> {
  return apiFetch<{ overview: PostSalesOverview }>('/api/post-sales/cases/overview');
}

/** One case in full, including its timeline and attachments. */
export async function fetchPostSalesCase(
  id: string,
): Promise<ApiResult<{ case: PostSalesCaseView }>> {
  return apiFetch<{ case: PostSalesCaseView }>(`/api/post-sales/cases/${id}`);
}

/** The active users a case may be allocated to. Names only, never credentials. */
export async function fetchPostSalesAssignees(): Promise<ApiResult<{ assignees: UserRef[] }>> {
  return apiFetch<{ assignees: UserRef[] }>('/api/post-sales/assignees');
}
