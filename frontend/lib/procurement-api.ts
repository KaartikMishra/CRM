import { cache } from 'react';
import type {
  OrderRequirementView,
  ProductView,
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

export async function fetchProducts(q?: string): Promise<ProductView[]> {
  const query = new URLSearchParams({ limit: '200' });
  if (q) query.set('q', q);
  const result = await apiFetch<{ products: ProductView[] }>(`/api/procurement/products?${query}`);
  return result.success ? result.data.products : [];
}

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
