/**
 * All Prisma access for Sales Orders, plus the mappers that turn rows into the
 * wire contract in @rs/shared.
 *
 * Two shapes exist deliberately: the list selects a flat summary and the detail
 * selects the full record with its lines. Neither uses a bare `include`, so
 * nothing here can accidentally return a password hash.
 *
 * Decimals leave as strings and dates as ISO strings — never floats.
 *
 * This file is also the single place an order's money comes into existence.
 * `total` and `pending` are not columns; `toMoney` below is the one definition
 * of each, so there is no second source of truth to drift. It sums ACTIVE lines
 * only — which is the entire mechanism by which a line awaiting approval cannot
 * move an order's money.
 */

import { Prisma } from '@rs/database';
import {
  addAmount,
  compareAmount,
  lineTotal,
  normaliseAmount,
  subtractAmount,
  type CustomerContactRef,
  type CustomerRef,
  type MediaRef,
  type SalesMoneyView,
  type SalesOrderDetail,
  type SalesOrderItemView,
  type SalesOrderListQuery,
  type SalesChangeRequestView,
  type SalesOrderSummary,
  type UserRef,
} from '@rs/shared';
import { prisma } from '../../config/database.js';
import { isOverdue } from './sales-efficiency.js';

// ---------------------------------------------------------------------------
//  Select shapes
// ---------------------------------------------------------------------------

const userRef = { id: true, name: true, employeeId: true, role: true } as const;
const customerRef = { id: true, name: true, type: true } as const;
/** Detail only — a list row has no use for contact details. */
const customerContactRef = { ...customerRef, phone: true, email: true, address: true } as const;
const mediaRef = { id: true, secureUrl: true, publicId: true } as const;

const itemSelect = {
  id: true,
  lineNo: true,
  productName: true,
  quantity: true,
  price: true,
  status: true,
  approvedAt: true,
  createdAt: true,
  productImage: { select: mediaRef },
  proposedBy: { select: userRef },
  approvedBy: { select: userRef },
} satisfies Prisma.SalesOrderItemSelect;

/**
 * The list needs enough of each line to price the order and label the row, but
 * not the approval trail — that is a detail-page concern.
 */
const summaryItemSelect = {
  lineNo: true,
  productName: true,
  quantity: true,
  price: true,
  status: true,
  productImage: { select: mediaRef },
} satisfies Prisma.SalesOrderItemSelect;

const summarySelect = {
  id: true,
  orderId: true,
  status: true,
  efficiency: true,
  orderDate: true,
  toBeDispatchedBy: true,
  dispatchedAt: true,
  paidAmount: true,
  updatedAt: true,
  customer: { select: customerRef },
  items: { select: summaryItemSelect, orderBy: { lineNo: 'asc' } },
} satisfies Prisma.SalesOrderSelect;

const changeRequestSelect = {
  id: true,
  type: true,
  status: true,
  productName: true,
  quantity: true,
  price: true,
  requestedAt: true,
  reviewedAt: true,
  reviewNote: true,
  productImage: { select: mediaRef },
  requestedBy: { select: userRef },
  reviewedBy: { select: userRef },
  item: {
    select: {
      id: true,
      lineNo: true,
      productName: true,
      quantity: true,
      price: true,
      productImage: { select: mediaRef },
    },
  },
} satisfies Prisma.SalesItemChangeRequestSelect;

type ChangeRequestRow = Prisma.SalesItemChangeRequestGetPayload<{
  select: typeof changeRequestSelect;
}>;

/**
 * Both sides of a request, so the UI can show CURRENT -> PROPOSED without a
 * second lookup. `current` is the line as it stands now — for a rejected or
 * still-pending request that is simply the untouched product.
 */
function toChangeRequest(row: ChangeRequestRow): SalesChangeRequestView {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    current: row.item
      ? {
          id: row.item.id,
          lineNo: row.item.lineNo,
          productName: row.item.productName,
          image: (row.item.productImage as MediaRef | null) ?? null,
          quantity: row.item.quantity,
          price: row.item.price.toString(),
          lineTotal: lineTotal(row.item.price.toString(), row.item.quantity),
        }
      : null,
    proposed:
      row.productName !== null && row.quantity !== null && row.price !== null
        ? {
            productName: row.productName,
            image: (row.productImage as MediaRef | null) ?? null,
            quantity: row.quantity,
            price: row.price.toString(),
            lineTotal: lineTotal(row.price.toString(), row.quantity),
          }
        : null,
    requestedBy: row.requestedBy as UserRef,
    requestedAt: iso(row.requestedAt),
    reviewedBy: (row.reviewedBy as UserRef | null) ?? null,
    reviewedAt: row.reviewedAt ? iso(row.reviewedAt) : null,
    reviewNote: row.reviewNote,
  };
}

const detailSelect = {
  id: true,
  orderId: true,
  status: true,
  efficiency: true,
  orderDate: true,
  toBeDispatchedBy: true,
  dispatchedAt: true,
  closedAt: true,
  paidAmount: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: customerContactRef },
  createdBy: { select: userRef },
  closedBy: { select: userRef },
  items: { select: itemSelect, orderBy: { lineNo: 'asc' } },
  changeRequests: {
    // Pending first — those need a decision; the rest is history, newest first.
    select: changeRequestSelect,
    orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
  },
} satisfies Prisma.SalesOrderSelect;

type SummaryRow = Prisma.SalesOrderGetPayload<{ select: typeof summarySelect }>;
type DetailRow = Prisma.SalesOrderGetPayload<{ select: typeof detailSelect }>;

// ---------------------------------------------------------------------------
//  Mappers
// ---------------------------------------------------------------------------

const iso = (d: Date): string => d.toISOString();

/** One line's exact value. Prisma's Decimal drops trailing zeros, so normalise. */
const totalOfLine = (item: { quantity: number; price: Prisma.Decimal }): string =>
  lineTotal(normaliseAmount(item.price.toString()), item.quantity);

/**
 * The one definition of an order's money.
 *
 * `total` sums the ACTIVE lines and nothing else, so a line awaiting approval
 * contributes nothing until someone accepts it. Arithmetic goes through the
 * exact BigInt-paise helpers in @rs/shared — nothing here is ever a float.
 */
export function toMoney(
  paidAmount: Prisma.Decimal,
  items: { quantity: number; price: Prisma.Decimal; status: 'ACTIVE' | 'PENDING_APPROVAL' }[],
): SalesMoneyView {
  const active = items.filter((item) => item.status === 'ACTIVE');
  const awaiting = items.filter((item) => item.status === 'PENDING_APPROVAL');

  const total = active.reduce((running, item) => addAmount(running, totalOfLine(item)), '0.00');
  const paid = normaliseAmount(paidAmount.toString());

  return {
    total,
    paid,
    pending: subtractAmount(total, paid),
    fullyPaid: compareAmount(paid, total) >= 0,
    currency: 'INR',
    activeItemCount: active.length,
    pendingApprovalCount: awaiting.length,
    pendingApprovalTotal: awaiting.reduce(
      (running, item) => addAmount(running, totalOfLine(item)),
      '0.00',
    ),
  };
}

function toItem(row: DetailRow['items'][number]): SalesOrderItemView {
  return {
    id: row.id,
    lineNo: row.lineNo,
    productName: row.productName,
    image: (row.productImage as MediaRef | null) ?? null,
    quantity: row.quantity,
    price: normaliseAmount(row.price.toString()),
    lineTotal: totalOfLine(row),
    status: row.status,
    proposedBy: row.proposedBy as UserRef,
    approvedBy: (row.approvedBy as UserRef | null) ?? null,
    approvedAt: row.approvedAt ? iso(row.approvedAt) : null,
    createdAt: iso(row.createdAt),
  };
}

function toSummary(row: SummaryRow, now: Date): SalesOrderSummary {
  const active = row.items.filter((item) => item.status === 'ACTIVE');
  const lead = active[0] ?? row.items[0];
  const extra = active.length > 1 ? ` +${active.length - 1} more` : '';

  return {
    id: row.id,
    orderId: row.orderId,
    customer: row.customer as CustomerRef,
    leadProductName: lead ? `${lead.productName}${extra}` : '—',
    thumbnail: (active.find((i) => i.productImage)?.productImage as MediaRef | null) ?? null,
    money: toMoney(row.paidAmount, row.items),
    status: row.status,
    efficiency: row.efficiency,
    orderDate: iso(row.orderDate),
    toBeDispatchedBy: iso(row.toBeDispatchedBy),
    dispatchedAt: row.dispatchedAt ? iso(row.dispatchedAt) : null,
    overdue: isOverdue(now, row.toBeDispatchedBy, row.dispatchedAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toDetail(row: DetailRow, now: Date): SalesOrderDetail {
  return {
    id: row.id,
    orderId: row.orderId,
    customer: row.customer as CustomerContactRef,
    items: row.items.map(toItem),
    changeRequests: row.changeRequests.map(toChangeRequest),
    money: toMoney(row.paidAmount, row.items),
    status: row.status,
    efficiency: row.efficiency,
    orderDate: iso(row.orderDate),
    toBeDispatchedBy: iso(row.toBeDispatchedBy),
    dispatchedAt: row.dispatchedAt ? iso(row.dispatchedAt) : null,
    closedAt: row.closedAt ? iso(row.closedAt) : null,
    closedBy: (row.closedBy as UserRef | null) ?? null,
    overdue: isOverdue(now, row.toBeDispatchedBy, row.dispatchedAt),
    createdBy: row.createdBy as UserRef,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
//  Queries
// ---------------------------------------------------------------------------

/** The minimum needed to make an access or workflow decision — no nested loads. */
export type SalesOrderForPolicy = {
  id: string;
  status: SalesOrderDetail['status'];
  createdById: string;
  paidAmount: Prisma.Decimal;
  orderDate: Date;
  toBeDispatchedBy: Date;
};

export function findForPolicy(
  id: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<SalesOrderForPolicy | null> {
  return client.salesOrder.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      createdById: true,
      paidAmount: true,
      orderDate: true,
      toBeDispatchedBy: true,
    },
  });
}

/**
 * The order's ACTIVE line total, read inside a transaction.
 *
 * Every money decision in the service goes through this rather than trusting a
 * figure from the request, so a line added or approved concurrently is always
 * accounted for.
 */
export async function activeTotal(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<string> {
  const rows = await tx.salesOrderItem.findMany({
    where: { orderId, status: 'ACTIVE' },
    select: { quantity: true, price: true },
  });
  return rows.reduce((running, item) => addAmount(running, totalOfLine(item)), '0.00');
}

/** The next free line number on an order. Serialised by the caller's row lock. */
export async function nextLineNo(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const highest = await tx.salesOrderItem.findFirst({
    where: { orderId },
    orderBy: { lineNo: 'desc' },
    select: { lineNo: true },
  });
  return (highest?.lineNo ?? 0) + 1;
}

/** A line is only ever reached through its order, never by id alone. */
export function findItemInOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  itemId: string,
) {
  return tx.salesOrderItem.findFirst({
    where: { id: itemId, orderId },
    select: {
      id: true,
      lineNo: true,
      productName: true,
      quantity: true,
      price: true,
      status: true,
      proposedById: true,
    },
  });
}

export async function findDetail(id: string, now: Date): Promise<SalesOrderDetail | null> {
  const row = await prisma.salesOrder.findUnique({ where: { id }, select: detailSelect });
  return row ? toDetail(row, now) : null;
}

/** Used to give a duplicate order id a friendly message before the unique index bites. */
export function findByOrderId(
  orderId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ id: string } | null> {
  return client.salesOrder.findUnique({ where: { orderId }, select: { id: true } });
}

export type ListResult = {
  items: SalesOrderSummary[];
  nextCursor: string | null;
};

/**
 * Server-side filtering with keyset pagination.
 *
 * Keyset rather than offset so page 40 costs the same as page 1, and the tie
 * breaker is the cuid primary key so a stable order survives equal sort values.
 */
export async function list(query: SalesOrderListQuery, now: Date): Promise<ListResult> {
  const where: Prisma.SalesOrderWhereInput = {};

  if (query.status) where.status = query.status;
  if (query.efficiency) where.efficiency = query.efficiency;
  if (query.customerId) where.customerId = query.customerId;

  if (query.from || query.to) {
    where.orderDate = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }

  if (query.q) {
    where.OR = [
      { orderId: { contains: query.q, mode: 'insensitive' } },
      { items: { some: { productName: { contains: query.q, mode: 'insensitive' } } } },
      { customer: { name: { contains: query.q, mode: 'insensitive' } } },
    ];
  }

  const rows = await prisma.salesOrder.findMany({
    where,
    select: summarySelect,
    orderBy: [{ [query.sortBy]: query.sortDir }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: page.map((row) => toSummary(row, now)),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Serialises concurrent mutations of one order.
 *
 * Conditional updates protect individual columns, but a workflow action reads
 * state and then acts on it, and two requests can interleave between those two
 * steps. The row lock makes them queue, so the second one sees what the first
 * one did — which is how two simultaneous dispatches become one success and one
 * honest INVALID_STATUS_TRANSITION, and how two payments cannot both pass the
 * same ceiling check.
 *
 * Line changes take this same lock on the parent order, so adding, approving or
 * removing a line is serialised against payments on the order it belongs to.
 */
export async function lockOrder(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "SalesOrder" WHERE "id" = ${id} FOR UPDATE`;
}
