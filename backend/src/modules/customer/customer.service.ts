/**
 * The Customer master, kept to exactly what Product Enquiry needs: look one up,
 * or add one. There is no update or delete here — a fuller Customer module
 * belongs to its own phase, and inventing it now would be guessing at rules
 * that have not been specified.
 *
 * §3 — customer type lives on the customer, and historical enquiries keep
 * pointing at the same row, so editing the master is deliberately not exposed.
 */

import type { CreateCustomerInput, CustomerSearchQuery, CustomerView } from '@rs/shared';
import { prisma } from '../../config/database.js';

const view = {
  id: true,
  name: true,
  companyName: true,
  type: true,
  phone: true,
  email: true,
  address: true,
  state: true,
  country: true,
  gstNumber: true,
  createdAt: true,
} as const;

type Row = {
  id: string;
  name: string;
  companyName: string | null;
  type: CustomerView['type'];
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  country: string | null;
  gstNumber: string | null;
  createdAt: Date;
};

const toView = (row: Row): CustomerView => ({
  id: row.id,
  name: row.name,
  companyName: row.companyName,
  type: row.type,
  phone: row.phone,
  email: row.email,
  address: row.address,
  state: row.state,
  country: row.country,
  gstNumber: row.gstNumber,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Search for the picker. Ordered by name so the list is predictable, and
 * capped, because this feeds a typeahead rather than a browsable directory.
 */
export async function searchCustomers(query: CustomerSearchQuery): Promise<CustomerView[]> {
  const rows = await prisma.customer.findMany({
    where: {
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
      ...(query.type ? { type: query.type } : {}),
    },
    select: view,
    orderBy: { name: 'asc' },
    take: query.limit,
  });

  return rows.map(toView);
}

export async function createCustomer(input: CreateCustomerInput): Promise<CustomerView> {
  const row = await prisma.customer.create({
    data: {
      name: input.name,
      companyName: input.companyName ?? null,
      type: input.type,
      phone: input.phone ?? null,
      email: input.email ?? null,
      // Blank optional fields are stored as NULL, never as an empty string, so
      // "not recorded" has exactly one representation in the column.
      address: input.address ?? null,
      // Both arrive already normalised by the shared schema — the state as one
      // of the 28 official names, the GSTIN trimmed and uppercased — so there
      // is nothing left to clean up here.
      state: input.state ?? null,
      country: input.country ?? null,
      gstNumber: input.gstNumber ?? null,
    },
    select: view,
  });

  return toView(row);
}
