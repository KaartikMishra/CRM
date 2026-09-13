import type { RsProductDetail, RsProductListRow } from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the RS Products API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract this file stops compiling. Mirrors
 * lib/procurement-api.ts.
 */

export type ListMeta = { nextCursor?: string | null };

/** The catalogue page size. Kept here so the UI and the request agree. */
export const RS_PRODUCT_PAGE_LIMIT = 50;

export async function fetchRsProducts(
  params: Record<string, string | undefined>,
): Promise<{ result: ApiResult<{ products: RsProductListRow[] }>; meta: ListMeta }> {
  const query = new URLSearchParams({ limit: String(RS_PRODUCT_PAGE_LIMIT) });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }

  const result = await apiFetch<{ products: RsProductListRow[] }>(`/api/rs-products?${query}`);
  return { result, meta: result.success ? ((result.meta ?? {}) as ListMeta) : {} };
}

/** The productType values the catalogue actually holds, for the filter. */
export async function fetchProductTypes(): Promise<string[]> {
  const result = await apiFetch<{ productTypes: string[] }>('/api/rs-products/product-types');
  return result.success ? result.data.productTypes : [];
}

/** One product with its variants, for the edit form. */
export async function fetchRsProduct(
  id: string,
): Promise<ApiResult<{ product: RsProductDetail }>> {
  return apiFetch<{ product: RsProductDetail }>(`/api/rs-products/${id}`);
}
