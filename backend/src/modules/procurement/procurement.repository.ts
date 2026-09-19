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
//  RS Products — the canonical catalogue
// ---------------------------------------------------------------------------

/**
 * Everything Procurement shows about an RS Product, and nothing more.
 *
 * Variants appear here only so the product-level figures can be derived from
 * them — the SKU of the first, and the two summed stock counts. None of them
 * reaches the API: `RsProductRef` carries one product, one SKU string and two
 * numbers, so no variant concept escapes into Procurement.
 *
 * BOTH stock columns are selected, because they are two different facts:
 * `crmStockQty` is the hand-maintained CRM count and `inventoryQty` is
 * Shopify's sellable quantity. Procurement shows them side by side under
 * separate labels; selecting only one and captioning it with the other's name
 * is exactly the conflation the separate columns exist to prevent.
 *
 * Ordered by position for both, so "the first variant" and "the first image"
 * mean the same thing here as they do in the RS Products catalogue itself.
 */
export const rsProductRefSelect = {
  id: true,
  title: true,
  variants: {
    select: { sku: true, crmStockQty: true, inventoryQty: true },
    orderBy: { position: 'asc' },
  },
  images: {
    select: { url: true },
    orderBy: { position: 'asc' },
    take: 1,
  },
} as const satisfies Prisma.RsProductSelect;

/** One RS Product, for mapping a line — a purchase line or an order line — to it. */
export function findRsProduct(id: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  return client.rsProduct.findUnique({
    where: { id },
    select: { ...rsProductRefSelect, status: true },
  });
}

/**
 * The RS Products named by a set of ids, for the shortage board's spine.
 *
 * The board used to be built by scanning the legacy catalogue and keying demand
 * onto it. There is no catalogue to scan now — RS Products holds five hundred
 * rows and will hold more, and almost none of them are on an open order — so
 * the rows are the products demand and supply actually name, fetched by id.
 */
export function findRsProductsByIds(ids: string[]) {
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.rsProduct.findMany({ where: { id: { in: ids } }, select: rsProductRefSelect });
}

/*
 * The legacy Product master and InventoryItem have no accessors here any more.
 *
 * `productSelect`, `findProducts`, `findProduct`, `findProductByName`,
 * `lockInventory` and the two normalised-name lookups all went with them. There
 * is one product identity — RsProduct.id — so there is nothing left to look a
 * product up in, and nothing to fold a name onto.
 */

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
      allocations: { select: { quantity: true } },
      order: { select: { id: true, orderId: true, customer: { select: { name: true } } } },
    },
  },
} as const;

/**
 * One re-mapping request, with both products and both people resolved.
 *
 * The products are fetched in full rather than as ids because every consumer —
 * the approval queue, the bill line, the audit entry — needs to show a person
 * which goods are being moved, and a cuid shows nobody anything.
 */
export const productChangeSelect = {
  id: true,
  billId: true,
  itemId: true,
  reason: true,
  status: true,
  requestedAt: true,
  reviewedAt: true,
  reviewNote: true,
  fromRsProduct: { select: rsProductRefSelect },
  toRsProduct: { select: rsProductRefSelect },
  requestedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  bill: { select: { billNumber: true } },
  item: {
    select: {
      productName: true,
      // So an approver can see that the line's stock is already promised, and
      // that approving would therefore be refused.
      allocations: { select: { quantity: true } },
    },
  },
} as const satisfies Prisma.PurchaseItemProductChangeSelect;

const billItemSelect = {
  id: true,
  lineNo: true,
  productName: true,
  orderedQty: true,
  receivedQty: true,
  rate: true,
  rsProduct: { select: rsProductRefSelect },
  productImage: { select: { id: true, secureUrl: true } },
  allocations: { select: allocationSelect, orderBy: { createdAt: 'asc' } },
  /*
    The undecided request on this line, if there is one.

    `take: 1` is safe rather than arbitrary: a partial unique index permits at
    most one PENDING row per item, so this is "the" pending request and not the
    first of several.
  */
  productChanges: {
    where: { status: 'PENDING' as const },
    select: productChangeSelect,
    take: 1,
  },
} as const;

export const billDetailSelect = {
  id: true,
  billNumber: true,
  billType: true,
  status: true,
  approvalStatus: true,
  reviewedAt: true,
  reviewNote: true,
  reviewedBy: { select: { id: true, name: true } },
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
      rsProductId: true,
      productName: true,
      orderedQty: true,
      receivedQty: true,
      allocations: { select: { id: true, quantity: true, salesOrderItemId: true } },
      // The parent bill's sign-off, read with the line so allocation can refuse
      // an unapproved bill inside the same lock it already takes, rather than
      // in a second query that could see a different answer.
      bill: { select: { approvalStatus: true } },
    },
  });
}

/**
 * Everything needed to decide what one line currently stands for in CRM stock.
 *
 * The bill's approval and the line's own allocations come back with it, because
 * the target is a function of all three and reading them separately would let
 * the parts disagree under concurrency.
 */
export function findLineForStock(tx: Prisma.TransactionClient, id: string) {
  return tx.purchaseBillItem.findUnique({
    where: { id },
    select: {
      id: true,
      rsProductId: true,
      receivedQty: true,
      stockedQty: true,
      allocations: { select: { quantity: true } },
      bill: { select: { approvalStatus: true } },
    },
  });
}

/** Every line on a bill, for reconciling the whole bill at approval. */
export function findBillLineIds(tx: Prisma.TransactionClient, billId: string) {
  return tx.purchaseBillItem.findMany({ where: { billId }, select: { id: true } });
}

/**
 * Where a product's CRM stock is actually written.
 *
 * Procurement maps at product level, but `crmStockQty` is a column on
 * ShopifyVariant and the product-level figure is the SUM across variants. So a
 * product-level delta has to land on some variant, and this picks the lowest
 * `position` — the same variant `RsProductListRow` and `RsProductRef` already
 * take their SKU from, so "the first variant" means one thing throughout.
 *
 * This is a storage detail, not variant mapping: nothing selects, stores or
 * exposes a variant id, and every reader still sees only the product-level sum.
 */
export async function firstVariantId(
  tx: Prisma.TransactionClient,
  rsProductId: string,
): Promise<string | null> {
  const variant = await tx.shopifyVariant.findFirst({
    where: { rsProductId },
    select: { id: true },
    orderBy: { position: 'asc' },
  });
  return variant?.id ?? null;
}

/**
 * Moves a product's CRM stock by a delta.
 *
 * `increment` rather than a read-then-write, so two transactions touching the
 * same product from different bill lines cannot each read the old value and
 * overwrite one another. The database does the addition.
 */
export async function moveCrmStock(
  tx: Prisma.TransactionClient,
  variantId: string,
  delta: number,
): Promise<void> {
  await tx.shopifyVariant.update({
    where: { id: variantId },
    data: { crmStockQty: { increment: delta } },
  });
}

/** One bill's approval state, for deciding it under a lock. */
export function findBillForReview(tx: Prisma.TransactionClient, id: string) {
  return tx.purchaseBill.findUnique({
    where: { id },
    select: { id: true, approvalStatus: true, createdById: true, billNumber: true },
  });
}

/** Locks a bill so two reviewers cannot decide it at once. */
export async function lockBill(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "PurchaseBill" WHERE "id" = ${id} FOR UPDATE`;
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
      rsProductId: true,
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
          rsProductId: true,
          quantity: true,
          alreadyFulfilled: true,
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

// ---------------------------------------------------------------------------
//  Product change requests
// ---------------------------------------------------------------------------

/** The approval queue, newest first. Filtered by status and/or bill. */
export function findProductChanges(where: Prisma.PurchaseItemProductChangeWhereInput) {
  return prisma.purchaseItemProductChange.findMany({
    where,
    select: productChangeSelect,
    orderBy: [{ requestedAt: 'desc' }],
    take: 200,
  });
}

/** One request, read inside the reviewer's transaction before it is decided. */
export function findProductChange(tx: Prisma.TransactionClient, id: string) {
  return tx.purchaseItemProductChange.findUnique({
    where: { id },
    select: {
      id: true,
      billId: true,
      itemId: true,
      status: true,
      fromRsProductId: true,
      toRsProductId: true,
      requestedById: true,
    },
  });
}

/** Whether this line already has an undecided request, for a readable message. */
export function findPendingChangeForItem(tx: Prisma.TransactionClient, itemId: string) {
  return tx.purchaseItemProductChange.findFirst({
    where: { itemId, status: 'PENDING' },
    select: { id: true },
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
      rsProductId: true,
      productName: true,
      quantity: true,
      alreadyFulfilled: true,
      allocations: { select: { quantity: true } },
    },
  });
}

/**
 * Every purchase line, with both identities and the RS Product behind the new
 * one — the supply side of the shortage board.
 *
 * One query rather than the two this replaced (linked lines, then unlinked
 * ones). A line now carries up to two keys and the board has to key each row on
 * whichever it actually has, so splitting the fetch by which key is null would
 * mean deciding the same question twice in two places.
 */
export function findBillItemsForShortages() {
  return prisma.purchaseBillItem.findMany({
    select: {
      productName: true,
      receivedQty: true,
      rsProduct: { select: rsProductRefSelect },
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
      rsProductId: true,
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
      rsProduct: { select: rsProductRefSelect },
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
