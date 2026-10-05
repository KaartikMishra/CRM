/**
 * All Prisma access for Create Lead / Deal.
 *
 * Two things this file deliberately never does:
 *
 *   - **It never writes a Customer.** A lead points at the existing master by
 *     foreign key. Creating one goes through the Customer module's own service,
 *     so there is exactly one place that decides what a customer is.
 *
 *   - **It never matches a phone in SQL.** Postgres has no digits-only
 *     comparison that can use an index here, and the stored values are written
 *     a dozen different ways. Matching happens in `lead.service.ts` through the
 *     shared `normalizePhone`, so the frontend, the backend and the tests all
 *     agree on what "the same number" means.
 *
 * Selects are explicit rather than bare `include`, so nothing can accidentally
 * return a password hash.
 */

import { Prisma } from '@rs/database';
import type { LeadChannel } from '@rs/shared';
import { prisma } from '../../config/database.js';

const userRef = { id: true, name: true, employeeId: true, role: true } as const;

const customerView = {
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

export const leadSelect = {
  id: true,
  leadSource: true,
  leadSourceOther: true,
  sourceDetails: true,
  sourceAt: true,
  requirementType: true,
  channel: true,
  channelOther: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: customerView },
  createdBy: { select: userRef },
} satisfies Prisma.LeadSelect;

export type LeadRecord = Prisma.LeadGetPayload<{ select: typeof leadSelect }>;

export type CustomerRecord = Prisma.CustomerGetPayload<{ select: typeof customerView }>;

export function findLead(id: string): Promise<LeadRecord | null> {
  return prisma.lead.findUnique({ where: { id }, select: leadSelect });
}

export function createLead(
  tx: Prisma.TransactionClient,
  data: {
    leadSource: LeadRecord['leadSource'];
    leadSourceOther: string | null;
    sourceDetails: string | null;
    sourceAt: Date;
    requirementType: LeadRecord['requirementType'];
    customerId: string;
    channel: LeadChannel;
    channelOther: string | null;
    createdById: string;
  },
): Promise<{ id: string }> {
  return tx.lead.create({ data, select: { id: true } });
}

/**
 * Every customer carrying a phone number at all.
 *
 * Read in full and filtered in the service rather than matched in SQL, because
 * the comparison is on digits with every separator removed and the column
 * stores whatever the person typed. A `LIKE` would miss `+91-85288-85250` when
 * the query was `+91 85288 85250`, and a `regexp_replace` on the column cannot
 * use an index either — so the honest version does the fold once, in one place,
 * with the same helper the frontend uses.
 *
 * The Customer master is a few thousand rows at most; if it ever grows past
 * that, the fix is a stored normalized column with its own index, which is an
 * additive change this design does not block.
 */
export function findCustomersWithPhone(): Promise<CustomerRecord[]> {
  return prisma.customer.findMany({
    where: { phone: { not: null } },
    select: customerView,
    orderBy: { createdAt: 'asc' },
  });
}

export function findCustomerById(id: string): Promise<CustomerRecord | null> {
  return prisma.customer.findUnique({ where: { id }, select: customerView });
}
