import { cache } from 'react';
import type {
  OrderRequirementView,
  ProductChangeView,
  PurchaseBillDetail,
  PurchaseBillSummary,
  SalesRequirementRow,
  SalesFulfillmentDetail,
  ShortageRow,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the Purchase & Procurement API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract this file stops compiling. Mirrors lib/sales-api.ts.
 */

export type ListMeta = { nextCursor?: string | null };

export async function fetchPurchaseBills(
  params: Record<string, string | undefined>,
): Promise<{ result: ApiResult<{ bills: PurchaseBillSummary[] }>; meta: ListMeta }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }

  const result = await apiFetch<{ bills: PurchaseBillSummary[] }>(`/api/procurement/bills?${query}`);
  return { result, meta: result.success ? ((result.meta ?? {}) as ListMeta) : {} };
}

/**
 * Deduplicated per render pass: generateMetadata and the page body both need
 * the bill, and the API sits a long way from here.
 */
export const fetchPurchaseBill = cache(
  async (id: string): Promise<ApiResult<{ bill: PurchaseBillDetail }>> =>
    apiFetch<{ bill: PurchaseBillDetail }>(`/api/procurement/bills/${id}`),
);

/** The SALES board: outstanding customer demand. */
export async function fetchSalesRequirements(date?: string): Promise<SalesRequirementRow[]> {
  // Without a date the whole board comes back, so Active is never filtered.
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  const result = await apiFetch<{ requirements: SalesRequirementRow[] }>(
    `/api/procurement/sales-requirements${query}`,
  );
  return result.success ? result.data.requirements : [];
}

/** One History row's full fulfilment story. Fetched only when opened. */
export async function fetchFulfillmentDetail(
  salesOrderItemId: string,
): Promise<ApiResult<{ detail: SalesFulfillmentDetail }>> {
  return apiFetch<{ detail: SalesFulfillmentDetail }>(
    `/api/procurement/order-lines/${salesOrderItemId}/fulfillment-detail`,
  );
}

export async function fetchShortages(): Promise<ShortageRow[]> {
  const result = await apiFetch<{ shortages: ShortageRow[] }>('/api/procurement/shortages');
  return result.success ? result.data.shortages : [];
}

/**
 * Undecided requests to re-map a purchase line, for the approval queue.
 *
 * An empty list on failure, like the readers above: the queue is one section of
 * a page, and a Procurement page that refused to render because this call
 * failed would hide the bills too. Anyone without the capability to act on these
 * simply sees nothing here, which is also what the API returns them.
 */
export async function fetchPendingProductChanges(): Promise<ProductChangeView[]> {
  const result = await apiFetch<{ changes: ProductChangeView[] }>(
    '/api/procurement/product-changes?status=PENDING',
  );
  return result.success ? result.data.changes : [];
}

/**
 * The vendor master, reused from Product Enquiry — not a second list.
 *
 * The limit is capped at 50 because that is what `vendorSearchSchema` allows;
 * asking for more is a 422, and this reader would then quietly return an empty
 * list and leave the picker looking empty rather than broken. `active` filters
 * out retired vendors, which cannot be bought from.
 */
export const VENDOR_PAGE_LIMIT = 50;

export async function fetchVendors(): Promise<{ id: string; name: string }[]> {
  const query = new URLSearchParams({ limit: String(VENDOR_PAGE_LIMIT), active: 'true' });
  const result = await apiFetch<{ vendors: { id: string; name: string }[] }>(
    `/api/vendors?${query}`,
  );
  return result.success ? result.data.vendors : [];
}

export async function fetchOrderRequirements(
  orderId: string,
): Promise<ApiResult<{ order: OrderRequirementView }>> {
  return apiFetch<{ order: OrderRequirementView }>(
    `/api/procurement/order-requirements?orderId=${encodeURIComponent(orderId)}`,
  );
}
