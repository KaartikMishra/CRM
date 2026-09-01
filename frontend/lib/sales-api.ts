import type { CustomerView, SalesOrderDetail, SalesOrderSummary } from '@rs/shared';
import { cache } from 'react';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the Sales Order API.
 *
 * Every shape here comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract, this file stops compiling. Mirrors lib/enquiry-api.ts.
 */

export type SalesListResult = {
  orders: SalesOrderSummary[];
};

export type ListMeta = {
  nextCursor?: string | null;
  serverTime?: string;
};

export async function fetchSalesOrders(
  params: Record<string, string | undefined>,
): Promise<{ result: ApiResult<SalesListResult>; meta: ListMeta }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }

  const result = await apiFetch<SalesListResult>(`/api/sales?${query}`);
  return { result, meta: result.success ? ((result.meta ?? {}) as ListMeta) : {} };
}

/**
 * Deduplicated per render pass, for the same reason the enquiry reader is:
 * `generateMetadata` and the page component both need the order, and the API
 * sits a long way from here.
 */
export const fetchSalesOrder = cache(
  async (
    id: string,
  ): Promise<{ result: ApiResult<{ order: SalesOrderDetail }>; serverTime?: string }> => {
    const result = await apiFetch<{ order: SalesOrderDetail }>(`/api/sales/${id}`);
    return {
      result,
      serverTime: result.success ? ((result.meta?.serverTime as string) ?? undefined) : undefined,
    };
  },
);

/** The customer master, for the list's customer filter. */
export async function fetchSalesCustomers(q?: string): Promise<CustomerView[]> {
  const query = new URLSearchParams({ limit: '50' });
  if (q) query.set('q', q);
  const result = await apiFetch<{ customers: CustomerView[] }>(`/api/customers?${query}`);
  return result.success ? result.data.customers : [];
}
