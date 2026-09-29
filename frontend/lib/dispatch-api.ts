import { cache } from 'react';
import type {
  DispatchDetail,
  DispatchSummary,
  DispatchView,
  PartialDispatchRequestView,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the Packing & Dispatch API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract this file stops compiling. Mirrors
 * lib/procurement-api.ts.
 *
 * Nothing here computes readiness. The board and the detail both report figures
 * the API derived from Procurement's own ledger, and recomputing them in the
 * browser would create a second answer to a question that already has one.
 */

export type ListMeta = { nextCursor?: string | null };

/** The board: orders worth a dispatcher's attention. */
export async function fetchDispatchBoard(
  params: Record<string, string | undefined>,
): Promise<{ result: ApiResult<{ orders: DispatchSummary[] }>; meta: ListMeta }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }

  const result = await apiFetch<{ orders: DispatchSummary[] }>(`/api/dispatch/board?${query}`);
  return { result, meta: result.success ? ((result.meta ?? {}) as ListMeta) : {} };
}

/**
 * One order's full dispatch picture.
 *
 * Deduplicated per render pass: generateMetadata and the page body both need
 * the order, and the API sits a long way from here.
 */
export const fetchDispatchOrder = cache(
  async (id: string): Promise<ApiResult<{ detail: DispatchDetail }>> =>
    apiFetch<{ detail: DispatchDetail }>(`/api/dispatch/orders/${id}`),
);

/**
 * Every partial-dispatch request an order has ever carried, newest first.
 *
 * Kept as a separate reader even though `fetchDispatchOrder` embeds the same
 * list: the history panel refetches after a decision without reloading the
 * whole order.
 *
 * There are deliberately no single-record readers for one shipment or one
 * partial request. `GET /api/dispatch/shipments/:id` and
 * `/api/dispatch/partial-requests/:id` both exist on the API, but the order
 * detail already returns every shipment and every request in full, so a helper
 * that fetched one again would be a second way to get data the page is holding
 * — and the two could disagree. If a standalone shipment page is ever built,
 * that is the moment to add one back.
 */
export async function fetchPartialRequests(
  salesOrderId: string,
): Promise<ApiResult<{ requests: PartialDispatchRequestView[] }>> {
  return apiFetch<{ requests: PartialDispatchRequestView[] }>(
    `/api/dispatch/orders/${salesOrderId}/partial-requests`,
  );
}
