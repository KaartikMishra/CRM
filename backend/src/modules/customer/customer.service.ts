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
  type: true,
  phone: true,
  email: true,
  createdAt: true,
} as const;

type Row = {
  id: string;
  name: string;
  type: CustomerView['type'];
  phone: string | null;
  email: string | null;
  createdAt: Date;
};

const toView = (row: Row): CustomerView => ({
  id: row.id,
  name: row.name,
  type: row.type,
  phone: row.phone,
  email: row.email,
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
      type: input.type,
      phone: input.phone ?? null,
      email: input.email ?? null,
    },
    select: view,
  });

  return toView(row);
}
