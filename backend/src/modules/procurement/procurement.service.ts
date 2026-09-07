/**
 * Purchase & Procurement business logic.
 *
 * The module's whole job is to keep two ledgers honest at once: what a vendor
 * actually delivered, and what each customer order is still owed. Every write
 * that touches both happens inside a transaction with the two affected rows
 * locked, in a fixed order, because the quantities being compared are the same
 * quantities other requests are changing.
 */

import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type {
  AdjustInventoryInput,
  AllocationView,
  CreateAllocationInput,
  CreateProductInput,
  CreatePurchaseBillInput,
  LinkOrderLineInput,
  LinkPurchaseItemInput,
  OrderRequirementView,
  ProductListQuery,
  ProductView,
  PurchaseBillDetail,
  PurchaseBillItemView,
  PurchaseBillListQuery,
  PurchaseBillSummary,
  RecordFulfillmentInput,
  PutInCatalogueInput,
  SalesRequirementQuery,
  SalesFulfillmentDetail,
  FulfillmentSource,
  FulfillmentEvent,
  SalesRequirementRow,
  PurchaseDelayInput,
  ReceiveItemInput,
  ShortageRow,
  UpdateAllocationInput,
  UpdateProductInput,
  UpdatePurchaseBillInput,
} from '@rs/shared';
import { addAmount, lineTotal, normalizeProductName } from '@rs/shared';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { canModifyAllocation } from '../../policies/procurement-access.js';
import {
  allocatedQty,
  fulfillmentStatus,
  isFrozen,
  istDay,
  pendingQty,
  standingQty,
  totalFulfilled,
} from './procurement.calc.js';
import * as repo from './procurement.repository.js';
import * as resolver from './procurement.resolver.js';

/** Neon is a network hop away; the same budget the enquiry module uses. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

const productNotFound = (): AppError =>
  AppError.notFound('PRODUCT_NOT_FOUND', 'That product could not be found.');
const billNotFound = (): AppError =>
  AppError.notFound('PURCHASE_BILL_NOT_FOUND', 'That purchase bill could not be found.');
const itemNotFound = (): AppError =>
  AppError.notFound('PURCHASE_ITEM_NOT_FOUND', 'That purchase line could not be found.');
const allocationNotFound = (): AppError =>
  AppError.notFound('ALLOCATION_NOT_FOUND', 'That allocation could not be found.');

// ---------------------------------------------------------------------------
//  Projections
// ---------------------------------------------------------------------------

type ProductRow = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  inventory: { onHand: number } | null;
};

function toProductView(row: ProductRow): ProductView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    // A product with no stock row has never been counted, which is zero.
    onHand: row.inventory?.onHand ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Whether the order line an allocation fills is fully met, and so frozen. */
function lineIsFulfilled(line: {
  quantity: number;
  alreadyFulfilled: number;
  allocations: { quantity: number }[];
}): boolean {
  return isFrozen(pendingQty(line.quantity, line.alreadyFulfilled, allocatedQty(line.allocations)));
}

type BillRow = NonNullable<Awaited<ReturnType<typeof repo.findBill>>>;

function toBillItemView(item: BillRow['items'][number]): PurchaseBillItemView {
  const rate = item.rate.toFixed(2);
  return {
    id: item.id,
    lineNo: item.lineNo,
    productName: item.productName,
    product: item.product ? toProductView(item.product) : null,
    orderedQty: item.orderedQty,
    receivedQty: item.receivedQty,
    rate,
    lineTotal: lineTotal(rate, item.receivedQty),
    standingQty: standingQty(item.receivedQty, item.allocations),
    allocatedQty: allocatedQty(item.allocations),
    productImage: item.productImage,
    allocations: item.allocations.map((a): AllocationView => ({
      id: a.id,
      quantity: a.quantity,
      salesOrderItemId: a.salesOrderItemId,
      order: {
        id: a.salesOrderItem.order.id,
        orderId: a.salesOrderItem.order.orderId,
        customerName: a.salesOrderItem.order.customer.name,
      },
      productName: a.salesOrderItem.productName,
      /**
       * Whether the line this allocation fills is fully met, from the totals
       * carried on the row itself. This drives what the UI offers; the
       * authoritative check runs again under a row lock before any write, so a
       * stale `false` here can never actually let a frozen line be edited.
       */
      frozen: isFrozen(
        pendingQty(
          a.salesOrderItem.quantity,
          a.salesOrderItem.alreadyFulfilled,
          allocatedQty(a.salesOrderItem.allocations),
        ),
      ),
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

function toBillDetail(row: BillRow): PurchaseBillDetail {
  const items = row.items.map(toBillItemView);
  return {
    id: row.id,
    billNumber: row.billNumber,
    vendor: row.vendor,
    billType: row.billType,
    status: row.status,
    billDate: row.billDate.toISOString(),
    expectedBy: row.expectedBy?.toISOString() ?? null,
    isDelayed: row.isDelayed,
    delayReason: row.delayReason,
    notes: row.notes,
    billImage: row.billImage,
    billTotal: items.reduce((sum, i) => addAmount(sum, i.lineTotal), '0.00'),
    totalStandingQty: items.reduce((sum, i) => sum + i.standingQty, 0),
    items,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toBillSummary(row: BillRow): PurchaseBillSummary {
  const detail = toBillDetail(row);
  return {
    id: detail.id,
    billNumber: detail.billNumber,
    vendor: detail.vendor,
    billType: detail.billType,
    status: detail.status,
    billDate: detail.billDate,
    expectedBy: detail.expectedBy,
    isDelayed: detail.isDelayed,
    itemCount: detail.items.length,
    billTotal: detail.billTotal,
    totalStandingQty: detail.totalStandingQty,
    createdAt: detail.createdAt,
  };
}

// ---------------------------------------------------------------------------
//  Products & inventory
// ---------------------------------------------------------------------------

export async function listProducts(query: ProductListQuery): Promise<ProductView[]> {
  const where: Prisma.ProductWhereInput = {
    ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
  };
  return (await repo.findProducts(where, query.limit)).map(toProductView);
}

export async function createProduct(
  req: Request,
  actorId: string,
  input: CreateProductInput,
): Promise<ProductView> {
  // Checked on the folded name, not the raw one: "Kansa Dinner Set" must
  // collide with an existing "kansa dinner set" rather than becoming a second
  // product beside it. The unique index refuses it either way; this is here to
  // answer with a sentence instead of a constraint violation.
  const existing = await repo.findProductByNormalizedName(normalizeProductName(input.name));
  if (existing) {
    throw AppError.conflict(
      existing.isActive ? 'PRODUCT_EXISTS' : 'PRODUCT_EXISTS_INACTIVE',
      existing.isActive
        ? `“${existing.name}” is already in the catalogue.`
        : `“${existing.name}” is already in the catalogue but is inactive.`,
    );
  }

  const created = await prisma.product.create({
    data: {
      name: input.name,
      normalizedName: normalizeProductName(input.name),
      description: input.description ?? null,
      // Every product gets a stock row at creation, so nothing has to cope
      // later with a product that has no inventory record.
      inventory: { create: { onHand: input.onHand ?? 0 } },
    },
    select: repo.productSelect,
  });

  await recordAudit(req, {
    action: 'procurement.product.created',
    entityType: 'Product',
    entityId: created.id,
    actorId,
    newValue: { name: created.name, onHand: input.onHand ?? 0 },
  });

  return toProductView(created);
}

export async function updateProduct(
  req: Request,
  actorId: string,
  id: string,
  input: UpdateProductInput,
): Promise<ProductView> {
  if (!(await repo.findProduct(id))) throw productNotFound();

  if (input.name) {
    const clash = await repo.findProductByName(input.name);
    if (clash && clash.id !== id) {
      throw AppError.conflict('PRODUCT_EXISTS', 'A product with that name already exists.');
    }
  }

  const updated = await prisma.product.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    select: repo.productSelect,
  });

  await recordAudit(req, {
    action: 'procurement.product.updated',
    entityType: 'Product',
    entityId: id,
    actorId,
    newValue: input as Prisma.InputJsonValue,
  });

  return toProductView(updated);
}

/**
 * Corrects stock by a signed delta, under a row lock.
 *
 * A delta rather than an absolute count so two people correcting the same
 * shelf compose instead of overwriting each other with stale totals. The floor
 * at zero is also a database CHECK, so a racing pair cannot drive it negative
 * between the read and the write.
 */
export async function adjustInventory(
  req: Request,
  actorId: string,
  productId: string,
  input: AdjustInventoryInput,
): Promise<ProductView> {
  const result = await prisma.$transaction(async (tx) => {
    await repo.lockInventory(tx, productId);

    const product = await repo.findProduct(productId, tx);
    if (!product) throw productNotFound();

    const current = product.inventory?.onHand ?? 0;
    const next = current + input.delta;
    if (next < 0) {
      throw AppError.badRequest(
        'INSUFFICIENT_STOCK',
        `That would leave ${next} in stock. Only ${current} is on hand.`,
      );
    }

    await tx.inventoryItem.upsert({
      where: { productId },
      update: { onHand: next },
      create: { productId, onHand: next },
    });

    return { current, next };
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.inventory.adjusted',
    entityType: 'Product',
    entityId: productId,
    actorId,
    oldValue: { onHand: result.current },
    newValue: { onHand: result.next, delta: input.delta, reason: input.reason },
  });

  const product = await repo.findProduct(productId);
  return toProductView(product!);
}

// ---------------------------------------------------------------------------
//  Purchase bills
// ---------------------------------------------------------------------------

export async function listBills(
  query: PurchaseBillListQuery,
): Promise<{ bills: PurchaseBillSummary[]; nextCursor: string | null }> {
  const where: Prisma.PurchaseBillWhereInput = {
    ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.billType ? { billType: query.billType } : {}),
    ...(query.isDelayed === undefined ? {} : { isDelayed: query.isDelayed }),
    ...(query.q
      ? {
          OR: [
            { billNumber: { contains: query.q, mode: 'insensitive' as const } },
            { vendor: { name: { contains: query.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const rows = await repo.findBills(where, query.limit, query.cursor);
  const page = rows.slice(0, query.limit);

  return {
    bills: page.map(toBillSummary),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getBill(id: string): Promise<PurchaseBillDetail> {
  const row = await repo.findBill(id);
  if (!row) throw billNotFound();
  return toBillDetail(row);
}

export async function createBill(
  req: Request,
  actor: AuthenticatedUser,
  input: CreatePurchaseBillInput,
): Promise<PurchaseBillDetail> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: input.vendorId },
    select: { id: true, isActive: true },
  });
  if (!vendor || !vendor.isActive) {
    throw AppError.notFound('VENDOR_NOT_FOUND', 'That vendor could not be found.');
  }

  // Only the lines that named a catalogue product are checked; the rest are
  // free text by design and are linked later, when stock is allocated.
  const productIds = [
    ...new Set(input.items.map((i) => i.productId).filter((v): v is string => Boolean(v))),
  ];
  if (productIds.length > 0) {
    const found = await prisma.product.findMany({
      where: { id: { in: productIds }, isActive: true },
      select: { id: true },
    });
    if (found.length !== productIds.length) {
      throw AppError.badRequest('PRODUCT_NOT_FOUND', 'One of those products could not be found.');
    }
  }

  const id = await prisma.$transaction(async (tx) => {
    const bill = await tx.purchaseBill.create({
      data: {
        billNumber: input.billNumber,
        vendorId: input.vendorId,
        billType: input.billType,
        billDate: input.billDate,
        expectedBy: input.expectedBy ?? null,
        billImageId: input.billImageAssetId ?? null,
        notes: input.notes ?? null,
        createdById: actor.id,
        items: {
          create: input.items.map((item, index) => ({
            lineNo: index + 1,
            productName: item.productName,
            productId: item.productId ?? null,
            orderedQty: item.orderedQty,
            receivedQty: item.receivedQty,
            rate: item.rate,
            productImageId: item.productImageAssetId ?? null,
          })),
        },
      },
      select: { id: true },
    });
    return bill.id;
  }, TX_OPTIONS).catch((error: unknown) => {
    // The unique index on (vendorId, billNumber) is the authority on
    // duplicates; catching it here turns a raw constraint error into the
    // module's own vocabulary.
    if ((error as { code?: string }).code === 'P2002') {
      throw AppError.conflict(
        'BILL_NUMBER_EXISTS',
        'That vendor already has a bill with this number.',
      );
    }
    throw error;
  });

  await recordAudit(req, {
    action: 'procurement.bill.created',
    entityType: 'PurchaseBill',
    entityId: id,
    actorId: actor.id,
    newValue: { billNumber: input.billNumber, vendorId: input.vendorId, lines: input.items.length },
  });

  return getBill(id);
}

export async function updateBill(
  req: Request,
  actorId: string,
  id: string,
  input: UpdatePurchaseBillInput,
): Promise<PurchaseBillDetail> {
  if (!(await repo.findBill(id))) throw billNotFound();

  await prisma.purchaseBill.update({
    where: { id },
    data: {
      ...(input.billType !== undefined ? { billType: input.billType } : {}),
      ...(input.expectedBy !== undefined ? { expectedBy: input.expectedBy } : {}),
      ...(input.billImageAssetId !== undefined ? { billImageId: input.billImageAssetId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });

  await recordAudit(req, {
    action: 'procurement.bill.updated',
    entityType: 'PurchaseBill',
    entityId: id,
    actorId,
    newValue: input as Prisma.InputJsonValue,
  });

  return getBill(id);
}

/**
 * Records what actually arrived.
 *
 * Lowering received below what is already allocated is refused: that stock has
 * been promised to an order, and silently un-promising it would leave the
 * order's arithmetic claiming goods nobody has.
 */
export async function receiveItem(
  req: Request,
  actorId: string,
  billId: string,
  itemId: string,
  input: ReceiveItemInput,
): Promise<PurchaseBillDetail> {
  await prisma.$transaction(async (tx) => {
    await repo.lockBillItem(tx, itemId);

    const item = await repo.findBillItem(tx, itemId);
    if (!item || item.billId !== billId) throw itemNotFound();

    if (input.receivedQty > item.orderedQty) {
      throw AppError.badRequest(
        'RECEIVED_EXCEEDS_ORDERED',
        `Cannot receive ${input.receivedQty}; only ${item.orderedQty} were ordered.`,
      );
    }

    const allocated = allocatedQty(item.allocations);
    if (input.receivedQty < allocated) {
      throw AppError.conflict(
        'RECEIVED_BELOW_ALLOCATED',
        `${allocated} unit(s) are already allocated to orders. Release them before lowering the received quantity.`,
      );
    }

    await tx.purchaseBillItem.update({
      where: { id: itemId },
      data: { receivedQty: input.receivedQty },
    });

    // A bill whose every line has arrived is RECEIVED. Derived from the lines
    // rather than set by hand, so the status cannot disagree with them.
    const items = await tx.purchaseBillItem.findMany({
      where: { billId },
      select: { orderedQty: true, receivedQty: true },
    });
    const allIn = items.every((i) => i.receivedQty >= i.orderedQty);
    await tx.purchaseBill.update({
      where: { id: billId },
      data: { status: allIn ? 'RECEIVED' : 'OPEN' },
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.item.received',
    entityType: 'PurchaseBillItem',
    entityId: itemId,
    actorId,
    newValue: { receivedQty: input.receivedQty },
  });

  return getBill(billId);
}

/** Flags a late delivery. The reason is mandatory — also a database CHECK. */
export async function markDelayed(
  req: Request,
  actorId: string,
  id: string,
  input: PurchaseDelayInput,
): Promise<PurchaseBillDetail> {
  if (!(await repo.findBill(id))) throw billNotFound();

  await prisma.purchaseBill.update({
    where: { id },
    data: { isDelayed: true, delayReason: input.reason },
  });

  await recordAudit(req, {
    action: 'procurement.bill.delayed',
    entityType: 'PurchaseBill',
    entityId: id,
    actorId,
    newValue: { reason: input.reason },
  });

  return getBill(id);
}

// ---------------------------------------------------------------------------
//  Order requirements
// ---------------------------------------------------------------------------

/**
 * An order looked up by the number a human typed, with the arithmetic each
 * line needs.
 *
 * Lines whose productId is null are returned with `linked: false` rather than
 * filtered away. Such a line predates the product master — or belongs to the
 * one historical order that cannot be written to at all — and hiding it would
 * turn a visible gap into a mystery about why an order looks short.
 */
export async function getOrderRequirements(orderNumber: string): Promise<OrderRequirementView> {
  const order = await repo.findOrderByNumber(orderNumber);
  if (!order) {
    throw AppError.notFound('SALES_ORDER_NOT_FOUND', 'No order was found with that ID.');
  }

  return {
    id: order.id,
    orderId: order.orderId,
    customer: order.customer,
    orderDate: order.orderDate.toISOString(),
    status: order.status,
    lines: order.items.map((item) => {
      const allocated = allocatedQty(item.allocations);
      const pending = pendingQty(item.quantity, item.alreadyFulfilled, allocated);

      return {
        salesOrderItemId: item.id,
        lineNo: item.lineNo,
        productName: item.productName,
        productId: item.productId,
        linked: item.productId !== null,
        requiredQty: item.quantity,
        alreadyFulfilled: item.alreadyFulfilled,
        allocatedQty: allocated,
        totalFulfilled: totalFulfilled(item.alreadyFulfilled, allocated),
        // Informational only: warehouse stock is shared across orders and is
        // never counted against one customer's requirement.
        availableInInventory: item.product?.inventory?.onHand ?? 0,
        pendingQty: pending,
        status: fulfillmentStatus(item.quantity, pending),
        frozen: isFrozen(pending),
      };
    }),
  };
}

/**
 * Where one order line's fulfilment came from.
 *
 * The summary figures are the same helpers the SALES board uses, not a second
 * implementation — a popup that recomputed them could disagree with the row
 * that opened it, and the person reading would have no way to tell which was
 * right.
 *
 * `alreadyFulfilled` is reported beside the sources but never as one: it
 * records goods supplied outside procurement, so attributing it to a vendor
 * would invent a purchase that never happened.
 */
export async function getFulfillmentDetail(
  salesOrderItemId: string,
): Promise<SalesFulfillmentDetail> {
  const line = await repo.findFulfillmentDetail(salesOrderItemId);
  if (!line) {
    throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
  }

  const procurementFulfilled = allocatedQty(line.allocations.map((a) => ({ quantity: a.quantity })));
  const unfulfilled = pendingQty(line.quantity, line.alreadyFulfilled, procurementFulfilled);

  const sources = line.allocations.map((a): FulfillmentSource => {
    const item = a.purchaseBillItem;
    const rate = item.rate.toFixed(2);
    return {
      allocationId: a.id,
      allocatedQty: a.quantity,
      allocatedAt: a.createdAt.toISOString(),
      purchaseLine: {
        id: item.id,
        // The vendor's own wording, kept as written.
        productName: item.productName,
        orderedQty: item.orderedQty,
        receivedQty: item.receivedQty,
        rate,
        lineTotal: lineTotal(rate, item.receivedQty),
        // Across the whole line, not just this order's share of it.
        standingQty: standingQty(item.receivedQty, item.allocations),
      },
      bill: {
        id: item.bill.id,
        billNumber: item.bill.billNumber,
        billType: item.bill.billType,
        status: item.bill.status,
        billDate: item.bill.billDate.toISOString(),
        expectedBy: item.bill.expectedBy?.toISOString() ?? null,
      },
      vendor: item.bill.vendor,
    };
  });

  /*
    Only things that actually carry a timestamp. An order has a creation date
    and every allocation has one; "already fulfilled" does not — it is a
    quantity someone typed, with no record of when the goods moved — so it is
    shown in the summary and left out of the timeline rather than given an
    invented date.
  */
  const activity: FulfillmentEvent[] = [
    {
      at: line.order.createdAt.toISOString(),
      label: 'Order placed',
      detail: `${line.quantity} × ${line.productName}`,
    },
    ...sources.map((s) => ({
      at: s.bill.billDate,
      label: `Purchase bill ${s.bill.billNumber}`,
      detail: `${s.vendor.name} · ${s.purchaseLine.receivedQty} received`,
    })),
    ...sources.map((s) => ({
      at: s.allocatedAt,
      label: 'Allocated to this order',
      detail: `${s.allocatedQty} from ${s.bill.billNumber}`,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return {
    salesOrderItemId: line.id,
    order: {
      id: line.order.id,
      orderId: line.order.orderId,
      orderDate: line.order.orderDate.toISOString(),
      status: line.order.status,
    },
    customer: line.order.customer,
    productName: line.productName,
    product: line.product ? toProductView(line.product) : null,
    requiredQty: line.quantity,
    alreadyFulfilled: line.alreadyFulfilled,
    procurementFulfilled,
    totalFulfilled: totalFulfilled(line.alreadyFulfilled, procurementFulfilled),
    unfulfilledQty: unfulfilled,
    status: fulfillmentStatus(line.quantity, unfulfilled),
    sources,
    activity,
  };
}

/**
 * What still has to be bought, across every open order, by product.
 *
 * Standing stock is reported beside the shortage rather than subtracted from
 * it: they answer different questions. A shortage says what the orders need;
 * standing says what is already on the shelf unassigned. Netting them would
 * hide the fact that the stock exists and merely needs allocating.
 */
export async function getShortages(): Promise<ShortageRow[]> {
  const [lines, products, billItems, unlinkedBillItems] = await Promise.all([
    repo.findOpenRequirements(),
    repo.findProducts({ isActive: true }, 500),
    prisma.purchaseBillItem.findMany({
      where: { productId: { not: null } },
      select: { productId: true, receivedQty: true, allocations: { select: { quantity: true } } },
    }),
    repo.findUnlinkedBillItems(),
  ]);

  /**
   * Demand is keyed two ways, and the prefixes keep them from colliding.
   *
   *   product:<id>   a catalogue-linked requirement
   *   name:<text>    free text with no catalogue entry to belong to
   *
   * A line without a `productId` is not automatically free text. "Brasscooker"
   * typed on a bill and "Brass Cooker" in the catalogue fold to one key, so it
   * is keyed as that product and its stock lands on that product's row —
   * previously the two appeared as separate rows, one of them claiming to be
   * uncatalogued while its product sat in the list above.
   *
   * Resolving here does not write `productId`: the row displays under the
   * product it plainly refers to, and the database still says the line is
   * unlinked until somebody links it deliberately. Only an *active* product
   * resolves — a retired one cannot take part in inventory, so a line naming
   * it stays free text and visible rather than being folded into something
   * nobody can allocate against.
   */
  const linkedKey = (id: string): string => `product:${id}`;
  const nameKey = (name: string): string => `name:${name}`;

  // The catalogue is already loaded above, so indexing it costs no query.
  const byNormalized = resolver.indexByNormalizedName(products);
  const resolveKey = (productId: string | null, productName: string): string => {
    if (productId) return linkedKey(productId);
    const match = byNormalized.get(normalizeProductName(productName));
    return match && match.isActive ? linkedKey(match.id) : nameKey(productName);
  };

  /*
    Both columns describe the same thing: demand that is still open.

    Allocated used to sum every allocation on every open order line, including
    lines already met in full. A product with three orders — 5 delivered, 1 of
    5 delivered, 4 delivered — reported Required 4 beside Allocated 10, and the
    10 was unreachable: nine of those units belong to orders nobody is waiting
    on. Read together the row implied stock was covered when four units still
    had to be bought.

    A line with nothing pending therefore contributes to neither. Its
    allocations are untouched and still appear against the order in Sales
    History; they simply stop counting as procurement someone can still plan
    around.
  */
  const required = new Map<string, number>();
  const allocated = new Map<string, number>();
  for (const line of lines) {
    const key = resolveKey(line.productId, line.productName);
    const lineAllocated = allocatedQty(line.allocations);
    const outstanding = pendingQty(line.quantity, line.alreadyFulfilled, lineAllocated);
    required.set(key, (required.get(key) ?? 0) + outstanding);
    if (outstanding > 0) {
      allocated.set(key, (allocated.get(key) ?? 0) + lineAllocated);
    }
  }

  const standing = new Map<string, number>();
  for (const item of billItems) {
    if (!item.productId) continue;
    const key = linkedKey(item.productId);
    standing.set(key, (standing.get(key) ?? 0) + standingQty(item.receivedQty, item.allocations));
  }
  for (const item of unlinkedBillItems) {
    const key = resolveKey(null, item.productName);
    standing.set(key, (standing.get(key) ?? 0) + standingQty(item.receivedQty, item.allocations));
  }

  // Catalogue-backed rows, exactly as before.
  const catalogueRows = products.map((product): ShortageRow => {
    const view = toProductView(product);
    const key = linkedKey(product.id);
    const totalRequired = required.get(key) ?? 0;
    return {
      productName: view.name,
      product: view,
      linked: true,
      // Already net of everything fulfilled, so the shortage *is* the
      // outstanding demand. Subtracting onHand again would double-count
      // shared stock against individual customers, and subtracting
      // allocations again would remove them twice.
      totalRequired,
      totalAllocated: allocated.get(key) ?? 0,
      onHand: view.onHand,
      shortageQty: totalRequired,
      standingQty: standing.get(key) ?? 0,
    };
  });

  /**
   * Free-text rows, for demand with no catalogue entry.
   *
   * onHand is 0 rather than unknown: there is no InventoryItem to read, and
   * reporting a guess would be worse than reporting nothing. `linked: false`
   * is what tells the reader why, and that the row needs mapping before it can
   * take part in inventory operations.
   */
  const unresolved = (productName: string): boolean => {
    const match = byNormalized.get(normalizeProductName(productName));
    return !match || !match.isActive;
  };

  const freeTextNames = new Set<string>();
  for (const line of lines) {
    if (!line.productId && unresolved(line.productName)) freeTextNames.add(line.productName);
  }
  for (const item of unlinkedBillItems) {
    if (unresolved(item.productName)) freeTextNames.add(item.productName);
  }

  const freeTextRows = [...freeTextNames].map((name): ShortageRow => {
    const key = nameKey(name);
    const totalRequired = required.get(key) ?? 0;
    return {
      productName: name,
      product: null,
      linked: false,
      totalRequired,
      totalAllocated: allocated.get(key) ?? 0,
      onHand: 0,
      shortageQty: totalRequired,
      standingQty: standing.get(key) ?? 0,
    };
  });

  return [...catalogueRows, ...freeTextRows]
    .filter((row) => row.totalRequired > 0 || row.standingQty > 0)
        // Biggest gap first; then by name, which every row has whether or not it
    // is catalogued.
    .sort((a, b) => b.shortageQty - a.shortageQty || a.productName.localeCompare(b.productName));
}

// ---------------------------------------------------------------------------
//  Allocation
// ---------------------------------------------------------------------------

/**
 * Assigns received stock to an order line.
 *
 * Both rows are locked before either quantity is read, always in the same
 * order — bill item, then order line — so concurrent allocations queue instead
 * of deadlocking or double-spending. Two checks then have to pass:
 *
 *   1. the bill line has that much standing stock, and
 *   2. the order line still needs that much.
 *
 * Reading either without the lock is what would let two requests each see the
 * same four units and both write.
 */
export async function createAllocation(
  req: Request,
  actor: AuthenticatedUser,
  billId: string,
  itemId: string,
  input: CreateAllocationInput,
): Promise<PurchaseBillDetail> {
  await prisma.$transaction(async (tx) => {
    await repo.lockBillItem(tx, itemId);
    await repo.lockOrderLine(tx, input.salesOrderItemId);

    const item = await repo.findBillItem(tx, itemId);
    if (!item || item.billId !== billId) throw itemNotFound();

    const line = await repo.findOrderLine(tx, input.salesOrderItemId);
    if (!line) {
      throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
    }

    // Symmetric to the order-line rule below: stock whose product is unknown
    // cannot be matched to a requirement either. Recording a bill needs no
    // catalogue decision; spending what it delivered does.
    if (!item.productId) {
      throw AppError.badRequest(
        'PURCHASE_LINE_NOT_LINKED',
        'That purchase line is not linked to a catalogue product yet. Link it before allocating.',
      );
    }

    // A line with no catalogue entry cannot be matched to purchased stock:
    // there is no product identity to reconcile the two sides against.
    if (!line.productId) {
      throw AppError.badRequest(
        'ORDER_LINE_NOT_LINKED',
        'That order line has no catalogue product, so stock cannot be allocated to it.',
      );
    }

    if (line.productId !== item.productId) {
      throw AppError.badRequest(
        'PRODUCT_MISMATCH',
        'That purchase line is for a different product than the order line.',
      );
    }

    if (line.status !== 'ACTIVE') {
      throw AppError.conflict('ORDER_LINE_NOT_ACTIVE', 'That order line is not active.');
    }

    const alreadyAllocated = allocatedQty(line.allocations);
    // Warehouse stock plays no part: it is shared across every order for the
    // product, so counting it here would let one shelf satisfy many customers.
    const pending = pendingQty(line.quantity, line.alreadyFulfilled, alreadyAllocated);

    // The freeze rule, checked under the lock rather than from the projection.
    if (isFrozen(pending) && !canModifyAllocation({ id: actor.id, role: actor.role }, true)) {
      throw AppError.forbidden(
        'That order line is already fully fulfilled. Only an administrator can change it.',
      );
    }

    if (input.quantity > pending) {
      throw AppError.badRequest(
        'EXCEEDS_PENDING',
        `That order line needs only ${pending} more unit(s).`,
      );
    }

    const available = standingQty(item.receivedQty, item.allocations);
    if (input.quantity > available) {
      throw AppError.badRequest(
        'EXCEEDS_STANDING',
        `Only ${available} unit(s) of this purchase line are unallocated.`,
      );
    }

    // The unique index on (billItem, orderLine) means a second allocation to
    // the same line is an edit; adding the quantity keeps the two consistent.
    const existing = item.allocations.find((a) => a.salesOrderItemId === input.salesOrderItemId);
    if (existing) {
      await tx.purchaseAllocation.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity + input.quantity },
      });
    } else {
      await tx.purchaseAllocation.create({
        data: {
          purchaseBillItemId: itemId,
          salesOrderItemId: input.salesOrderItemId,
          quantity: input.quantity,
          allocatedById: actor.id,
        },
      });
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.allocation.created',
    entityType: 'PurchaseBillItem',
    entityId: itemId,
    actorId: actor.id,
    newValue: { salesOrderItemId: input.salesOrderItemId, quantity: input.quantity },
  });

  return getBill(billId);
}

/**
 * Changes or releases an allocation.
 *
 * Zero releases it entirely. The freeze rule is evaluated against the line as
 * it stands *without* this allocation, so an administrator can still correct a
 * line that only looks fulfilled because of the row being edited.
 */
export async function updateAllocation(
  req: Request,
  actor: AuthenticatedUser,
  billId: string,
  itemId: string,
  allocationId: string,
  input: UpdateAllocationInput,
): Promise<PurchaseBillDetail> {
  await prisma.$transaction(async (tx) => {
    await repo.lockBillItem(tx, itemId);

    const allocation = await repo.findAllocation(tx, allocationId);
    if (!allocation || allocation.purchaseBillItemId !== itemId) throw allocationNotFound();

    await repo.lockOrderLine(tx, allocation.salesOrderItemId);

    const item = await repo.findBillItem(tx, itemId);
    if (!item || item.billId !== billId) throw itemNotFound();

    const line = await repo.findOrderLine(tx, allocation.salesOrderItemId);
    if (!line) {
      throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
    }

    // An allocation can only exist on a linked line — creating one requires it
    // — so this is a guard against corruption rather than an expected path.
    if (!item.productId) {
      throw AppError.conflict(
        'PURCHASE_LINE_NOT_LINKED',
        'That purchase line is not linked to a catalogue product.',
      );
    }
    const fulfilled = isFrozen(
      pendingQty(line.quantity, line.alreadyFulfilled, allocatedQty(line.allocations)),
    );

    if (fulfilled && !canModifyAllocation({ id: actor.id, role: actor.role }, true)) {
      throw AppError.forbidden(
        'That order line is already fully fulfilled. Only an administrator can change it.',
      );
    }

    if (input.quantity === 0) {
      await tx.purchaseAllocation.delete({ where: { id: allocationId } });
      return;
    }

    // Headroom excludes this allocation's own current quantity, so raising it
    // is measured against what the line needs beyond what it already has here.
    const otherAllocations = line.allocations.filter((a) => a.id !== allocationId);
    const pendingWithoutThis = pendingQty(
      line.quantity,
      line.alreadyFulfilled,
      allocatedQty(otherAllocations),
    );
    if (input.quantity > pendingWithoutThis) {
      throw AppError.badRequest(
        'EXCEEDS_PENDING',
        `That order line can take at most ${pendingWithoutThis} unit(s) from this purchase.`,
      );
    }

    const otherOnItem = item.allocations.filter((a) => a.id !== allocationId);
    const availableWithoutThis = standingQty(item.receivedQty, otherOnItem);
    if (input.quantity > availableWithoutThis) {
      throw AppError.badRequest(
        'EXCEEDS_STANDING',
        `Only ${availableWithoutThis} unit(s) of this purchase line are available.`,
      );
    }

    await tx.purchaseAllocation.update({
      where: { id: allocationId },
      data: { quantity: input.quantity },
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: input.quantity === 0 ? 'procurement.allocation.released' : 'procurement.allocation.updated',
    entityType: 'PurchaseAllocation',
    entityId: allocationId,
    actorId: actor.id,
    newValue: { quantity: input.quantity },
  });

  return getBill(billId);
}

/**
 * Attaches an existing order line to a catalogue product.
 *
 * For lines written before the Product master existed, or typed as free text
 * because nothing in the catalogue fitted at the time. Without this, such a
 * line can never receive purchased stock: allocation matches on product
 * identity, and the line has none.
 *
 * Only `productId` is written. The line's name, quantity, price and status are
 * the order's record of what was agreed with a customer, and attaching a
 * catalogue entry is not a licence to edit any of them.
 *
 * Raw SQL rather than the ORM, deliberately: `sales_order_money_guard` is a
 * deferred constraint trigger that re-checks the parent order's payment
 * invariants on any write to one of its lines. One historical order predates
 * that rule and can never satisfy it, so a Prisma update — which rewrites the
 * whole row — fails there on a payment rule that has nothing to do with
 * linking. Setting the single column keeps the write as narrow as the change
 * actually is. If the guard still refuses, the error is surfaced rather than
 * worked around: that order's history stays exactly as recorded.
 */
/**
 * Put a free-text order line's product into the catalogue, then link the line
 * to it.
 *
 * "Put in catalogue" is not "create a product": a logical product belongs in
 * Product Master once, so this resolves to whatever already represents it and
 * only creates when nothing does. The folded name decides that, so a line
 * reading "kansa dinner set" finds the "Kansa Dinner Set" someone catalogued
 * last week instead of splitting its stock in two.
 *
 * Race safety comes from the unique index on normalizedName, never from the
 * lookup below. Two clicks arriving together both see nothing, both insert,
 * and Postgres rejects the loser with P2002 — which is not an error to report
 * but the answer itself: the row the winner created is the row to use. That is
 * why the catch re-reads rather than surfacing a duplicate-product failure.
 *
 * An inactive match stops the operation. Reviving a retired product, or
 * creating a rival beside it, are both decisions for a person; the conflict
 * names the product so they can make it.
 */
export async function putInCatalogue(
  req: Request,
  actorId: string,
  input: PutInCatalogueInput,
): Promise<OrderRequirementView> {
  const line = await prisma.salesOrderItem.findUnique({
    where: { id: input.salesOrderItemId },
    select: { id: true, productId: true, productName: true },
  });
  if (!line) {
    throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
  }
  if (line.productId) {
    throw AppError.conflict(
      'ORDER_LINE_ALREADY_LINKED',
      'That order line is already linked to a catalogue product.',
    );
  }

  // The line's own wording is the name, so the catalogue records what the
  // order actually says rather than a re-typed variant of it.
  const name = line.productName.trim();
  const normalizedName = normalizeProductName(name);
  if (normalizedName === '') {
    throw AppError.badRequest(
      'PRODUCT_NAME_REQUIRED',
      'That order line has no product name to catalogue.',
    );
  }

  const reuseOrFail = (product: { id: string; name: string; isActive: boolean }): string => {
    if (!product.isActive) {
      throw AppError.conflict(
        'PRODUCT_EXISTS_INACTIVE',
        `“${product.name}” is already in the catalogue but is inactive. Reactivate it before linking.`,
      );
    }
    return product.id;
  };

  const existing = await repo.findProductByNormalizedName(normalizedName);
  let productId: string;

  if (existing) {
    productId = reuseOrFail(existing);
  } else {
    try {
      const created = await prisma.product.create({
        data: {
          name,
          normalizedName,
          inventory: { create: { onHand: 0 } },
        },
        select: { id: true },
      });
      productId = created.id;

      await recordAudit(req, {
        action: 'procurement.product.created',
        entityType: 'Product',
        entityId: created.id,
        actorId,
        newValue: { name, normalizedName, onHand: 0, via: 'putInCatalogue' },
      });
    } catch (error) {
      // P2002: another request catalogued the same logical product first.
      // Its row is the right answer, so read it back instead of failing.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await repo.findProductByNormalizedName(normalizedName);
        if (!raced) throw error;
        productId = reuseOrFail(raced);
      } else {
        throw error;
      }
    }
  }

  // Linking runs through the existing path, so every guard it enforces —
  // already-linked, inactive product, the payment-guard mapping — applies here
  // unchanged rather than being restated.
  return linkOrderLine(req, actorId, { salesOrderItemId: line.id, productId });
}

export async function linkOrderLine(
  req: Request,
  actorId: string,
  input: LinkOrderLineInput,
): Promise<OrderRequirementView> {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, isActive: true, name: true },
  });
  if (!product) throw productNotFound();
  if (!product.isActive) {
    throw AppError.badRequest(
      'PRODUCT_INACTIVE',
      'That product is no longer active and cannot be linked.',
    );
  }

  const line = await prisma.salesOrderItem.findUnique({
    where: { id: input.salesOrderItemId },
    select: { id: true, productId: true, productName: true, order: { select: { orderId: true } } },
  });
  if (!line) {
    throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
  }

  // Relinking an already-linked line would move stock between requirements
  // without any of allocation's checks running. Unlink by releasing the
  // allocations first if that is genuinely wanted.
  if (line.productId) {
    throw AppError.conflict(
      'ORDER_LINE_ALREADY_LINKED',
      'That order line is already linked to a catalogue product.',
    );
  }

  try {
    await prisma.$executeRaw`
      UPDATE "SalesOrderItem" SET "productId" = ${product.id}
      WHERE "id" = ${line.id} AND "productId" IS NULL`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('sales_closed_fully_paid') || message.includes('sales_paid_within_total')) {
      throw AppError.conflict(
        'ORDER_PAYMENT_GUARD',
        'That order’s payment record predates the settlement rule, so its lines cannot be modified. Correct the order first.',
      );
    }
    throw error;
  }

  await recordAudit(req, {
    action: 'procurement.orderLine.linked',
    entityType: 'SalesOrderItem',
    entityId: line.id,
    actorId,
    newValue: { productId: product.id, productName: product.name, lineName: line.productName },
  });

  return getOrderRequirements(line.order.orderId);
}

/**
 * Attaches a purchase line to a catalogue product.
 *
 * The counterpart of linkOrderLine, for the other side of the match. A bill is
 * recorded in the vendor's own words; this is where those words are reconciled
 * with a catalogue entry, which is what allocation needs. Only productId is
 * written — the vendor's description, quantities and rate are the record of the
 * document and stay exactly as entered.
 */
export async function linkPurchaseItem(
  req: Request,
  actorId: string,
  billId: string,
  itemId: string,
  input: LinkPurchaseItemInput,
): Promise<PurchaseBillDetail> {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, isActive: true, name: true },
  });
  if (!product) throw productNotFound();
  if (!product.isActive) {
    throw AppError.badRequest(
      'PRODUCT_INACTIVE',
      'That product is no longer active and cannot be linked.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await repo.lockBillItem(tx, itemId);

    const item = await repo.findBillItem(tx, itemId);
    if (!item || item.billId !== billId) throw itemNotFound();

    // Relinking would move already-allocated stock between products without
    // any of allocation's checks running. Release the allocations first.
    if (item.productId) {
      if (item.allocations.length > 0) {
        throw AppError.conflict(
          'PURCHASE_LINE_HAS_ALLOCATIONS',
          'Release this line’s allocations before changing its product.',
        );
      }
      if (item.productId !== product.id) {
        throw AppError.conflict(
          'PURCHASE_LINE_ALREADY_LINKED',
          'That purchase line is already linked to a catalogue product.',
        );
      }
    }

    await tx.purchaseBillItem.update({
      where: { id: itemId },
      data: { productId: product.id },
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.purchaseItem.linked',
    entityType: 'PurchaseBillItem',
    entityId: itemId,
    actorId,
    newValue: { productId: product.id, productName: product.name },
  });

  return getBill(billId);
}

/**
 * The SALES board: outstanding customer demand, line by line.
 *
 * Deliberately flat rather than grouped by order — procurement's question is
 * "what is still owed and to whom", and answering it should not require
 * opening each order in turn.
 *
 * Every figure is derived here from the two stored quantities. There is no
 * cached total to drift: allocate stock and the numbers move, because they are
 * recomputed from the allocation rows each time.
 */
export async function getSalesRequirements(
  query: SalesRequirementQuery = {},
): Promise<SalesRequirementRow[]> {
  const lines = await repo.findSalesRequirements();

  /*
    One batched lookup for every line, not one per line. The dates come from
    the audit trail and the allocation ledger, so a line that was never
    supplied against simply has no entry — and reports `fulfilledOn: null`
    rather than borrowing a date from the order.
  */
  const fulfilledAt = await repo.findFulfillmentEvents(lines.map((l) => l.id));

  const rows = lines.map((line): SalesRequirementRow => {
    const procurementFulfilled = allocatedQty(line.allocations);
    const fulfilled = totalFulfilled(line.alreadyFulfilled, procurementFulfilled);
    const unfulfilled = pendingQty(line.quantity, line.alreadyFulfilled, procurementFulfilled);

    return {
      salesOrderItemId: line.id,
      orderId: line.order.id,
      orderNumber: line.order.orderId,
      customerName: line.order.customer.name,
      productName: line.productName,
      productId: line.productId,
      linked: line.productId !== null,
      requiredQty: line.quantity,
      alreadyFulfilled: line.alreadyFulfilled,
      procurementFulfilled,
      totalFulfilled: fulfilled,
      unfulfilledQty: unfulfilled,
      status: fulfillmentStatus(line.quantity, unfulfilled),
      fulfilledOn: (() => {
        const at = fulfilledAt.get(line.id);
        return at ? istDay(at) : null;
      })(),
    };
  });

  /*
    Filtering happens here rather than in the database: the date is derived
    from two tables that the requirement query does not join, and comparing
    the already-computed IST day is both simpler and exactly consistent with
    what the row reports. A line with no fulfilment date can never match a
    day, so it drops out on its own.
  */
  if (!query.date) return rows;
  return rows.filter((row) => row.fulfilledOn === query.date);
}

/**
 * Records fulfilment that happened outside procurement.
 *
 * Only `alreadyFulfilled` is written. Procurement's own contribution is the sum
 * of the line's allocations and is never folded in here — one total, computed
 * from two independent sources, is what keeps them from disagreeing.
 *
 * The combined figure cannot exceed the requirement: allocations have already
 * been committed against this line, so allowing it would claim more was
 * supplied than was ever ordered.
 *
 * Raw SQL for the same reason the linking endpoints use it —
 * `sales_order_money_guard` re-checks payment invariants on any write to a
 * line, and one historical order can never satisfy that rule. Writing the
 * single column keeps the statement as narrow as the change.
 */
export async function recordFulfillment(
  req: Request,
  actorId: string,
  salesOrderItemId: string,
  input: RecordFulfillmentInput,
): Promise<SalesRequirementRow[]> {
  await prisma.$transaction(async (tx) => {
    await repo.lockOrderLine(tx, salesOrderItemId);

    const line = await repo.findLineForFulfillment(tx, salesOrderItemId);
    if (!line) {
      throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
    }

    const allocated = allocatedQty(line.allocations);
    if (input.alreadyFulfilled + allocated > line.quantity) {
      throw AppError.badRequest(
        'EXCEEDS_REQUIREMENT',
        `That would record ${input.alreadyFulfilled + allocated} fulfilled against a requirement of ${line.quantity}. ` +
          `${allocated} unit(s) are already allocated through procurement.`,
      );
    }

    try {
      await tx.$executeRaw`
        UPDATE "SalesOrderItem" SET "alreadyFulfilled" = ${input.alreadyFulfilled}
        WHERE "id" = ${salesOrderItemId}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('sales_closed_fully_paid') || message.includes('sales_paid_within_total')) {
        throw AppError.conflict(
          'ORDER_PAYMENT_GUARD',
          'That order’s payment record predates the settlement rule, so its lines cannot be modified.',
        );
      }
      throw error;
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.fulfillment.recorded',
    entityType: 'SalesOrderItem',
    entityId: salesOrderItemId,
    actorId,
    newValue: { alreadyFulfilled: input.alreadyFulfilled },
  });

  return getSalesRequirements();
}
