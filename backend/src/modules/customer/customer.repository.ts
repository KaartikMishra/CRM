/**
 * All Customers — database access.
 *
 * The missing layer. `customer.service.ts` has always talked to Prisma directly
 * because it did two things: a name typeahead and a create. The directory is a
 * different shape — filters, aggregates, pagination and a profile that gathers
 * five kinds of related record — so it gets the `routes → controller → service
 * → repository` split every other module uses.
 *
 * ### No money arithmetic happens here
 *
 * Order values come from Sales' own `toMoney`, reached through the select shape
 * the Lead module already established. This file assembles the rows `toMoney`
 * consumes and hands the result to the metrics helper; it never multiplies a
 * quantity by a price, and it never reads a GST rate. One definition of what an
 * order comes to, four readers.
 *
 * ### Filtering and ordering happen in SQL
 *
 * Not in memory. The existing `lookupCustomersByPhone` reads every
 * phone-bearing customer and filters in JavaScript, which is fine for one lead
 * form and wrong for a directory — and `phoneNormalized` exists precisely so
 * this layer does not have to repeat it.
 */

import { Prisma } from '@rs/database';
import { normalizePhone, type CustomerDirectoryQuery } from '@rs/shared';
import { prisma } from '../../config/database.js';
import { orderMoneySelect } from './customer.money.js';

/**
 * Exactly what `toMoney` consumes, plus the order facts the directory shows.
 *
 * Re-exported from `customer.money.ts` so there is one statement of it per
 * module rather than a copy drifting inside each query below.
 */
export { orderMoneySelect };

/** The identity columns every customer view starts from. */
const customerIdentity = {
  id: true,
  name: true,
  companyName: true,
  type: true,
  phone: true,
  phoneNormalized: true,
  email: true,
  address: true,
  state: true,
  country: true,
  gstNumber: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Source events, for first-touch and last-touch.
 *
 * Both record types, with the timestamp each one actually means: a lead's
 * `sourceAt` is a business instant somebody recorded, an enquiry's `createdAt`
 * is when the row was written. The attribution helper knows the difference and
 * breaks ties on it.
 */
const attributionSelect = {
  leads: {
    select: {
      id: true,
      leadSource: true,
      leadSourceOther: true,
      channel: true,
      channelOther: true,
      sourceAt: true,
    },
  },
  enquiries: {
    select: { id: true, source: true, sourceDetail: true, createdAt: true },
  },
} as const;

export type CustomerDirectoryRecord = Prisma.CustomerGetPayload<{
  select: typeof customerIdentity & typeof attributionSelect;
}>;

/**
 * Translates the validated query into a Prisma filter.
 *
 * Search spans the five identifiers a person actually has to hand: name,
 * company, phone, email and GSTIN. The phone arm compares `phoneNormalized`
 * against the digits of the query through the same `normalizePhone` fold the
 * lead lookup uses, so "+91 85288 85250" and "8528885250" find the same row.
 */
function whereFor(query: CustomerDirectoryQuery): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = {};
  const and: Prisma.CustomerWhereInput[] = [];

  if (query.q) {
    const digits = normalizePhone(query.q);
    const or: Prisma.CustomerWhereInput[] = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { companyName: { contains: query.q, mode: 'insensitive' } },
      { email: { contains: query.q, mode: 'insensitive' } },
      { gstNumber: { contains: query.q.toUpperCase() } },
    ];
    /*
      Only when the query actually holds digits. `normalizePhone('abc')` is the
      empty string, and `contains: ''` matches every row — so an empty fold must
      not become a filter arm at all.
    */
    if (digits !== '') or.push({ phoneNormalized: { contains: digits } });
    and.push({ OR: or });
  }

  if (query.type) and.push({ type: query.type });
  if (query.state) and.push({ state: query.state });
  if (query.country) and.push({ country: query.country });

  /*
    "Has orders" means has an order that counts as a purchase. A customer whose
    only order was cancelled has not bought anything, so CANCELLED is excluded
    here exactly as it is in the money figures.
  */
  if (query.hasOrders === true) {
    and.push({ salesOrders: { some: { status: { not: 'CANCELLED' } } } });
  }
  if (query.hasOrders === false) {
    and.push({ salesOrders: { none: { status: { not: 'CANCELLED' } } } });
  }

  if (query.purchasedFrom || query.purchasedTo) {
    and.push({
      salesOrders: {
        some: {
          status: { not: 'CANCELLED' },
          orderDate: {
            ...(query.purchasedFrom ? { gte: query.purchasedFrom } : {}),
            ...(query.purchasedTo ? { lte: query.purchasedTo } : {}),
          },
        },
      },
    });
  }

  /*
    Only pairs still awaiting a decision. A confirmed or dismissed pair has been
    looked at, and leaving it in the filter would keep flagging rows somebody
    has already judged.
  */
  if (query.duplicatesOnly) {
    and.push({
      OR: [
        { duplicateCandidatesAsA: { some: { status: 'SUGGESTED' } } },
        { duplicateCandidatesAsB: { some: { status: 'SUGGESTED' } } },
      ],
    });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

/**
 * Whether the requested sort is a column or an aggregate.
 *
 * `name` and `createdAt` are columns, so they page by keyset. The other three
 * are derived from orders that no column holds; ordering by them needs the
 * aggregate, which keyset pagination over `Customer` cannot express. The caller
 * is told which mode it got rather than being handed a cursor that would
 * silently skip or repeat rows.
 */
export function isColumnSort(sort: CustomerDirectoryQuery['sort']): boolean {
  return sort === 'name' || sort === 'createdAt';
}

/**
 * Ordering, always ending in `id`.
 *
 * The tiebreaker is what makes keyset pagination correct. Customer names are
 * explicitly not unique — the schema says so, because two real firms share a
 * name — so ordering by name alone would let a row appear on two pages or on
 * none.
 */
function orderFor(query: CustomerDirectoryQuery): Prisma.CustomerOrderByWithRelationInput[] {
  const dir = query.direction;
  switch (query.sort) {
    case 'createdAt':
      return [{ createdAt: dir }, { id: 'asc' }];
    case 'name':
    default:
      return [{ name: dir }, { id: 'asc' }];
  }
}

/**
 * A page of the directory, by keyset.
 *
 * Takes limit + 1 so the presence of a further page is known without a second
 * count query.
 */
export async function listCustomersByColumn(query: CustomerDirectoryQuery): Promise<{
  rows: CustomerDirectoryRecord[];
  nextCursor: string | null;
}> {
  const rows = await prisma.customer.findMany({
    where: whereFor(query),
    select: { ...customerIdentity, ...attributionSelect },
    orderBy: orderFor(query),
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return { rows: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

/**
 * A page of the directory ordered by a derived aggregate.
 *
 * Offset rather than keyset, and deliberately so: the ordering key is not a
 * column, so there is no stable value to seek from. The total is returned with
 * it, which is what lets the UI render real page numbers instead of pretending
 * a cursor exists.
 */
export async function listCustomersByAggregate(query: CustomerDirectoryQuery): Promise<{
  rows: CustomerDirectoryRecord[];
  total: number;
}> {
  const where = whereFor(query);
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      select: { ...customerIdentity, ...attributionSelect },
      // Ordering by the aggregate happens in the service, over the full
      // filtered set; see sortByAggregate there for why that is honest here.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    prisma.customer.count({ where }),
  ]);
  return { rows, total };
}

/** Every customer id that currently appears in an open duplicate suggestion. */
export async function customerIdsWithOpenDuplicates(
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const pairs = await prisma.customerDuplicateCandidate.findMany({
    where: {
      status: 'SUGGESTED',
      OR: [{ customerAId: { in: [...ids] } }, { customerBId: { in: [...ids] } }],
    },
    select: { customerAId: true, customerBId: true },
  });

  const flagged = new Set<string>();
  for (const pair of pairs) {
    flagged.add(pair.customerAId);
    flagged.add(pair.customerBId);
  }
  return flagged;
}

/**
 * Order money and dates for a set of customers, in one query.
 *
 * One query for the whole page rather than one per customer: a directory row
 * showing an order count and a purchase value is exactly the shape that becomes
 * an N+1 by accident. The rows are grouped by customer in the service.
 */
export async function orderFactsForCustomers(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return prisma.salesOrder.findMany({
    where: { customerId: { in: [...ids] } },
    select: {
      id: true,
      customerId: true,
      // The customer-facing reference, unique and distinct from the cuid `id`.
      orderId: true,
      orderDate: true,
      ...orderMoneySelect.select,
    },
  });
}

/** Lead conversion facts for a set of customers, in one query. */
export async function leadFactsForCustomers(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return prisma.lead.findMany({
    where: { customerId: { in: [...ids] } },
    select: {
      id: true,
      customerId: true,
      dealStatus: true,
      salesOrderId: true,
      salesOrder: { select: { status: true } },
    },
  });
}

/** Latest enquiry timestamp per customer, in one grouped query. */
export async function lastEnquiryForCustomers(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return prisma.productEnquiry.groupBy({
    by: ['customerId'],
    where: { customerId: { in: [...ids] } },
    _max: { createdAt: true },
    _count: { _all: true },
  });
}

// ---------------------------------------------------------------------------
//  Phase A2 — one customer's history
// ---------------------------------------------------------------------------

/*
  Each of these pages its own relation rather than loading the customer's whole
  history. A customer with four hundred orders is a real possibility, and the
  profile shows a page at a time, so `take: limit + 1` is how a further page is
  detected without a second count query — the same trick the directory uses.

  Every query filters on `customerId`, which is what keeps one customer's
  history out of another's profile. That is asserted in the tests rather than
  trusted.
*/

/** A page of the customer's enquiries, newest first. */
export async function enquiriesForCustomer(customerId: string, limit: number, cursor?: string) {
  return prisma.productEnquiry.findMany({
    where: { customerId },
    select: {
      id: true,
      enquiryNo: true,
      source: true,
      sourceDetail: true,
      status: true,
      createdAt: true,
      assignedTo: { select: { id: true, name: true } },
      // Counted rather than listed: the profile row shows how many products an
      // enquiry carried, and the enquiry's own page shows what they were.
      _count: { select: { products: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** A page of the customer's leads, newest business instant first. */
export async function leadsForCustomer(customerId: string, limit: number, cursor?: string) {
  return prisma.lead.findMany({
    where: { customerId },
    select: {
      id: true,
      leadSource: true,
      leadSourceOther: true,
      channel: true,
      channelOther: true,
      requirementType: true,
      dealStatus: true,
      salesOrderId: true,
      // Needed to decide `isConverted`: a lead linked to a cancelled order has
      // not converted, so the link alone is not the answer.
      salesOrder: { select: { status: true } },
      // A lead's owner is its `associate`, not an `assignedTo` — the Lead model
      // names it that way and an unassigned lead is a real state, so it is
      // nullable.
      associate: { select: { id: true, name: true } },
      sourceAt: true,
      createdAt: true,
    },
    orderBy: [{ sourceAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/**
 * A page of the customer's orders, with everything `toMoney` consumes.
 *
 * Ordered by `orderDate` — the business date — rather than `createdAt`, because
 * that is the date the rest of the CRM treats as when the order happened.
 */
export async function ordersForCustomer(customerId: string, limit: number, cursor?: string) {
  return prisma.salesOrder.findMany({
    where: { customerId },
    select: {
      id: true,
      orderId: true,
      orderDate: true,
      ...orderMoneySelect.select,
      _count: { select: { items: true } },
    },
    orderBy: [{ orderDate: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/**
 * Raw material for the timeline.
 *
 * Six queries in parallel rather than a union: the sources live in different
 * tables with different shapes, and Prisma has no cross-model ordering. Each is
 * capped so one very active customer cannot pull an unbounded set into memory,
 * and the service merges and orders them.
 *
 * The cap is the honest limitation here: a customer with more than `perSource`
 * events of one kind has older ones omitted from the merged view. The service
 * reports whether any source was truncated rather than presenting a partial
 * history as complete.
 */
export async function timelineSourcesForCustomer(customerId: string, perSource: number) {
  const [enquiries, enquiryEvents, leads, leadActivities, orders, payments, refunds, cases] =
    await Promise.all([
      prisma.productEnquiry.findMany({
        where: { customerId },
        select: { id: true, enquiryNo: true, source: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: perSource,
      }),
      prisma.enquiryEvent.findMany({
        where: { enquiry: { customerId } },
        select: {
          id: true,
          type: true,
          field: true,
          occurredAt: true,
          enquiryId: true,
          actor: { select: { id: true, name: true } },
        },
        orderBy: { occurredAt: 'desc' },
        take: perSource,
      }),
      prisma.lead.findMany({
        where: { customerId },
        select: { id: true, leadSource: true, channel: true, sourceAt: true },
        orderBy: { sourceAt: 'desc' },
        take: perSource,
      }),
      prisma.leadActivity.findMany({
        where: { lead: { customerId } },
        select: {
          id: true,
          kind: true,
          dueAt: true,
          completedAt: true,
          note: true,
          leadId: true,
          performedBy: { select: { id: true, name: true } },
        },
        orderBy: { dueAt: 'desc' },
        take: perSource,
      }),
      prisma.salesOrder.findMany({
        where: { customerId },
        select: {
          id: true,
          orderId: true,
          orderDate: true,
          status: true,
          cancelledAt: true,
          cancellationReason: true,
        },
        orderBy: { orderDate: 'desc' },
        take: perSource,
      }),
      prisma.salesPayment.findMany({
        where: { order: { customerId } },
        select: {
          id: true,
          amount: true,
          method: true,
          recordedAt: true,
          orderId: true,
          recordedBy: { select: { id: true, name: true } },
        },
        orderBy: { recordedAt: 'desc' },
        take: perSource,
      }),
      prisma.salesRefund.findMany({
        where: { order: { customerId } },
        select: {
          id: true,
          amount: true,
          status: true,
          requestedAt: true,
          settledAt: true,
          orderId: true,
        },
        orderBy: { requestedAt: 'desc' },
        take: perSource,
      }),
      prisma.postSalesCase.findMany({
        where: { customerId },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: perSource,
      }),
    ]);

  return { enquiries, enquiryEvents, leads, leadActivities, orders, payments, refunds, cases };
}

/** Who holds this customer's records, per record. Never one "primary owner". */
export async function assigneesForCustomer(customerId: string) {
  const [enquiryOwners, leadOwners] = await Promise.all([
    prisma.productEnquiry.groupBy({
      by: ['assignedToId'],
      where: { customerId },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ['associateId'],
      where: { customerId, associateId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  return { enquiryOwners, leadOwners };
}

/** Names for a set of user ids, in one query. */
export async function usersByIds(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, employeeId: true },
  });
}

/** Every order's money for one customer — the profile's aggregate needs them all. */
export async function allOrdersForCustomerMoney(customerId: string) {
  return prisma.salesOrder.findMany({
    where: { customerId },
    select: { id: true, orderDate: true, ...orderMoneySelect.select },
  });
}

/** Every lead's conversion facts for one customer. */
export async function allLeadsForCustomerConversion(customerId: string) {
  return prisma.lead.findMany({
    where: { customerId },
    select: {
      id: true,
      dealStatus: true,
      salesOrderId: true,
      salesOrder: { select: { status: true } },
    },
  });
}

/** Enquiry count and latest timestamp for one customer. */
export async function enquirySummaryForCustomer(customerId: string) {
  const [count, latest] = await Promise.all([
    prisma.productEnquiry.count({ where: { customerId } }),
    prisma.productEnquiry.findFirst({
      where: { customerId },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { count, lastAt: latest?.createdAt ?? null };
}

/** Whether this customer sits in any still-open duplicate suggestion. */
export async function hasOpenDuplicate(customerId: string): Promise<boolean> {
  const found = await prisma.customerDuplicateCandidate.findFirst({
    where: {
      status: 'SUGGESTED',
      OR: [{ customerAId: customerId }, { customerBId: customerId }],
    },
    select: { id: true },
  });
  return found !== null;
}

// ---------------------------------------------------------------------------
//  Duplicate review
// ---------------------------------------------------------------------------

/*
  The pair is always stored with `customerAId < customerBId`, enforced by a
  CHECK constraint and a unique index in the migration. Callers must put the
  pair through `orderedPair` before touching this table — these functions take
  the ids as given and do not reorder, because a silent reorder here would hide
  a caller that had got it wrong.
*/

/** Enough of each side to judge a pair: identity plus what hangs off it. */
const duplicateSideSelect = {
  select: {
    id: true,
    name: true,
    companyName: true,
    phone: true,
    email: true,
    gstNumber: true,
    state: true,
    createdAt: true,
    /*
      The record counts are the point of the comparison. Deciding whether two
      rows are one customer means knowing what each one carries: a row with
      eleven orders and one with none are not interchangeable, whatever their
      phone numbers agree about.
    */
    _count: { select: { salesOrders: true, enquiries: true, leads: true } },
  },
} as const;

/** A page of candidates at one status, strongest match first. */
export async function listDuplicateCandidates(
  status: 'SUGGESTED' | 'CONFIRMED' | 'DISMISSED',
  limit: number,
  cursor?: string,
) {
  return prisma.customerDuplicateCandidate.findMany({
    where: { status },
    select: {
      id: true,
      score: true,
      matchedOn: true,
      identifierFingerprint: true,
      status: true,
      decidedAt: true,
      createdAt: true,
      decidedBy: { select: { id: true, name: true } },
      customerA: duplicateSideSelect,
      customerB: duplicateSideSelect,
    },
    /*
      Score first so the strongest matches are reviewed first, then id — which
      is what makes the order total. Score alone is not unique, so without the
      tiebreaker a row could appear on two pages or on none.
    */
    orderBy: [{ score: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** One candidate with both sides, or null. */
export async function findDuplicateCandidate(id: string) {
  return prisma.customerDuplicateCandidate.findUnique({
    where: { id },
    select: {
      id: true,
      score: true,
      matchedOn: true,
      identifierFingerprint: true,
      status: true,
      decidedAt: true,
      createdAt: true,
      decidedBy: { select: { id: true, name: true } },
      customerA: duplicateSideSelect,
      customerB: duplicateSideSelect,
    },
  });
}

/**
 * Records a decision.
 *
 * Writes to `CustomerDuplicateCandidate` and nothing else. No customer row,
 * enquiry, lead or order is touched — confirming a pair is a statement that
 * somebody looked at it and agreed, not a merge. Merging is a separate decision
 * with its own rules, and nothing here presumes it.
 */
export async function decideDuplicateCandidate(
  id: string,
  status: 'CONFIRMED' | 'DISMISSED',
  decidedById: string,
) {
  return prisma.customerDuplicateCandidate.update({
    where: { id },
    data: { status, decidedById, decidedAt: new Date() },
    select: { id: true, status: true, decidedAt: true },
  });
}

/** Every candidate's stored fingerprint, for a rescan to compare against. */
export async function existingCandidateFingerprints() {
  return prisma.customerDuplicateCandidate.findMany({
    select: {
      id: true,
      customerAId: true,
      customerBId: true,
      status: true,
      identifierFingerprint: true,
    },
  });
}

/**
 * Candidates counted per status, for the review page's filter tabs.
 *
 * A grouped count rather than three queries, and it returns every status even
 * when empty so a tab reading "0" is distinguishable from a tab whose count
 * failed to load.
 */
export async function duplicateCandidateCounts() {
  const rows = await prisma.customerDuplicateCandidate.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const counts = { SUGGESTED: 0, CONFIRMED: 0, DISMISSED: 0 };
  for (const row of rows) {
    counts[row.status] = row._count._all;
  }
  return counts;
}

/**
 * Identifier-bearing customers, for a rescan.
 *
 * Only rows carrying at least one comparable identifier: a customer with no
 * phone, email, GSTIN or company cannot match anything, so loading it would be
 * work for a guaranteed non-result.
 *
 * `phoneNormalized` is selected rather than `phone`, and that is the honest
 * limitation — see `scanForDuplicates` in the service. A row whose
 * `phoneNormalized` is null is invisible to phone matching even though its
 * `phone` is set, because the backfill has not run.
 */
export async function customersForDuplicateScan() {
  return prisma.customer.findMany({
    where: {
      OR: [
        { phoneNormalized: { not: null } },
        { email: { not: null } },
        { gstNumber: { not: null } },
        { companyName: { not: null } },
      ],
    },
    select: {
      id: true,
      name: true,
      companyName: true,
      phone: true,
      phoneNormalized: true,
      email: true,
      gstNumber: true,
      state: true,
    },
  });
}

/** How many customers have a phone but no normalised form of it yet. */
export async function phoneNormalizationCoverage() {
  const [withPhone, normalized] = await Promise.all([
    prisma.customer.count({ where: { phone: { not: null } } }),
    prisma.customer.count({
      where: { phone: { not: null }, phoneNormalized: { not: null } },
    }),
  ]);
  return { withPhone, normalized, pending: withPhone - normalized };
}

/** How many pairs are still waiting for somebody to decide. */
export async function countOpenDuplicateCandidates(): Promise<number> {
  return prisma.customerDuplicateCandidate.count({ where: { status: 'SUGGESTED' } });
}

/** One customer's identity and source events, or null. */
export async function findCustomerById(id: string): Promise<CustomerDirectoryRecord | null> {
  return prisma.customer.findUnique({
    where: { id },
    select: { ...customerIdentity, ...attributionSelect },
  });
}
