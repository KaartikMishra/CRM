import type {
  VendorListRow,
  VendorMappingRow,
  VendorSummary,
  VendorTradeRow,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the Vendor Invoices API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract this file stops compiling. Mirrors
 * lib/rs-product-api.ts.
 *
 * These are read paths only. Mutations go through server actions, so that the
 * session token never leaves the server in either direction.
 */

export type ListMeta = { nextCursor?: string | null };

/** The vendor list page size. Kept here so the UI and the request agree. */
export const VENDOR_PAGE_LIMIT = 25;

/**
 * The trade-history and mapping page sizes.
 *
 * Both render inside the vendor drawer rather than on a page of their own, so
 * they are smaller: a drawer that needs scrolling past fifty rows before its
 * second section is reachable is worse than one that pages.
 */
export const TRADE_PAGE_LIMIT = 20;
export const MAPPING_PAGE_LIMIT = 20;

function withParams(
  base: Record<string, string | undefined>,
  limit: number,
): URLSearchParams {
  const query = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  return query;
}

export async function fetchVendors(
  params: Record<string, string | undefined>,
): Promise<{ result: ApiResult<{ vendors: VendorListRow[] }>; meta: ListMeta }> {
  const query = withParams(params, VENDOR_PAGE_LIMIT);
  const result = await apiFetch<{ vendors: VendorListRow[] }>(
    `/api/vendor-invoices/vendors?${query}`,
  );
  return { result, meta: result.success ? ((result.meta ?? {}) as ListMeta) : {} };
}

/** One vendor's details, for the drawer header. */
export async function fetchVendor(id: string): Promise<ApiResult<{ vendor: VendorSummary }>> {
  return apiFetch<{ vendor: VendorSummary }>(`/api/vendor-invoices/vendors/${id}`);
}

/**
 * What the CRM has actually bought from this vendor.
 *
 * Read-only by construction — these are Procurement's own PurchaseBillItem
 * records, and this module has no write path to them.
 */
export async function fetchVendorTrades(
  id: string,
  params: Record<string, string | undefined> = {},
): Promise<{ result: ApiResult<{ trades: VendorTradeRow[] }>; meta: ListMeta }> {
  const query = withParams(params, TRADE_PAGE_LIMIT);
  const result = await apiFetch<{ trades: VendorTradeRow[] }>(
    `/api/vendor-invoices/vendors/${id}/trades?${query}`,
  );
  return { result, meta: result.success ? ((result.meta ?? {}) as ListMeta) : {} };
}

/** What this vendor supplies, and what they charge for it today. */
export async function fetchMappings(
  params: Record<string, string | undefined>,
): Promise<{ result: ApiResult<{ mappings: VendorMappingRow[] }>; meta: ListMeta }> {
  const query = withParams(params, MAPPING_PAGE_LIMIT);
  const result = await apiFetch<{ mappings: VendorMappingRow[] }>(
    `/api/vendor-invoices/mappings?${query}`,
  );
  return { result, meta: result.success ? ((result.meta ?? {}) as ListMeta) : {} };
}
