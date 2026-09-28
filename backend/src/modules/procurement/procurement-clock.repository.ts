/**
 * Every Prisma query the Procurement Clock makes.
 *
 * The clock owns three tables and reads four others. It WRITES only its own:
 * `SalesOrder`, `SalesOrderItem`, `PurchaseAllocation` and `ShopifyVariant` are
 * read here and never touched, so `reconcileLineStock` remains the only writer of
 * `crmStockQty` and Sales remains the only writer of an order.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

const userRef = { id: true, name: true } as const;

/** A delay reason and its decision — the same shape for both chains. */
export const delayReasonSelect = {
  id: true,
  reason: true,
  status: true,
  requestedAt: true,
  reviewedAt: true,
  reviewNote: true,
  requestedBy: { select: userRef },
  reviewedBy: { select: userRef },
} satisfies Prisma.PurchaseDelayReasonSelect;

/**
 * One order line, with everything the clock's arithmetic needs and nothing else.
 *
 * `quantity` and `cancelledQty` are both selected because they are two different
 * facts: what was ordered, and what the customer called off. The requirement is
 * the difference, and reading only `quantity` — as the older shortage queries
 * still do — would leave a partly cancelled order looking as though it still
 * needed the units nobody wants.
 */
const clockItemSelect = {
  id: true,
  lineNo: true,
  productName: true,
  rsProductId: true,
  quantity: true,
  cancelledQty: true,
  alreadyFulfilled: true,
  allocations: { select: { quantity: true } },
  purchaseDelayReasons: {
    select: delayReasonSelect,
    orderBy: { requestedAt: 'desc' },
  },
} satisfies Prisma.SalesOrderItemSelect;

/**
 * One clock and the order it measures.
 *
 * The order's own fields are read, never copied: the board needs a number and a
 * customer to be legible, and reading them here is what stops the clock from
 * holding its own stale duplicates of both.
 */
const clockSelect = {
  id: true,
  deadline: true,
  completedAt: true,
  verdict: true,
  completionEstimated: true,
  order: {
    select: {
      id: true,
      orderId: true,
      orderDate: true,
      status: true,
      customer: { select: { name: true } },
      items: {
        where: { status: 'ACTIVE' },
        select: clockItemSelect,
        orderBy: { lineNo: 'asc' },
      },
    },
  },
  delayReasons: {
    select: delayReasonSelect,
    orderBy: { requestedAt: 'desc' },
  },
} satisfies Prisma.ProcurementClockSelect;

export type ClockRow = Prisma.ProcurementClockGetPayload<{ select: typeof clockSelect }>;
export type DelayReasonRow = Prisma.PurchaseDelayReasonGetPayload<{
  select: typeof delayReasonSelect;
}>;

/**
 * Locks the clock row before a decision reads and rewrites it.
 *
 * The same `FOR UPDATE` pattern the module already uses for a bill, a bill item
 * and an order line, so a reconcile racing a second reconcile cannot both read
 * "not yet covered" and both write a completion.
 */
export async function lockClock(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "ProcurementClock" WHERE "orderId" = ${orderId} FOR UPDATE`;
}

/** The board. Every order that has a clock, newest order first. */
export function findClocks(): Promise<ClockRow[]> {
  return prisma.procurementClock.findMany({
    select: clockSelect,
    orderBy: [{ order: { orderDate: 'desc' } }],
  });
}

export function findClock(orderId: string): Promise<ClockRow | null> {
  return prisma.procurementClock.findUnique({ where: { orderId }, select: clockSelect });
}

/**
 * The rows `reconcileClock` decides from, inside the caller's transaction.
 *
 * Deliberately a narrower read than `clockSelect`: reconciling needs the
 * quantities and the order's status, not the customer or the delay history.
 */
export function findClockForReconcile(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{
  id: string;
  deadline: Date;
  completedAt: Date | null;
  order: {
    status: string;
    items: {
      quantity: number;
      cancelledQty: number;
      alreadyFulfilled: number;
      allocations: { quantity: number }[];
    }[];
  };
} | null> {
  return tx.procurementClock.findUnique({
    where: { orderId },
    select: {
      id: true,
      deadline: true,
      completedAt: true,
      order: {
        select: {
          status: true,
          items: {
            where: { status: 'ACTIVE' },
            select: {
              quantity: true,
              cancelledQty: true,
              alreadyFulfilled: true,
              allocations: { select: { quantity: true } },
            },
          },
        },
      },
    },
  });
}

/** Which order a line belongs to — the clock is per order, the line is not. */
export function findOrderIdForItem(
  tx: Prisma.TransactionClient,
  salesOrderItemId: string,
): Promise<{ orderId: string } | null> {
  return tx.salesOrderItem.findUnique({
    where: { id: salesOrderItemId },
    select: { orderId: true },
  });
}

/**
 * One line, with just enough to decide whether a delay reason is admissible.
 *
 * The outstanding quantity is recomputed here rather than trusted from a caller:
 * a covered line has nothing to explain, and that has to be judged against the
 * ledger inside the lock.
 */
export function findItemForDelay(
  tx: Prisma.TransactionClient,
  salesOrderItemId: string,
): Promise<{
  id: string;
  orderId: string;
  productName: string;
  quantity: number;
  cancelledQty: number;
  alreadyFulfilled: number;
  status: string;
  allocations: { quantity: number }[];
  order: { status: string };
} | null> {
  return tx.salesOrderItem.findUnique({
    where: { id: salesOrderItemId },
    select: {
      id: true,
      orderId: true,
      productName: true,
      quantity: true,
      cancelledQty: true,
      alreadyFulfilled: true,
      status: true,
      allocations: { select: { quantity: true } },
      order: { select: { status: true } },
    },
  });
}

export function findPurchaseDelay(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{
  id: string;
  status: string;
  requestedById: string;
  salesOrderItem: { orderId: string };
} | null> {
  return tx.purchaseDelayReason.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      requestedById: true,
      salesOrderItem: { select: { orderId: true } },
    },
  });
}

export function findProcurementDelay(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{
  id: string;
  status: string;
  requestedById: string;
  clock: { orderId: string };
} | null> {
  return tx.procurementDelayReason.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      requestedById: true,
      clock: { select: { orderId: true } },
    },
  });
}

/** Undecided purchase delay reasons across every order, for the queue. */
export function findPendingPurchaseDelays(): Promise<
  (DelayReasonRow & {
    salesOrderItem: {
      id: string;
      productName: string;
      order: { id: string; orderId: string; customer: { name: string } };
    };
  })[]
> {
  return prisma.purchaseDelayReason.findMany({
    where: { status: 'PENDING' },
    select: {
      ...delayReasonSelect,
      salesOrderItem: {
        select: {
          id: true,
          productName: true,
          order: { select: { id: true, orderId: true, customer: { select: { name: true } } } },
        },
      },
    },
    orderBy: { requestedAt: 'asc' },
  });
}

/** Undecided order-level reasons, for the administrator's queue. */
export function findPendingProcurementDelays(): Promise<
  (DelayReasonRow & {
    clock: { orderId: string; order: { orderId: string; customer: { name: string } } };
  })[]
> {
  return prisma.procurementDelayReason.findMany({
    where: { status: 'PENDING' },
    select: {
      ...delayReasonSelect,
      clock: {
        select: {
          orderId: true,
          order: { select: { orderId: true, customer: { select: { name: true } } } },
        },
      },
    },
    orderBy: { requestedAt: 'asc' },
  });
}
