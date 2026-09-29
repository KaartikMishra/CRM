/**
 * All Prisma access for Packing & Dispatch.
 *
 * Two things this file deliberately never touches:
 *
 *   - **`ShopifyVariant.crmStockQty`**, or any other stock figure. Procurement's
 *     `reconcileLineStock` is its single writer. Allocation already removed
 *     these goods from free stock when they were committed to the order, so a
 *     second decrement here would count the same units twice. Dispatch records
 *     movement of goods that are already spoken for.
 *
 *   - **`SalesOrder` and `SalesOrderItem` columns.** They are read for context —
 *     what was bought, by whom, where it goes — and written only through Sales'
 *     own service, never from here.
 *
 * Selects are explicit rather than bare `include`, so nothing can accidentally
 * return a password hash.
 */

import { Prisma } from '@rs/database';
import type { SalesEfficiency } from '@rs/shared';
import { prisma } from '../../config/database.js';

const userRef = { id: true, name: true, employeeId: true, role: true } as const;
const mediaRef = { id: true, secureUrl: true, publicId: true } as const;

/**
 * An order with everything a readiness decision needs.
 *
 * `allocations` come along because they are half of the arithmetic: what a line
 * is owed is its quantity less what was cancelled, less what was supplied by
 * hand, less what purchases have committed to it. `dispatchItems` are the other
 * half — what has already gone.
 */
export const orderForDispatchSelect = {
  id: true,
  orderId: true,
  status: true,
  orderDate: true,
  toBeDispatchedBy: true,
  paidAmount: true,
  customer: {
    select: {
      id: true,
      name: true,
      type: true,
      companyName: true,
      phone: true,
      email: true,
      address: true,
      state: true,
      country: true,
      gstNumber: true,
    },
  },
  items: {
    where: { status: 'ACTIVE' as const },
    orderBy: { lineNo: 'asc' as const },
    select: {
      id: true,
      lineNo: true,
      productName: true,
      quantity: true,
      cancelledQty: true,
      alreadyFulfilled: true,
      price: true,
      gstRate: true,
      gstMode: true,
      productImage: { select: mediaRef },
      /*
        The catalogue SKU, for the person picking goods off a shelf.

        Order lines map at product level (`rsProductId`), not variant level, so
        there is no variant on the line to read — the first by position is the
        representative one, and `take: 1` keeps this from widening the board
        query into every variant of every product on every row.
      */
      rsProduct: {
        select: {
          variants: {
            select: { sku: true },
            orderBy: { position: 'asc' as const },
            take: 1,
          },
        },
      },
      allocations: { select: { quantity: true } },
      dispatchItems: {
        select: { quantity: true, dispatch: { select: { status: true } } },
      },
    },
  },
} satisfies Prisma.SalesOrderSelect;

export type OrderForDispatch = Prisma.SalesOrderGetPayload<{
  select: typeof orderForDispatchSelect;
}>;

export const dispatchSelect = {
  id: true,
  salesOrderId: true,
  status: true,
  isPartial: true,
  channel: true,
  channelOther: true,
  carrier: true,
  carrierOther: true,
  awb: true,
  packedAt: true,
  dispatchedAt: true,
  createdAt: true,
  packedBy: { select: userRef },
  dispatchedBy: { select: userRef },
  createdBy: { select: userRef },
  salesOrder: { select: { orderId: true } },
  items: {
    orderBy: { salesOrderItem: { lineNo: 'asc' as const } },
    select: {
      id: true,
      quantity: true,
      salesOrderItem: {
        select: {
          id: true,
          lineNo: true,
          productName: true,
          productImage: { select: mediaRef },
        },
      },
    },
  },
} satisfies Prisma.DispatchSelect;

export type DispatchRecord = Prisma.DispatchGetPayload<{ select: typeof dispatchSelect }>;

export function findOrderForDispatch(
  orderId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<OrderForDispatch | null> {
  return tx.salesOrder.findUnique({ where: { id: orderId }, select: orderForDispatchSelect });
}

export function findDispatch(
  id: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<DispatchRecord | null> {
  return tx.dispatch.findUnique({ where: { id }, select: dispatchSelect });
}

export function listDispatchesForOrder(
  salesOrderId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<DispatchRecord[]> {
  return tx.dispatch.findMany({
    where: { salesOrderId },
    orderBy: { createdAt: 'desc' },
    select: dispatchSelect,
  });
}

/**
 * Locks one order's dispatch activity.
 *
 * Takes the *sales order* row, not the dispatch row, because the invariant being
 * protected spans several dispatches: two people packing the same order at once
 * must not each believe the same units are available to them. Locking the order
 * serialises them.
 *
 * The lock order is order → dispatch here. Nothing in this module takes a
 * purchase-side lock, so it cannot deadlock against Procurement.
 */
export async function lockOrder(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "SalesOrder" WHERE "id" = ${orderId} FOR UPDATE`;
}

/** The dispatch board: orders that are open and not yet fully sent. */
export async function listBoardOrders(query: {
  limit: number;
  cursor?: string | undefined;
  q?: string | undefined;
}): Promise<OrderForDispatch[]> {
  const where: Prisma.SalesOrderWhereInput = {
    // A cancelled or closed order is not dispatch work.
    status: { in: ['OPEN', 'DISPATCHED'] },
    ...(query.q
      ? {
          OR: [
            { orderId: { contains: query.q, mode: 'insensitive' } },
            { customer: { name: { contains: query.q, mode: 'insensitive' } } },
            { dispatches: { some: { awb: { contains: query.q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  return prisma.salesOrder.findMany({
    where,
    orderBy: [{ toBeDispatchedBy: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: orderForDispatchSelect,
  });
}

export function createDispatch(
  tx: Prisma.TransactionClient,
  data: {
    salesOrderId: string;
    createdById: string;
    isPartial: boolean;
    items: { salesOrderItemId: string; quantity: number }[];
  },
): Promise<{ id: string }> {
  return tx.dispatch.create({
    data: {
      salesOrderId: data.salesOrderId,
      createdById: data.createdById,
      isPartial: data.isPartial,
      items: { create: data.items },
    },
    select: { id: true },
  });
}

export function updateDispatch(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.DispatchUpdateInput,
): Promise<{ id: string }> {
  return tx.dispatch.update({ where: { id }, data, select: { id: true } });
}

// ---------------------------------------------------------------------------
//  Partial dispatch requests
// ---------------------------------------------------------------------------

export const partialRequestSelect = {
  id: true,
  salesOrderId: true,
  status: true,
  requestedAt: true,
  requestedById: true,
  deadline: true,
  decidedAt: true,
  reason: true,
  poa: true,
  autoDecided: true,
  requestedBy: { select: userRef },
  decidedBy: { select: userRef },
  salesOrder: { select: { orderId: true } },
} satisfies Prisma.PartialDispatchRequestSelect;

export type PartialRequestRecord = Prisma.PartialDispatchRequestGetPayload<{
  select: typeof partialRequestSelect;
}>;

export function findPartialRequest(
  tx: Prisma.TransactionClient | typeof prisma,
  id: string,
): Promise<PartialRequestRecord | null> {
  return tx.partialDispatchRequest.findUnique({ where: { id }, select: partialRequestSelect });
}

/** The open question on an order, if there is one. At most one can exist. */
export function findPendingRequest(
  tx: Prisma.TransactionClient | typeof prisma,
  salesOrderId: string,
): Promise<PartialRequestRecord | null> {
  return tx.partialDispatchRequest.findFirst({
    where: { salesOrderId, status: 'PENDING' },
    select: partialRequestSelect,
  });
}

export function listPartialRequests(
  salesOrderId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<PartialRequestRecord[]> {
  return tx.partialDispatchRequest.findMany({
    where: { salesOrderId },
    orderBy: { requestedAt: 'desc' },
    select: partialRequestSelect,
  });
}

/** Every open question across the board, for one pass of the dispatch list. */
export function findPendingRequestsForOrders(
  salesOrderIds: string[],
): Promise<PartialRequestRecord[]> {
  if (salesOrderIds.length === 0) return Promise.resolve([]);
  return prisma.partialDispatchRequest.findMany({
    where: { salesOrderId: { in: salesOrderIds }, status: 'PENDING' },
    select: partialRequestSelect,
  });
}

/**
 * Every open question in the CRM, for Procurement's decision queue.
 *
 * The one reader that does not start from an order or a request id — which is
 * exactly why it exists. A reviewer opening Purchase & Procurement has neither;
 * they need to be told what is waiting for them.
 *
 * Oldest first, because the deadline runs from `requestedAt` and the one
 * closest to expiring is the one worth answering first.
 */
export function findPendingPartialRequests(): Promise<PartialRequestRecord[]> {
  return prisma.partialDispatchRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { requestedAt: 'asc' },
    select: partialRequestSelect,
  });
}

export function createPartialRequest(
  tx: Prisma.TransactionClient,
  data: {
    salesOrderId: string;
    requestedById: string;
    requestedAt: Date;
    deadline: Date;
    status?: 'ALLOWED';
    decidedById?: string;
    decidedAt?: Date;
    reason?: string | null;
    poa?: string | null;
    autoDecided?: boolean;
  },
): Promise<{ id: string }> {
  return tx.partialDispatchRequest.create({ data, select: { id: true } });
}

/**
 * Settles a request, but only while it is still open.
 *
 * `status: 'PENDING'` in the WHERE clause is the concurrency control for this
 * whole module. A human decision, the deadline sweep and the MOOT resolver all
 * want to move the same row out of PENDING and can genuinely race; whichever
 * commits first wins, and every other one matches zero rows and is told so.
 * Returns the number of rows changed, which is how the caller learns it lost.
 */
export async function decidePendingRequest(
  tx: Prisma.TransactionClient,
  id: string,
  data: {
    status: 'ALLOWED' | 'DISALLOWED' | 'MOOT';
    decidedById: string | null;
    decidedAt: Date;
    reason: string | null;
    poa: string | null;
    autoDecided: boolean;
  },
): Promise<number> {
  const { count } = await tx.partialDispatchRequest.updateMany({
    where: { id, status: 'PENDING' },
    data,
  });
  return count;
}

/**
 * Requests whose deadline has passed with no answer.
 *
 * Ordered by deadline so the longest-waiting is settled first, and taken in
 * batches so one sweep of a long backlog cannot run unbounded. The comparison is
 * against a database instant supplied by the caller, never this process's clock.
 */
export function findOverdueRequests(
  now: Date,
  limit: number,
): Promise<{ id: string; salesOrderId: string; requestedById: string }[]> {
  return prisma.partialDispatchRequest.findMany({
    where: { status: 'PENDING', deadline: { lte: now } },
    orderBy: { deadline: 'asc' },
    take: limit,
    select: { id: true, salesOrderId: true, requestedById: true },
  });
}

/**
 * Marks the order dispatched, through Sales' own columns.
 *
 * The only write this module makes outside its own tables, and it writes
 * exactly what Sales' own dispatch endpoint writes: status, `dispatchedAt` and
 * `efficiency`, all three together.
 *
 * The verdict is not optional here. `sales_efficiency_accompanies_dispatch`
 * enforces `("dispatchedAt" IS NULL) = ("efficiency" IS NULL)`, so stamping the
 * moment without the verdict fails at COMMIT — and beyond the constraint, an
 * order that went out has either met its deadline or not, and leaving that
 * unanswered would lose the fact. The verdict comes from Sales' own
 * `dispatchVerdict`, so one order cannot acquire two different answers
 * depending on which screen sent it.
 */
export function markOrderDispatched(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
  at: Date,
  efficiency: SalesEfficiency,
): Promise<{ id: string }> {
  return tx.salesOrder.update({
    where: { id: salesOrderId },
    data: { status: 'DISPATCHED', dispatchedAt: at, efficiency },
    select: { id: true },
  });
}
