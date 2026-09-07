/**
 * Every database read and write for Purchase & Procurement.
 *
 * The service decides what is allowed; this decides how it is fetched. The two
 * locking helpers at the top are the load-bearing part of the module: standing
 * quantity is a subtraction over rows that other requests are also writing, so
 * it can only be trusted while the rows it summarises are held.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

/**
 * Locks a purchase bill item so its standing quantity cannot move underneath a
 * caller that is about to spend it.
 *
 * Without this, two allocations reading "4 standing" concurrently would both
 * pass their check and both write, handing out eight units of four. The lock
 * is taken on the bill item rather than on the allocations, because the
 * quantity being protected is a property of the item and a second allocation
 * row may not exist yet — there is nothing to lock until it does.
 */
export async function lockBillItem(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "PurchaseBillItem" WHERE "id" = ${id} FOR UPDATE`;
}

/**
 * Locks an order line, for the mirror-image race: two allocations from
 * *different* bills filling the same requirement. Locking only the bill item
 * would let each pass its own standing check and jointly over-fill the order.
 *
 * Both locks are always taken in the same order — bill item, then order line —
 * so two requests touching the same pair cannot deadlock by grabbing them in
 * opposite sequence.
 */
export async function lockOrderLine(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "SalesOrderItem" WHERE "id" = ${id} FOR UPDATE`;
}

// ---------------------------------------------------------------------------
//  Products & inventory
// ---------------------------------------------------------------------------

export const productSelect = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  createdAt: true,
  inventory: { select: { onHand: true } },
} as const;

export function findProducts(where: Prisma.ProductWhereInput, take: number) {
  return prisma.product.findMany({
    where,
    select: productSelect,
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    take,
  });
}

export function findProduct(id: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  return client.product.findUnique({ where: { id }, select: productSelect });
}

export function findProductByName(name: string) {
  return prisma.product.findUnique({ where: { name }, select: { id: true } });
}

/** Locks the stock row before a correction, so two counts cannot clobber. */
export async function lockInventory(tx: Prisma.TransactionClient, productId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "InventoryItem" WHERE "productId" = ${productId} FOR UPDATE`;
}

// ---------------------------------------------------------------------------
//  Purchase bills
// ---------------------------------------------------------------------------

const allocationSelect = {
  id: true,
  quantity: true,
  salesOrderItemId: true,
  createdAt: true,
  salesOrderItem: {
    select: {
      id: true,
      productName: true,
      quantity: true,
      // Needed to say whether the line is fully met, and so frozen.
      alreadyFulfilled: true,
      product: { select: { inventory: { select: { onHand: true } } } },
      allocations: { select: { quantity: true } },
      order: { select: { id: true, orderId: true, customer: { select: { name: true } } } },
    },
  },
} as const;

const billItemSelect = {
  id: true,
  lineNo: true,
  productName: true,
  orderedQty: true,
  receivedQty: true,
  rate: true,
  product: { select: productSelect },
  productImage: { select: { id: true, secureUrl: true } },
  allocations: { select: allocationSelect, orderBy: { createdAt: 'asc' } },
} as const;

export const billDetailSelect = {
  id: true,
  billNumber: true,
  billType: true,
  status: true,
  billDate: true,
  expectedBy: true,
  isDelayed: true,
  delayReason: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  vendor: { select: { id: true, name: true } },
  billImage: { select: { id: true, secureUrl: true } },
  createdBy: { select: { id: true, name: true } },
  items: { select: billItemSelect, orderBy: { lineNo: 'asc' } },
} as const;

export function findBill(
  id: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return client.purchaseBill.findUnique({ where: { id }, select: billDetailSelect });
}

export function findBills(where: Prisma.PurchaseBillWhereInput, take: number, cursor?: string) {
  return prisma.purchaseBill.findMany({
    where,
    select: billDetailSelect,
    orderBy: [{ billDate: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/**
 * The next free line number on a bill, read inside the caller's transaction so
 * two concurrent adds cannot pick the same one. The unique index on
 * (billId, lineNo) is the backstop if they somehow do.
 */
export async function nextLineNo(tx: Prisma.TransactionClient, billId: string): Promise<number> {
  const last = await tx.purchaseBillItem.findFirst({
    where: { billId },
    select: { lineNo: true },
    orderBy: { lineNo: 'desc' },
  });
  return (last?.lineNo ?? 0) + 1;
}

export function findBillItem(
  tx: Prisma.TransactionClient,
  id: string,
) {
  return tx.purchaseBillItem.findUnique({
    where: { id },
    select: {
      id: true,
      billId: true,
      productId: true,
      productName: true,
      orderedQty: true,
      receivedQty: true,
      allocations: { select: { id: true, quantity: true, salesOrderItemId: true } },
    },
  });
}

/**
 * The order line an allocation targets, with everything needed to decide
 * whether it may be filled: the requirement, what stock covers, and what other
 * bills have already assigned to it.
 */
export function findOrderLine(tx: Prisma.TransactionClient, id: string) {
  return tx.salesOrderItem.findUnique({
    where: { id },
    select: {
      id: true,
      productId: true,
      productName: true,
      quantity: true,
      alreadyFulfilled: true,
      status: true,
      order: { select: { id: true, orderId: true, status: true } },
      allocations: { select: { id: true, quantity: true } },
    },
  });
}

/** An order looked up by the number a human typed, with its lines. */
export function findOrderByNumber(orderId: string) {
  return prisma.salesOrder.findUnique({
    where: { orderId },
    select: {
      id: true,
      orderId: true,
      orderDate: true,
      status: true,
      customer: { select: { id: true, name: true } },
      items: {
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          lineNo: true,
          productName: true,
          productId: true,
          quantity: true,
          alreadyFulfilled: true,
          product: { select: { inventory: { select: { onHand: true } } } },
          allocations: { select: { quantity: true } },
        },
        orderBy: { lineNo: 'asc' },
      },
    },
  });
}

export function findAllocation(tx: Prisma.TransactionClient, id: string) {
  return tx.purchaseAllocation.findUnique({
    where: { id },
    select: {
      id: true,
      quantity: true,
      purchaseBillItemId: true,
      salesOrderItemId: true,
    },
  });
}

/**
 * Every ACTIVE order line on an order that is not yet dispatched, grouped by
 * product — the raw material for the shortage board.
 */
export function findOpenRequirements() {
  return prisma.salesOrderItem.findMany({
    // Unlinked lines are deliberately included. A requirement typed as free
    // text is still a customer waiting for goods, and excluding it made real
    // demand invisible to the people whose job is to buy it. The catalogue
    // link decides how a row is *keyed*, not whether it counts.
    where: { status: 'ACTIVE', order: { status: 'OPEN' } },
    select: {
      productId: true,
      productName: true,
      quantity: true,
      alreadyFulfilled: true,
      allocations: { select: { quantity: true } },
    },
  });
}

/**
 * Purchase lines that have no catalogue link, for the free-text side of the
 * shortage board. Keyed by the vendor's wording, exactly as recorded.
 */
export function findUnlinkedBillItems() {
  return prisma.purchaseBillItem.findMany({
    where: { productId: null },
    select: {
      productName: true,
      receivedQty: true,
      allocations: { select: { quantity: true } },
    },
  });
}

/**
 * Every ACTIVE line on an open order, with the customer attached — the SALES
 * board's raw material.
 *
 * Scoped to OPEN orders for the same reason the shortage board is: a dispatched
 * or closed order is no longer demand anyone needs to buy against.
 */
export function findSalesRequirements() {
  return prisma.salesOrderItem.findMany({
    where: { status: 'ACTIVE', order: { status: 'OPEN' } },
    select: {
      id: true,
      productName: true,
      productId: true,
      quantity: true,
      alreadyFulfilled: true,
      allocations: { select: { quantity: true } },
      order: {
        select: { id: true, orderId: true, orderDate: true, customer: { select: { name: true } } },
      },
    },
    orderBy: [{ order: { orderDate: 'desc' } }, { lineNo: 'asc' }],
  });
}

/** One order line, for recording fulfilment against it. */
export function findLineForFulfillment(tx: Prisma.TransactionClient, id: string) {
  return tx.salesOrderItem.findUnique({
    where: { id },
    select: {
      id: true,
      quantity: true,
      alreadyFulfilled: true,
      productName: true,
      allocations: { select: { quantity: true } },
      order: { select: { orderId: true } },
    },
  });
}

/**
 * When each of these order lines was last supplied against.
 *
 * Two batched queries rather than one per line: the audit trail records
 * `alreadyFulfilled` edits, and PurchaseAllocation records procurement
 * fulfilment. Neither alone covers every line — some lines have only a hand
 * entry, some only an allocation — so the caller takes whichever is later.
 *
 * `fulfilledAt` is deliberately not a column. It would be a second copy of a
 * truth these two tables already hold, free to drift from them; and no stored
 * value could describe the rows that were fulfilled before any such column
 * existed. Reading the events keeps one source of truth.
 */
export async function findFulfillmentEvents(
  salesOrderItemIds: string[],
): Promise<Map<string, Date>> {
  const latest = new Map<string, Date>();
  if (salesOrderItemIds.length === 0) return latest;

  const keep = (id: string | null, at: Date): void => {
    if (!id) return;
    const current = latest.get(id);
    if (!current || at > current) latest.set(id, at);
  };

  const [audits, allocations] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        action: 'procurement.fulfillment.recorded',
        entityType: 'SalesOrderItem',
        entityId: { in: salesOrderItemIds },
      },
      select: { entityId: true, createdAt: true },
    }),
    prisma.purchaseAllocation.findMany({
      where: { salesOrderItemId: { in: salesOrderItemIds } },
      select: { salesOrderItemId: true, createdAt: true },
    }),
  ]);

  for (const a of audits) keep(a.entityId, a.createdAt);
  for (const a of allocations) keep(a.salesOrderItemId, a.createdAt);
  return latest;
}

/** A catalogue entry by its folded name — the identity the unique index holds. */
export function findProductByNormalizedName(normalizedName: string) {
  return prisma.product.findUnique({
    where: { normalizedName },
    select: { ...productSelect, normalizedName: true },
  });
}

/**
 * Catalogue entries for a set of folded names, in one query.
 *
 * The batch form exists because the shortage board resolves every free-text
 * line at once: one round trip beats one per name, and Neon is a network hop
 * away. Callers that already hold the catalogue should build their own map
 * from it rather than calling this at all.
 */
export function findProductsByNormalizedNames(normalizedNames: string[]) {
  if (normalizedNames.length === 0) return Promise.resolve([]);
  return prisma.product.findMany({
    where: { normalizedName: { in: normalizedNames } },
    select: { ...productSelect, normalizedName: true },
  });
}

/**
 * One order line with everything behind its fulfilment.
 *
 * A single nested query rather than a walk: the allocations, the purchase
 * lines they came off, those lines' own bills and vendors, and the sibling
 * allocations needed to state each line's standing quantity. Prisma turns this
 * into a handful of joined statements, so opening one History row costs the
 * same whether it has one source or six.
 */
export function findFulfillmentDetail(salesOrderItemId: string) {
  return prisma.salesOrderItem.findUnique({
    where: { id: salesOrderItemId },
    select: {
      id: true,
      productName: true,
      quantity: true,
      alreadyFulfilled: true,
      createdAt: true,
      product: { select: productSelect },
      order: {
        select: {
          id: true,
          orderId: true,
          orderDate: true,
          status: true,
          createdAt: true,
          customer: { select: { id: true, name: true, phone: true, email: true } },
        },
      },
      allocations: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          quantity: true,
          createdAt: true,
          purchaseBillItem: {
            select: {
              id: true,
              productName: true,
              orderedQty: true,
              receivedQty: true,
              rate: true,
              // Every allocation on the line, so standing can be stated
              // against the line as a whole rather than this order's share.
              allocations: { select: { quantity: true } },
              bill: {
                select: {
                  id: true,
                  billNumber: true,
                  billType: true,
                  status: true,
                  billDate: true,
                  expectedBy: true,
                  createdAt: true,
                  vendor: {
                    select: {
                      id: true, name: true, contactPerson: true,
                      phone: true, email: true, city: true, isActive: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}
