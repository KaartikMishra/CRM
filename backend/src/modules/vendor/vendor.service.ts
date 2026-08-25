/**
 * The Vendor master — look one up, or add one.
 *
 * §37 of the original brief makes vendors a reusable entity: a vendor is
 * created once and referenced by every quote they give, rather than re-entered
 * per enquiry. The search endpoint is what makes that reuse possible from the
 * UI; without it every vendor response would have to invent a new vendor.
 *
 * Vendor.name is unique in the schema, so a duplicate create surfaces as the
 * existing DUPLICATE_RECORD error rather than silently forking the master.
 */

import type { CreateVendorInput, VendorSearchQuery, VendorView } from '@rs/shared';
import { prisma } from '../../config/database.js';

const view = {
  id: true,
  name: true,
  contactPerson: true,
  phone: true,
  email: true,
  city: true,
  isActive: true,
} as const;

export async function searchVendors(query: VendorSearchQuery): Promise<VendorView[]> {
  return prisma.vendor.findMany({
    where: {
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
      // Default to active only: a deactivated vendor should not appear in a
      // picker, since the vendor-response service refuses them anyway.
      isActive: query.active === undefined ? true : query.active,
    },
    select: view,
    orderBy: { name: 'asc' },
    take: query.limit,
  });
}

export async function createVendor(input: CreateVendorInput): Promise<VendorView> {
  return prisma.vendor.create({
    data: {
      name: input.name,
      contactPerson: input.contactPerson ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      city: input.city ?? null,
    },
    select: view,
  });
}
