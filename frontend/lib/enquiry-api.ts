import type {
  CustomerView,
  EnquiryDetail,
  EnquirySummary,
  VendorView,
} from '@rs/shared';
import { cache } from 'react';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the Product Enquiry API.
 *
 * Every shape here comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract, this file stops compiling.
 */

export type EnquiryListResult = {
  enquiries: EnquirySummary[];
};

export type ListMeta = {
  nextCursor?: string | null;
  serverTime?: string;
};

export async function fetchEnquiries(
  params: Record<string, string | undefined>,
): Promise<{ result: ApiResult<EnquiryListResult>; meta: ListMeta }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }

  const result = await apiFetch<EnquiryListResult>(`/api/product-enquiries?${query}`);
  return { result, meta: result.success ? ((result.meta ?? {}) as ListMeta) : {} };
}

/**
 * Deduplicated per render pass.
 *
 * `generateMetadata` and the page component both need the enquiry, and this is
 * the heaviest query in the module — the full tree of products, vendor
 * responses and events. Without `cache` it ran twice for every detail page
 * view, doubling the round trip to a database several thousand kilometres away.
 */
export const fetchEnquiry = cache(
  async (
    id: string,
  ): Promise<{ result: ApiResult<{ enquiry: EnquiryDetail }>; serverTime?: string }> => {
    const result = await apiFetch<{ enquiry: EnquiryDetail }>(`/api/product-enquiries/${id}`);
    return {
      result,
      serverTime: result.success ? ((result.meta?.serverTime as string) ?? undefined) : undefined,
    };
  },
);

export async function fetchCustomers(q?: string): Promise<CustomerView[]> {
  const query = new URLSearchParams({ limit: '20' });
  if (q) query.set('q', q);
  const result = await apiFetch<{ customers: CustomerView[] }>(`/api/customers?${query}`);
  return result.success ? result.data.customers : [];
}

export async function fetchVendors(q?: string): Promise<VendorView[]> {
  const query = new URLSearchParams({ limit: '20' });
  if (q) query.set('q', q);
  const result = await apiFetch<{ vendors: VendorView[] }>(`/api/vendors?${query}`);
  return result.success ? result.data.vendors : [];
}

/** Employees who can be assigned "Towards". */
export type Assignee = { id: string; name: string; employeeId: string };
