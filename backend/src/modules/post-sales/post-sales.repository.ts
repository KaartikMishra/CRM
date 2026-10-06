/**
 * All Prisma access for Post Sales & Grievance.
 *
 * Two things this file deliberately never does:
 *
 *   - **It never writes a Customer, SalesOrder, SalesOrderItem or Dispatch.** A
 *     case points at all four by foreign key. Phase 1 is read-only with respect
 *     to sales, dispatch and inventory, and there is no path here that could
 *     change any of them.
 *
 *   - **It never writes stock.** `crmStockQty` and `inventoryQty` are not
 *     mentioned anywhere in this module.
 *
 * Selects are explicit rather than bare `include`, so nothing can accidentally
 * return a password hash.
 */

import { Prisma } from '@rs/database';
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

const mediaRef = { id: true, secureUrl: true, publicId: true } as const;

/**
 * Exactly what Sales' `toMoney` consumes, so the case detail can report an order
 * total without storing one. The same shape the Lead module selects, and for the
 * same reason: there is no stored total to read instead.
 */
const orderMoneySelect = {
  id: true,
  orderId: true,
  status: true,
  orderDate: true,
  paidAmount: true,
  paymentMethod: true,
  customer: { select: { state: true, country: true } },
  refunds: { select: { amount: true, status: true } },
  items: {
    select: {
      quantity: true,
      cancelledQty: true,
      price: true,
      gstRate: true,
      gstMode: true,
      status: true,
    },
  },
  charges: { select: { type: true, amount: true } },
} as const;

/** One affected line, with the product identity drawn from the line itself. */
const caseItemSelect = {
  id: true,
  affectedQty: true,
  salesOrderItem: {
    select: {
      id: true,
      lineNo: true,
      productName: true,
      quantity: true,
      rsProduct: {
        select: {
          id: true,
          title: true,
          variants: { select: { sku: true }, orderBy: { position: 'asc' as const }, take: 1 },
        },
      },
      productImage: { select: mediaRef },
    },
  },
} satisfies Prisma.PostSalesCaseItemSelect;

export const activitySelect = {
  id: true,
  kind: true,
  note: true,
  channel: true,
  direction: true,
  dueAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  performedBy: { select: userRef },
} satisfies Prisma.PostSalesActivitySelect;

const attachmentSelect = {
  id: true,
  kind: true,
  createdAt: true,
  media: { select: mediaRef },
  uploadedBy: { select: userRef },
} satisfies Prisma.PostSalesAttachmentSelect;

/**
 * One case in full.
 *
 * Everything the detail page draws arrives on one read — customer, order,
 * affected lines, timeline and attachments — so a case with ten activities costs
 * one query rather than eleven.
 */
export const caseSelect = {
  id: true,
  caseNumber: true,
  caseType: true,
  issueCategory: true,
  priority: true,
  status: true,
  subject: true,
  description: true,
  resolvedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: customerView },
  salesOrder: { select: orderMoneySelect },
  dispatch: { select: { id: true, status: true, awb: true } },
  assignedTo: { select: userRef },
  raisedBy: { select: userRef },
  items: { select: caseItemSelect, orderBy: { createdAt: 'asc' as const } },
  activities: { select: activitySelect, orderBy: { createdAt: 'desc' as const } },
  attachments: { select: attachmentSelect, orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.PostSalesCaseSelect;

export type CaseRecord = Prisma.PostSalesCaseGetPayload<{ select: typeof caseSelect }>;
export type ActivityRecord = Prisma.PostSalesActivityGetPayload<{
  select: typeof activitySelect;
}>;

/**
 * One board row. Narrower than `caseSelect` on purpose: that embeds the whole
 * timeline and the complete customer record, and fifty of those is a payload
 * nobody reads.
 *
 * `items` takes one row for the Product column, and `_count` says how many more
 * there are — so the board shows "Brass thali +2" without fetching twelve lines.
 */
export const caseRowSelect = {
  id: true,
  caseNumber: true,
  caseType: true,
  issueCategory: true,
  priority: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { id: true, name: true, phone: true, email: true } },
  salesOrder: { select: { orderId: true } },
  assignedTo: { select: userRef },
  items: {
    select: { salesOrderItem: { select: { productName: true } } },
    orderBy: { createdAt: 'asc' as const },
    take: 1,
  },
  _count: { select: { items: true } },
} satisfies Prisma.PostSalesCaseSelect;

export type CaseRowRecord = Prisma.PostSalesCaseGetPayload<{ select: typeof caseRowSelect }>;

// ---------------------------------------------------------------------------
//  Case numbers
// ---------------------------------------------------------------------------

/**
 * Allocates the next human-facing case number.
 *
 * One statement that inserts or bumps the counter and hands back the new value.
 * The row lock is held by the UPDATE until the transaction commits, which is what
 * makes concurrent allocation safe — exactly the mechanism `allocateEnquiryNumber`
 * uses for ENQ-. Never `COUNT(*) + 1`, which two simultaneous creates would both
 * read as the same number.
 */
export async function allocateCaseNumber(
  tx: Prisma.TransactionClient,
  period: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "PostSalesCaseCounter" ("period", "lastValue")
    VALUES (${period}, 1)
    ON CONFLICT ("period")
    DO UPDATE SET "lastValue" = "PostSalesCaseCounter"."lastValue" + 1
    RETURNING "lastValue"
  `;

  const next = rows[0]?.lastValue;
  if (next === undefined) throw new Error('Post sales case counter returned no value');
  return next;
}

// ---------------------------------------------------------------------------
//  Reads
// ---------------------------------------------------------------------------

export function findCase(id: string): Promise<CaseRecord | null> {
  return prisma.postSalesCase.findUnique({ where: { id }, select: caseSelect });
}

/** Just the fields a write has to merge against — no relations, no timeline. */
export function findCaseState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  status: CaseRecord['status'];
  priority: CaseRecord['priority'];
  assignedToId: string | null;
  salesOrderId: string | null;
  customerId: string;
  caseNumber: string;
} | null> {
  return tx.postSalesCase.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      priority: true,
      assignedToId: true,
      salesOrderId: true,
      customerId: true,
      caseNumber: true,
    },
  });
}

export function findCustomer(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string } | null> {
  return tx.customer.findUnique({ where: { id }, select: { id: true } });
}

/** The order, with its customer, so the service can prove the two belong together. */
export function findOrderForCase(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; customerId: string } | null> {
  return tx.salesOrder.findUnique({ where: { id }, select: { id: true, customerId: true } });
}

/** The shipment, with its order, so a dispatch cannot be attached to the wrong case. */
export function findDispatchForCase(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; salesOrderId: string } | null> {
  return tx.dispatch.findUnique({ where: { id }, select: { id: true, salesOrderId: true } });
}

/**
 * The order lines named by a create payload, with the order each belongs to.
 *
 * One query for all of them rather than one per line, and it returns `orderId` so
 * the service can refuse a line belonging to a different order — the check that
 * stops a case pointing at somebody else's purchase.
 */
export function findOrderItems(
  ids: string[],
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; orderId: string; quantity: number }[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return tx.salesOrderItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, orderId: true, quantity: true },
  });
}

export function findActiveUser(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string } | null> {
  return tx.user.findFirst({ where: { id, isActive: true }, select: { id: true } });
}

export function findMediaAsset(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string } | null> {
  return tx.mediaAsset.findUnique({ where: { id }, select: { id: true } });
}

/** The active users a case may be allocated to. Names only, never credentials. */
export function listAssignees(): Promise<
  { id: string; name: string; employeeId: string; role: CaseRecord['raisedBy']['role'] }[]
> {
  return prisma.user.findMany({
    where: { isActive: true },
    select: userRef,
    orderBy: { name: 'asc' },
  });
}

/**
 * One customer's orders, for the order picker.
 *
 * Scoped to the customer in the URL, which is the authorisation: without it the
 * picker could list anybody's orders. Newest first, bounded.
 */
export function listCustomerOrders(
  customerId: string,
  limit: number,
): Promise<
  {
    id: string;
    orderId: string;
    status: string;
    orderDate: Date;
    items: { id: string; lineNo: number; productName: string; quantity: number }[];
  }[]
> {
  return prisma.salesOrder.findMany({
    where: { customerId },
    select: {
      id: true,
      orderId: true,
      status: true,
      orderDate: true,
      items: {
        select: { id: true, lineNo: true, productName: true, quantity: true },
        orderBy: { lineNo: 'asc' },
      },
    },
    orderBy: { orderDate: 'desc' },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
//  The board
// ---------------------------------------------------------------------------

export type CaseListFilters = {
  q?: string | undefined;
  caseType?: CaseRecord['caseType'] | undefined;
  issueCategory?: CaseRecord['issueCategory'] | undefined;
  priority?: CaseRecord['priority'] | undefined;
  status?: CaseRecord['status'] | undefined;
  assignedToId?: string | undefined;
  statusIn?: readonly CaseRecord['status'][] | undefined;
  channel?: ActivityRecord['channel'] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
};

/**
 * The orderings the board offers, as a lookup rather than a built string.
 *
 * An allowlist keyed by the shared `POST_SALES_SORTS`: nothing a client sends is
 * ever interpolated. Every ordering ends with `id` so a page boundary is
 * deterministic — without that tiebreak two cases sharing a timestamp could swap
 * places between pages and one would be skipped.
 */
function orderFor(
  sort: 'createdAt' | 'updatedAt' | 'priority' | 'status',
  direction: 'asc' | 'desc',
): Prisma.PostSalesCaseOrderByWithRelationInput[] {
  switch (sort) {
    case 'updatedAt':
      return [{ updatedAt: direction }, { id: 'asc' }];
    case 'priority':
      return [{ priority: direction }, { createdAt: 'desc' }, { id: 'asc' }];
    case 'status':
      return [{ status: direction }, { createdAt: 'desc' }, { id: 'asc' }];
    case 'createdAt':
    default:
      return [{ createdAt: direction }, { id: 'asc' }];
  }
}

export function buildCaseWhere(filters: CaseListFilters): Prisma.PostSalesCaseWhereInput {
  const { q, caseType, issueCategory, priority, status, assignedToId, statusIn, channel } =
    filters;

  return {
    ...(caseType ? { caseType } : {}),
    ...(issueCategory ? { issueCategory } : {}),
    ...(priority ? { priority } : {}),
    ...(status ? { status } : {}),
    ...(assignedToId ? { assignedToId } : {}),
    ...(statusIn ? { status: { in: [...statusIn] } } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
    /*
      A communication channel is a property of the timeline, not of the case, so
      filtering by it asks "has this case been contacted this way" — expressed as
      a relation filter rather than a column, which is the honest translation.
    */
    ...(channel ? { activities: { some: { channel } } } : {}),
    /*
      Search spans what somebody has to hand when they go looking: the case
      number, the subject, the customer's name or number, the order id, or the
      product on an affected line. Case-insensitive `contains` rather than a
      prefix match — a phone number is remembered from its tail as often as its
      head.
    */
    ...(q
      ? {
          OR: [
            { caseNumber: { contains: q, mode: 'insensitive' as const } },
            { subject: { contains: q, mode: 'insensitive' as const } },
            { customer: { name: { contains: q, mode: 'insensitive' as const } } },
            { customer: { phone: { contains: q, mode: 'insensitive' as const } } },
            { customer: { email: { contains: q, mode: 'insensitive' as const } } },
            { salesOrder: { orderId: { contains: q, mode: 'insensitive' as const } } },
            {
              items: {
                some: {
                  salesOrderItem: {
                    productName: { contains: q, mode: 'insensitive' as const },
                  },
                },
              },
            },
          ],
        }
      : {}),
  };
}

/**
 * A page of cases.
 *
 * Takes `limit + 1` so the caller can tell whether another page exists without a
 * second count query — the same trick every other list in the CRM uses.
 */
export function listCases(query: {
  limit: number;
  cursor?: string | undefined;
  sort: 'createdAt' | 'updatedAt' | 'priority' | 'status';
  direction: 'asc' | 'desc';
  filters: CaseListFilters;
}): Promise<CaseRowRecord[]> {
  return prisma.postSalesCase.findMany({
    where: buildCaseWhere(query.filters),
    orderBy: orderFor(query.sort, query.direction),
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: caseRowSelect,
  });
}

/**
 * The latest activity timestamp for a set of cases, in one query.
 *
 * `groupBy` with a `_max` rather than a per-case read: the board shows "last
 * activity" for every row, and asking per row is the N+1 this shape exists to
 * prevent.
 */
export async function lastActivityFor(
  caseIds: string[],
): Promise<Map<string, Date>> {
  if (caseIds.length === 0) return new Map();

  const rows = await prisma.postSalesActivity.groupBy({
    by: ['caseId'],
    where: { caseId: { in: caseIds } },
    _max: { createdAt: true },
  });

  const out = new Map<string, Date>();
  for (const row of rows) {
    if (row._max.createdAt) out.set(row.caseId, row._max.createdAt);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Writes — cases
// ---------------------------------------------------------------------------

export function createCase(
  tx: Prisma.TransactionClient,
  data: Prisma.PostSalesCaseUncheckedCreateInput,
): Promise<{ id: string; caseNumber: string }> {
  return tx.postSalesCase.create({ data, select: { id: true, caseNumber: true } });
}

export function createCaseItems(
  tx: Prisma.TransactionClient,
  rows: Prisma.PostSalesCaseItemCreateManyInput[],
): Promise<Prisma.BatchPayload> {
  return tx.postSalesCaseItem.createMany({ data: rows });
}

export function updateCase(
  id: string,
  data: Prisma.PostSalesCaseUncheckedUpdateInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string }> {
  return tx.postSalesCase.update({ where: { id }, data, select: { id: true } });
}

// ---------------------------------------------------------------------------
//  Writes — activities
// ---------------------------------------------------------------------------

export function createActivity(
  data: Prisma.PostSalesActivityUncheckedCreateInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string }> {
  return tx.postSalesActivity.create({ data, select: { id: true } });
}

/**
 * One activity, scoped to its case.
 *
 * The `caseId` in the WHERE clause is the authorisation, not a convenience:
 * without it an activity id from one case could be edited through another case's
 * URL. `findFirst` rather than `findUnique` because the pair is not a unique
 * index — the scoping is what matters, not the lookup shape.
 */
export function findActivityForCase(
  caseId: string,
  activityId: string,
): Promise<{ id: string; kind: ActivityRecord['kind'] } | null> {
  return prisma.postSalesActivity.findFirst({
    where: { id: activityId, caseId },
    select: { id: true, kind: true },
  });
}

/** Scoped by caseId and reported as a count, so "not this case's" is tellable. */
export async function updateActivityForCase(
  caseId: string,
  activityId: string,
  data: Prisma.PostSalesActivityUncheckedUpdateInput,
): Promise<number> {
  const { count } = await prisma.postSalesActivity.updateMany({
    where: { id: activityId, caseId },
    data,
  });
  return count;
}

// ---------------------------------------------------------------------------
//  Writes — attachments
// ---------------------------------------------------------------------------

export function createAttachment(
  data: Prisma.PostSalesAttachmentUncheckedCreateInput,
): Promise<{ id: string }> {
  return prisma.postSalesAttachment.create({ data, select: { id: true } });
}

export function findAttachmentForCase(
  caseId: string,
  attachmentId: string,
): Promise<{ id: string; mediaAssetId: string | null } | null> {
  return prisma.postSalesAttachment.findFirst({
    where: { id: attachmentId, caseId },
    select: { id: true, mediaAssetId: true },
  });
}

/**
 * Unlinks an attachment from a case.
 *
 * **The MediaAsset is deliberately left in place.** Media here is an
 * independently retained record: it carries its own uploader and timestamps,
 * seven tables reference it, and every one of those foreign keys is SetNull
 * rather than Cascade — the schema's own statement that an asset outlives the row
 * pointing at it. Deleting the Cloudinary object would additionally be
 * irreversible and could strip an image still shown elsewhere.
 */
export async function deleteAttachmentForCase(
  caseId: string,
  attachmentId: string,
): Promise<number> {
  const { count } = await prisma.postSalesAttachment.deleteMany({
    where: { id: attachmentId, caseId },
  });
  return count;
}

// ---------------------------------------------------------------------------
//  Overview and audit
// ---------------------------------------------------------------------------

/**
 * The overview counts, in one grouped query plus three scalars.
 *
 * `groupBy` over status and priority rather than one count per tile: eight
 * separate counts would be eight round trips to answer one screen.
 */
export async function countByStatus(): Promise<
  { status: CaseRecord['status']; count: number }[]
> {
  const rows = await prisma.postSalesCase.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  return rows.map((r) => ({ status: r.status, count: r._count._all }));
}

export function countCases(where: Prisma.PostSalesCaseWhereInput): Promise<number> {
  return prisma.postSalesCase.count({ where });
}

/** A case's audit trail, read from the existing generic AuditLog. */
export function findCaseAudit(caseId: string, limit: number) {
  return prisma.auditLog.findMany({
    where: { entityType: 'PostSalesCase', entityId: caseId },
    select: {
      id: true,
      action: true,
      oldValue: true,
      newValue: true,
      createdAt: true,
      actor: { select: userRef },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
