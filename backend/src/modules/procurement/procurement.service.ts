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
  AllocationView,
  BillApprovalStatus,
  CreateAllocationInput,
  CreatePurchaseBillInput,
  LinkOrderLineInput,
  MapPurchaseItemInput,
  OrderRequirementView,
  PurchaseBillDetail,
  PurchaseBillItemView,
  PurchaseBillListQuery,
  PurchaseBillSummary,
  ProductChangeListQuery,
  ProductChangeView,
  RecordFulfillmentInput,
  RequestProductChangeInput,
  ReviewProductChangeInput,
  ReviewPurchaseBillInput,
  RsProductRef,
  SalesRequirementQuery,
  SalesFulfillmentDetail,
  FulfillmentSource,
  FulfillmentEvent,
  SalesRequirementRow,
  PurchaseDelayInput,
  ReceiveItemInput,
  ShortageRow,
  UpdateAllocationInput,
  UpdatePurchaseBillInput,
} from '@rs/shared';
import { addAmount, lineTotal } from '@rs/shared';
import { prisma } from '../../config/database.js';
import { crmStockOf, rsStockOf } from '../rs-product/rs-product.mapper.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { resolvePermission } from '../../services/permission.service.js';
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

/** Neon is a network hop away; the same budget the enquiry module uses. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/**
 * Also what a ShopifyVariant id gets.
 *
 * Variant ids and product ids are both cuids, so a variant id is a
 * well-formed value that simply names no RsProduct — and the lookup that
 * rejects it is the same one that rejects a deleted product. Procurement has no
 * variant concept to give a more specific answer with, and inventing one would
 * imply variants are a thing it maps to.
 */
const rsProductNotFound = (): AppError =>
  AppError.notFound('RS_PRODUCT_NOT_FOUND', 'That RS Product could not be found.');
const billNotFound = (): AppError =>
  AppError.notFound('PURCHASE_BILL_NOT_FOUND', 'That purchase bill could not be found.');
const itemNotFound = (): AppError =>
  AppError.notFound('PURCHASE_ITEM_NOT_FOUND', 'That purchase line could not be found.');
const allocationNotFound = (): AppError =>
  AppError.notFound('ALLOCATION_NOT_FOUND', 'That allocation could not be found.');

// ---------------------------------------------------------------------------
//  Projections
// ---------------------------------------------------------------------------

type RsProductRow = {
  id: string;
  title: string;
  variants: { sku: string | null; crmStockQty: number; inventoryQty: number }[];
  images: { url: string }[];
};

/**
 * An RS Product as Procurement states it: one product, one SKU, two numbers.
 *
 * The variants are folded away here and never travel further. Both stock
 * figures come from the RS Products module's own helpers rather than sums
 * written out again, so what Procurement displays is by construction what the
 * RS Products catalogue displays — not a second opinion about the same stock.
 *
 * TWO figures, and they are not interchangeable:
 *
 *   crmStockQty  ← crmStockOf(variants)  ← ShopifyVariant.crmStockQty
 *                  CRM Stock: counted by hand, never touched by a sync.
 *   rsStockQty   ← rsStockOf(variants)   ← ShopifyVariant.inventoryQty
 *                  RS Product Stock: Shopify's sellable count, overwritten by
 *                  every sync pass and every inventory webhook.
 *
 * They are carried separately all the way to the screen, under separate labels,
 * because they answer different questions and routinely disagree. Neither is
 * ever computed from the other, and neither stands in for the other.
 *
 * The SKU is the first variant's, matching how `RsProductListRow` picks one.
 * It is shown so a person can recognise the product; nothing identifies by it.
 */
function toRsProductRef(row: RsProductRow): RsProductRef {
  return {
    id: row.id,
    title: row.title,
    sku: row.variants[0]?.sku ?? null,
    imageUrl: row.images[0]?.url ?? null,
    crmStockQty: crmStockOf(row.variants),
    rsStockQty: rsStockOf(row.variants),
  };
}

/** One re-mapping request as the API states it. */
type ProductChangeRow = Awaited<ReturnType<typeof repo.findProductChanges>>[number];

function toProductChangeView(row: ProductChangeRow): ProductChangeView {
  return {
    id: row.id,
    billId: row.billId,
    billNumber: row.bill.billNumber,
    itemId: row.itemId,
    productName: row.item.productName,
    fromRsProduct: toRsProductRef(row.fromRsProduct),
    toRsProduct: toRsProductRef(row.toRsProduct),
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    allocatedQty: allocatedQty(row.item.allocations),
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
    rsProduct: item.rsProduct ? toRsProductRef(item.rsProduct) : null,
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
    /*
      A pending request changes nothing, so `rsProduct` above is still the live
      mapping. This is carried beside it so the line can say it is awaiting a
      decision — never instead of it, which would show a proposed product as
      though it had already been applied.
    */
    pendingProductChange: item.productChanges[0]
      ? toProductChangeView(item.productChanges[0])
      : null,
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
    approvalStatus: row.approvalStatus,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
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
    approvalStatus: detail.approvalStatus,
    reviewedBy: detail.reviewedBy,
    reviewedAt: detail.reviewedAt,
    reviewNote: detail.reviewNote,
    billDate: detail.billDate,
    expectedBy: detail.expectedBy,
    isDelayed: detail.isDelayed,
    itemCount: detail.items.length,
    billTotal: detail.billTotal,
    totalStandingQty: detail.totalStandingQty,
    createdAt: detail.createdAt,
  };
}

/*
 * Every legacy catalogue operation this module had is gone: listing products,
 * creating one, editing one, and correcting stock by hand.
 *
 * Procurement maintains neither a catalogue nor a stock figure of its own. RS
 * Products is the catalogue, and a product that is not in it is created there.
 * `adjustInventory` was the only writer of InventoryItem.onHand, and a second
 * hand-maintained stock number beside RS Products' own is precisely what this
 * migration set out to remove.
 *
 * `listProducts` went too. It survived one phase longer because allocation
 * reconciled a purchase line against a SalesOrderItem by legacy Product
 * identity, and an order line written as free text needed a legacy entry to be
 * linked to. Both sides name an RsProduct now, so there is nothing to list.
 */

// ---------------------------------------------------------------------------
//  Purchase bills
// ---------------------------------------------------------------------------

export async function listBills(
  query: PurchaseBillListQuery,
): Promise<{ bills: PurchaseBillSummary[]; nextCursor: string | null }> {
  const where: Prisma.PurchaseBillWhereInput = {
    ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.approvalStatus ? { approvalStatus: query.approvalStatus } : {}),
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

  /*
    The RS Products mapping, validated before anything is written.

    Every id must name a real RsProduct. A ShopifyVariant id is a well-formed
    cuid that names none, so it is refused here rather than stored — which is
    the whole guarantee that no variant identity can reach this column.

    Lines that name nothing are free text by design and are mapped later, from
    the bill. Nothing is inferred from the vendor's wording or from a SKU.
  */
  const rsProductIds = [
    ...new Set(input.items.map((i) => i.rsProductId).filter((v): v is string => Boolean(v))),
  ];
  const titles = new Map<string, string>();
  if (rsProductIds.length > 0) {
    const found = await prisma.rsProduct.findMany({
      where: { id: { in: rsProductIds } },
      select: { id: true, title: true },
    });
    if (found.length !== rsProductIds.length) {
      throw AppError.badRequest(
        'RS_PRODUCT_NOT_FOUND',
        'One of those RS Products could not be found.',
      );
    }
    for (const p of found) titles.set(p.id, p.title);
  }

  /*
    What each line is called, now that nobody types it.

    The UI has no free-text product-name field any more, so an ordinary new bill
    arrives carrying only `rsProductId` per line, and the description comes from
    the catalogue entry the person actually picked. A caller that does send
    `productName` — a historical import, or a line being recorded from a
    document before its product exists in RS Products — keeps its own wording
    verbatim; the column is the record of the paper and this never overwrites it.

    Nothing is inferred in either direction: a title is only ever taken from a
    product somebody deliberately selected, and a typed name is never matched
    against the catalogue to find one.
  */
  const nameFor = (item: (typeof input.items)[number]): string => {
    const name = item.productName ?? (item.rsProductId ? titles.get(item.rsProductId) : undefined);
    if (!name) {
      // Unreachable through the schema, which refuses a line carrying neither.
      // Kept so a future caller cannot create a line that describes nothing.
      throw AppError.badRequest(
        'PRODUCT_NAME_REQUIRED',
        'Every line needs an RS Product or a product name.',
      );
    }
    return name;
  };

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
            productName: nameFor(item),
            rsProductId: item.rsProductId ?? null,
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
    newValue: {
      billNumber: input.billNumber,
      vendorId: input.vendorId,
      lines: input.items.length,
      rsMapped: input.items.filter((i) => i.rsProductId).length,
    },
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

    /*
      A further receipt credits only the NEW units.

      The target is recomputed from the new receivedQty and the delta taken
      against what this line already stands for, so receiving 5 and later 2 more
      adds 4 then 2 — never 5 then 7. On a pending bill the target stays zero and
      this does nothing, which is the rule that receiving an unapproved bill
      moves no stock.
    */
    await reconcileLineStock(tx, itemId);
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

// ---------------------------------------------------------------------------
//  CRM stock
// ---------------------------------------------------------------------------

/**
 * Brings one purchase line's contribution to CRM stock up to date.
 *
 * THE SINGLE STOCK MUTATION POINT. Every event that could change what a line
 * stands for — approving the bill, receiving more goods, allocating, releasing
 * an allocation, mapping the line to a product — ends by calling this, and
 * nothing else in Procurement writes `crmStockQty` at all. One function means
 * the rule is stated once and cannot be phrased differently in two places.
 *
 * The rule:
 *
 *     target = approved && mapped ? receivedQty − Σ allocations : 0
 *     delta  = target − stockedQty
 *
 * `target` is the business rule directly: only an approved bill contributes,
 * and only its SURPLUS — the received goods not already committed to a customer
 * requirement. Received 5 against a requirement of 1 contributes 4.
 *
 * `delta` is what makes it safe. Because every call recomputes the target from
 * the ledger and moves stock by the difference, the operation is idempotent:
 *
 *   - a repeated or retried request computes delta 0 and moves nothing;
 *   - a further receipt credits only the new units, never the cumulative total;
 *   - releasing an allocation restores exactly what it consumed, exactly once;
 *   - a rejected or pending bill has target 0, so it contributes nothing, and a
 *     bill that somehow held stock would give it back rather than keep it.
 *
 * It also cannot strand stock: a line only ever removes what it itself added,
 * so procurement can never push a product below the count someone maintained by
 * hand in RS Products.
 *
 * MUST be called with the line's row already locked by the caller — every call
 * site takes `lockBillItem` first — because the target is read and the stocked
 * figure written as a pair, and two concurrent allocations against one line
 * would otherwise both compute from the same stale total.
 *
 * Exported solely so test fixtures that approve a bill directly can run the
 * same reconciliation the service runs, rather than restating this arithmetic
 * in a helper where it could silently drift from the rule it is meant to mirror.
 */
export async function reconcileLineStock(
  tx: Prisma.TransactionClient,
  itemId: string,
): Promise<void> {
  const line = await repo.findLineForStock(tx, itemId);
  if (!line) return;

  /*
    An unmapped line names no product, so there is nowhere to put its goods —
    it holds no stock and its target is zero. The same is true of a bill that is
    pending or rejected: neither contributes until somebody approves it.
  */
  const eligible = line.bill.approvalStatus === 'APPROVED' && line.rsProductId !== null;
  const target = eligible
    ? Math.max(0, line.receivedQty - allocatedQty(line.allocations))
    : 0;

  const delta = target - line.stockedQty;
  if (delta === 0) return;

  /*
    Which product the movement belongs to.

    When a line is being un-stocked because it lost its mapping, the stock has
    to come off the product it was credited to, which is no longer the line's
    own. Callers that move a mapping therefore reconcile to zero BEFORE the
    change and reconcile again after, so this only ever sees a line whose
    current product is the right one.
  */
  if (!line.rsProductId) {
    // Nothing to credit against and nothing previously credited, since an
    // unmapped line can never have been eligible. Record the target and stop.
    await tx.purchaseBillItem.update({ where: { id: itemId }, data: { stockedQty: target } });
    return;
  }

  const variantId = await repo.firstVariantId(tx, line.rsProductId);
  if (!variantId) {
    /*
      A product with no variant has nowhere to hold a count — `crmStockQty` is a
      variant column and the product figure is the sum across variants. Refused
      loudly rather than silently dropping the goods, which would leave the
      bill claiming stock the catalogue does not have. No such product exists in
      the catalogue today; Shopify always sends at least one variant.
    */
    throw AppError.conflict(
      'RS_PRODUCT_HAS_NO_VARIANT',
      'That RS Product has no variant to hold stock against. Add one in RS Products first.',
    );
  }

  await repo.moveCrmStock(tx, variantId, delta);
  await tx.purchaseBillItem.update({ where: { id: itemId }, data: { stockedQty: target } });
}

/**
 * Takes a line's contribution back off the product it is currently credited to.
 *
 * Needed only when a line's mapping is about to move. `reconcileLineStock`
 * always works against the line's *current* product, so changing `rsProductId`
 * first would credit the new product while leaving the old one holding stock
 * nobody can account for. Releasing first and reconciling after keeps every
 * movement attached to the product it actually belongs to.
 */
async function releaseLineStock(tx: Prisma.TransactionClient, itemId: string): Promise<void> {
  const line = await repo.findLineForStock(tx, itemId);
  if (!line || line.stockedQty === 0) return;

  if (line.rsProductId) {
    const variantId = await repo.firstVariantId(tx, line.rsProductId);
    if (variantId) await repo.moveCrmStock(tx, variantId, -line.stockedQty);
  }

  await tx.purchaseBillItem.update({ where: { id: itemId }, data: { stockedQty: 0 } });
}

// ---------------------------------------------------------------------------
//  Bill approval
// ---------------------------------------------------------------------------

/**
 * Refuses to spend a bill that has not been signed off.
 *
 * One function, called from every place a bill's stock would be committed, so
 * the rule reads the same at each site and a new allocation path cannot quietly
 * omit it by phrasing the check differently.
 *
 * REJECTED is refused with its own message rather than folded into PENDING:
 * "nobody has looked at this yet" and "somebody looked and said no" lead to
 * completely different next actions for the person reading the error.
 */
function assertBillApproved(status: BillApprovalStatus): void {
  if (status === 'APPROVED') return;

  if (status === 'REJECTED') {
    throw AppError.conflict(
      'BILL_REJECTED',
      'This purchase bill was rejected, so its stock cannot be allocated.',
    );
  }

  throw AppError.conflict(
    'BILL_NOT_APPROVED',
    'This purchase bill is waiting for approval. Its stock cannot be allocated until an administrator approves it.',
  );
}

/**
 * Decides a recorded bill, and records who decided.
 *
 * Mirrors the product-change review beside it rather than inventing a second
 * shape: ASSIGN resolved through the permission service, the decision taken
 * under a row lock, and re-validation inside that lock instead of trust in what
 * the route saw. Two reviewers racing therefore produce one decision and one
 * honest BILL_ALREADY_REVIEWED.
 *
 * Nobody signs off their own bill, whatever they hold. Holding approval rights
 * means being trusted to check other people's paperwork, not to wave through
 * your own — which is exactly the case the rule exists for.
 */
async function reviewBill(
  req: Request,
  actor: AuthenticatedUser,
  billId: string,
  decision: 'APPROVED' | 'REJECTED',
  input: ReviewPurchaseBillInput,
): Promise<PurchaseBillDetail> {
  /*
    Checked here as well as at the route. Neither layer is sufficient alone: a
    route is one registration away from losing its middleware, and this is the
    rule the whole feature exists to enforce.
  */
  if (!(await resolvePermission(actor.id, actor.role, 'PROCUREMENT', 'ASSIGN'))) {
    throw AppError.forbidden('Approving a purchase bill needs approval rights.');
  }

  await prisma.$transaction(async (tx) => {
    await repo.lockBill(tx, billId);

    const bill = await repo.findBillForReview(tx, billId);
    if (!bill) throw billNotFound();

    if (bill.createdById === actor.id) {
      throw new AppError(
        'SELF_APPROVAL_NOT_ALLOWED',
        403,
        'You cannot approve a purchase bill you recorded yourself. Someone else has to decide it.',
      );
    }

    if (bill.approvalStatus !== 'PENDING') {
      throw AppError.conflict(
        'BILL_ALREADY_REVIEWED',
        `That purchase bill has already been ${bill.approvalStatus.toLowerCase()}.`,
      );
    }

    await tx.purchaseBill.update({
      where: { id: billId },
      // Status, reviewer and moment written together, satisfying
      // bill_review_recorded_together and bill_decided_has_reviewer.
      data: {
        approvalStatus: decision,
        reviewedById: actor.id,
        reviewedAt: new Date(),
        ...(input.note ? { reviewNote: input.note } : {}),
      },
    });

    /*
      THE INBOUND STOCK POINT. Approval is where purchased goods become CRM
      stock, and only the surplus does — each line contributes what it received
      minus what is already committed to a requirement.

      Every line is locked before it is reconciled, so an allocation racing the
      approval queues behind it rather than computing its own target from a
      half-approved bill. The lock order is bill → line here and line → order
      line in allocation, and allocation never takes the bill lock, so the two
      cannot deadlock.

      A rejection runs this too, and deliberately: its target is zero, so the
      loop is a no-op on a bill that never held stock and gives the stock back
      on one that somehow did.
    */
    for (const line of await repo.findBillLineIds(tx, billId)) {
      await repo.lockBillItem(tx, line.id);
      await reconcileLineStock(tx, line.id);
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: decision === 'APPROVED' ? 'procurement.bill.approved' : 'procurement.bill.rejected',
    entityType: 'PurchaseBill',
    entityId: billId,
    actorId: actor.id,
    newValue: { decision, note: input.note ?? null },
  });

  return getBill(billId);
}

export function approveBill(
  req: Request,
  actor: AuthenticatedUser,
  billId: string,
  input: ReviewPurchaseBillInput,
): Promise<PurchaseBillDetail> {
  return reviewBill(req, actor, billId, 'APPROVED', input);
}

export function rejectBill(
  req: Request,
  actor: AuthenticatedUser,
  billId: string,
  input: ReviewPurchaseBillInput,
): Promise<PurchaseBillDetail> {
  return reviewBill(req, actor, billId, 'REJECTED', input);
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
        rsProductId: item.rsProductId,
        linked: item.rsProductId !== null,
        requiredQty: item.quantity,
        alreadyFulfilled: item.alreadyFulfilled,
        allocatedQty: allocated,
        totalFulfilled: totalFulfilled(item.alreadyFulfilled, allocated),
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
    rsProduct: line.rsProduct ? toRsProductRef(line.rsProduct) : null,
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
  const [lines, billItems] = await Promise.all([
    repo.findOpenRequirements(),
    repo.findBillItemsForShortages(),
  ]);

  /**
   * Rows are keyed two ways, and the prefixes keep them from colliding.
   *
   *   rs:<id>      demand or supply naming an RS Product
   *   name:<text>  free text, keyed by the exact string written on the line
   *
   * There used to be a third. Demand arrived keyed by the legacy Product and
   * supply by the RS one, so the board carried both and could not always join
   * them; and a free-text line was folded onto a catalogue entry by its
   * normalised name, which meant the board decided product identity by
   * spelling. Both are gone. One identity means demand and supply land on the
   * same key whenever they name the same product, and nothing else does.
   *
   * Two spellings of one product therefore stay two rows until somebody maps
   * them. That is the honest state: folding them would be an identity decision
   * taken from a string, and this board is read by people deciding what to buy.
   */
  const rsKey = (id: string): string => `rs:${id}`;
  const nameKey = (name: string): string => `name:${name}`;
  const keyFor = (rsProductId: string | null, productName: string): string =>
    rsProductId ? rsKey(rsProductId) : nameKey(productName);

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
  const names = new Map<string, string>();

  for (const line of lines) {
    const key = keyFor(line.rsProductId, line.productName);
    names.set(key, line.productName);
    const lineAllocated = allocatedQty(line.allocations);
    const outstanding = pendingQty(line.quantity, line.alreadyFulfilled, lineAllocated);
    required.set(key, (required.get(key) ?? 0) + outstanding);
    if (outstanding > 0) {
      allocated.set(key, (allocated.get(key) ?? 0) + lineAllocated);
    }
  }

  // Supply: received stock nobody has claimed yet, on the same keys.
  const standing = new Map<string, number>();
  for (const item of billItems) {
    const key = keyFor(item.rsProduct?.id ?? null, item.productName);
    if (!names.has(key)) names.set(key, item.productName);
    standing.set(key, (standing.get(key) ?? 0) + standingQty(item.receivedQty, item.allocations));
  }

  /*
    The board's spine: the RS Products that demand or supply actually names.

    Fetched by id rather than by scanning the catalogue. The old board loaded
    five hundred legacy products and rendered a row per catalogue entry; RS
    Products holds five hundred and two and will hold more, almost none of them
    on an open order, so a scan would be five hundred rows to show three.
  */
  const rsIds = [...new Set([...required.keys(), ...standing.keys()])]
    .filter((k) => k.startsWith('rs:'))
    .map((k) => k.slice(3));
  const rsProducts = new Map(
    (await repo.findRsProductsByIds(rsIds)).map((r) => [r.id, toRsProductRef(r)]),
  );

  const rows = [...new Set([...required.keys(), ...standing.keys()])].map((key): ShortageRow => {
    const rs = key.startsWith('rs:') ? rsProducts.get(key.slice(3)) ?? null : null;
    const totalRequired = required.get(key) ?? 0;
    return {
      // The product's title once it is mapped, else the wording on the line.
      productName: rs?.title ?? names.get(key) ?? '',
      rsProduct: rs,
      linked: rs !== null,
      sku: rs?.sku ?? null,
      // Already net of everything fulfilled, so the shortage *is* the
      // outstanding demand. Subtracting stock again would double-count a
      // figure shared across every order against individual customers, and
      // subtracting allocations again would remove them twice. Stock is
      // displayed beside the shortage for exactly that reason, never inside it.
      totalRequired,
      totalAllocated: allocated.get(key) ?? 0,
      /*
        The two stock figures, carried separately all the way to the screen.

        `crmStockQty` is the hand-maintained CRM count; `rsStockQty` is
        Shopify's sellable quantity. They are different numbers about the same
        goods and are never derived from, averaged with, or substituted for one
        another — this row previously reported the CRM figure under the name
        `rsStockQty`, which is precisely the conflation now undone.

        Null, not zero, on an unmapped row. "Nobody has said what these goods
        are, so there is no stock figure to state" and "there are none in
        stock" are different facts, and a zero would conflate them.
      */
      crmStockQty: rs?.crmStockQty ?? null,
      rsStockQty: rs?.rsStockQty ?? null,
      shortageQty: totalRequired,
      standingQty: standing.get(key) ?? 0,
    };
  });

  /*
    Which rows the board shows.

    Only products that actually need attention, rather than everything that has
    ever been demanded or delivered. A row earns its place when there is
    outstanding demand AND the CRM's own stock cannot cover it:

      totalRequired > 0  AND  (crmStockQty is null OR crmStockQty < totalRequired)

    CRM stock is the figure tested, not RS stock: it is the count this business
    maintains, while Shopify's is a number the storefront overwrites and can
    reflect goods reserved for online orders. An unmapped row — null stock —
    always qualifies, because nobody has said what the goods are and so nothing
    can be shown to cover them.

    This is a DISPLAY filter and nothing more. No formula above it changed:
    `shortageQty` is still `totalRequired`, allocations are still summed the
    same way, and standing is still reported beside them. A product whose CRM
    stock covers its outstanding demand simply stops occupying a line on a board
    whose purpose is to say what to buy.
  */
  return rows
    .filter(
      (row) =>
        row.totalRequired > 0 &&
        (row.crmStockQty === null || row.crmStockQty < row.totalRequired),
    )
    // Biggest gap first; then by name, which every row has whether or not it
    // is mapped.
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

    /*
      The approval gate, checked under the row lock the allocation already holds.

      Allocation is the moment a purchase stops being a recorded document and
      starts committing goods to a named customer, so it is the point sign-off
      protects. Everything before it — recording the bill, receiving against it,
      mapping its lines — stays open, because those record what happened rather
      than promising anything to anyone.
    */
    assertBillApproved(item.bill.approvalStatus);

    const line = await repo.findOrderLine(tx, input.salesOrderItemId);
    if (!line) {
      throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
    }

    /*
      One identity on both sides, compared directly.

      This used to compare legacy Product ids, which meant Sales and Procurement
      had to agree about a catalogue neither of them owned. Both now name an
      RsProduct, so the comparison is between two values of the same kind and
      needs no translation — and there is no bridge left to be missing.

      Never a name, a title, a SKU or a folded spelling. An allocation that
      drifts onto the wrong goods is silent corruption, and once its stock is
      spent it cannot be untangled.
    */
    if (!item.rsProductId) {
      throw AppError.badRequest(
        'PURCHASE_LINE_NOT_LINKED',
        'That purchase line is not mapped to an RS Product yet. Map it before allocating.',
      );
    }

    if (!line.rsProductId) {
      throw AppError.badRequest(
        'ORDER_LINE_NOT_LINKED',
        'That order line is not mapped to an RS Product, so stock cannot be allocated to it.',
      );
    }

    if (line.rsProductId !== item.rsProductId) {
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

    /*
      THE OUTBOUND STOCK POINT. Committing goods to a requirement takes them out
      of free CRM stock, in the same transaction and under the same lock as the
      allocation itself — so the two can never disagree, and a failure rolls both
      back together.

      The deduction cannot exceed what this line put in: the quantity is already
      bounded by `standingQty` (received − allocated), which is exactly the line's
      own contribution, so its stock can reach zero and never pass it. That is
      also why there is no separate "allocation cannot exceed available stock"
      check — the standing check above already is that check, expressed against
      the pool the goods actually come from.
    */
    await reconcileLineStock(tx, itemId);
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

    // Same gate as creating one. A bill whose approval is withdrawn must not
    // leave its existing allocations quietly editable.
    assertBillApproved(item.bill.approvalStatus);

    const line = await repo.findOrderLine(tx, allocation.salesOrderItemId);
    if (!line) {
      throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
    }

    // An allocation can only exist on a linked line — creating one requires it
    // — so this is a guard against corruption rather than an expected path.
    if (!item.rsProductId) {
      throw AppError.conflict(
        'PURCHASE_LINE_NOT_LINKED',
        'That purchase line is not mapped to an RS Product.',
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
      // Releasing a commitment returns the goods to free stock — exactly once,
      // because the restored amount is the difference between the recomputed
      // target and what the line currently stands for, not a remembered number.
      await reconcileLineStock(tx, itemId);
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

    // Raising or lowering a commitment moves stock the other way by the same
    // amount. Both directions are the one subtraction, so neither can drift.
    await reconcileLineStock(tx, itemId);
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
/*
 * "Put in Catalogue" used to live here, and is gone.
 *
 * It created a legacy Product from an order line's own wording and linked the
 * line to it — the one place Procurement could bring a product into existence.
 * Procurement creates no products: RS Products is the catalogue, and a product
 * that is not in it is created there, by somebody looking at the catalogue
 * rather than at one bill.
 */

export async function linkOrderLine(
  req: Request,
  actorId: string,
  input: LinkOrderLineInput,
): Promise<OrderRequirementView> {
  const rsProduct = await repo.findRsProduct(input.rsProductId);
  if (!rsProduct) throw rsProductNotFound();

  const line = await prisma.salesOrderItem.findUnique({
    where: { id: input.salesOrderItemId },
    select: { id: true, rsProductId: true, productName: true, order: { select: { orderId: true } } },
  });
  if (!line) {
    throw AppError.notFound('SALES_ORDER_ITEM_NOT_FOUND', 'That order line could not be found.');
  }

  // Remapping an already-mapped line would move stock between requirements
  // without any of allocation's checks running. Release the allocations first
  // if that is genuinely wanted.
  if (line.rsProductId) {
    throw AppError.conflict(
      'ORDER_LINE_ALREADY_LINKED',
      'That order line is already mapped to an RS Product.',
    );
  }

  try {
    await prisma.$executeRaw`
      UPDATE "SalesOrderItem" SET "rsProductId" = ${rsProduct.id}
      WHERE "id" = ${line.id} AND "rsProductId" IS NULL`;
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
    newValue: { rsProductId: rsProduct.id, rsProductTitle: rsProduct.title, lineName: line.productName },
  });

  return getOrderRequirements(line.order.orderId);
}

/**
 * Maps a purchase line to an RS Product — Procurement's canonical identity.
 *
 * Product level. The line names an `RsProduct` and never a `ShopifyVariant`:
 * the Procurement-facing RS Products API reports stock as a product-level
 * aggregate over the variants, so there is nothing a variant key would let this
 * module read that the product key does not. A variant id reaching this
 * function is a cuid that names no RsProduct, and is refused by the lookup
 * below like any other unknown id.
 *
 * Nothing is inferred. The vendor's wording on the line, its folded form and
 * any matching SKU all play no part — RS SKUs are nullable and legitimately
 * duplicated, so a SKU match is not evidence of anything, and a mapping that
 * turns out to be wrong cannot be undone once stock has been allocated through
 * it. The person picks the product.
 *
 * This is the whole identity. There is no second key beside it: allocation
 * compares this against the order line's own RsProduct, so there is nothing to
 * bridge to and nothing that can be missing.
 *
 * INITIAL MAPPING ONLY. This endpoint gives a line its FIRST product and does
 * nothing else; a line that already names one is refused here and must go
 * through `requestProductChange` below for an administrator to decide. The
 * asymmetry is the rule: naming goods nobody had named is ordinary Procurement
 * work, but *moving* a mapping that the shortage board has been read against and
 * that allocation compares identity on is not.
 *
 * Enforced here, in the service, rather than by hiding a button. A non-admin
 * calling this route directly with a new product id on a mapped line gets
 * PRODUCT_CHANGE_REQUIRES_APPROVAL, exactly as they would through the UI.
 */
export async function mapPurchaseItemToRsProduct(
  req: Request,
  actorId: string,
  billId: string,
  itemId: string,
  input: MapPurchaseItemInput,
): Promise<PurchaseBillDetail> {
  const rsProduct = await repo.findRsProduct(input.rsProductId);
  if (!rsProduct) throw rsProductNotFound();

  await prisma.$transaction(async (tx) => {
    await repo.lockBillItem(tx, itemId);

    const item = await repo.findBillItem(tx, itemId);
    if (!item || item.billId !== billId) throw itemNotFound();

    /*
      The approval gate, checked under the row lock.

      Re-sending the product the line already has is a no-op rather than a
      change, so it is allowed through — it is what a double-submitted form
      does, and refusing it would report a conflict where nothing differs.
    */
    if (item.rsProductId && item.rsProductId !== rsProduct.id) {
      throw AppError.conflict(
        'PRODUCT_CHANGE_REQUIRES_APPROVAL',
        'This line is already mapped to an RS Product. Changing it needs an administrator’s approval — raise a change request instead.',
      );
    }

    if (item.rsProductId === rsProduct.id) return;

    await tx.purchaseBillItem.update({
      where: { id: itemId },
      data: { rsProductId: rsProduct.id },
    });

    // An unmapped line held no stock, so there is nothing to release — but once
    // it names a product, an already-approved bill's surplus belongs to that
    // product and is credited now rather than waiting for another event.
    await reconcileLineStock(tx, itemId);
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.purchaseItem.rsMapped',
    entityType: 'PurchaseBillItem',
    entityId: itemId,
    actorId,
    newValue: { rsProductId: rsProduct.id, rsProductTitle: rsProduct.title },
  });

  return getBill(billId);
}

// ---------------------------------------------------------------------------
//  Changing an existing mapping — administrator approval
// ---------------------------------------------------------------------------

/**
 * The resolved PROCUREMENT ASSIGN capability for this person.
 *
 * Deciding a request is ASSIGN, mirroring how Sales gates reviewing a change
 * request, and resolved through the same permission service every other
 * capability goes through — never `role === 'ADMIN'`. A per-user grant or
 * revocation therefore applies here exactly as it does everywhere else.
 */
const mayReview = (actor: AuthenticatedUser): Promise<boolean> =>
  resolvePermission(actor.id, actor.role, 'PROCUREMENT', 'ASSIGN');

const changeNotFound = (): AppError =>
  AppError.notFound('PRODUCT_CHANGE_NOT_FOUND', 'That change request could not be found.');

/**
 * Files a request to re-map an already-mapped purchase line. Changes nothing.
 *
 * A request is a record of what somebody asked for, and that is all it is: it
 * writes no mapping, and the line goes on naming the product it named, so the
 * shortage board and allocation both carry on against the live identity however
 * long the request sits pending. Only `approveProductChange` moves it.
 *
 * Everything that would make the request impossible to approve is checked now,
 * so a person is told at once rather than after waiting for a decision:
 * the line must be mapped, the destination must exist and must differ, and the
 * line's stock must not already be allocated.
 */
export async function requestProductChange(
  req: Request,
  actor: AuthenticatedUser,
  billId: string,
  itemId: string,
  input: RequestProductChangeInput,
): Promise<PurchaseBillDetail> {
  const target = await repo.findRsProduct(input.rsProductId);
  if (!target) throw rsProductNotFound();

  await prisma.$transaction(async (tx) => {
    await repo.lockBillItem(tx, itemId);

    const item = await repo.findBillItem(tx, itemId);
    if (!item || item.billId !== billId) throw itemNotFound();

    /*
      An unmapped line needs no approval at all — that is the initial mapping,
      and sending it here would create an approval queue for ordinary work.
    */
    if (!item.rsProductId) {
      throw AppError.badRequest(
        'PURCHASE_LINE_NOT_LINKED',
        'This line has no RS Product yet, so map it directly — no approval is needed for a first mapping.',
      );
    }

    if (item.rsProductId === target.id) {
      throw AppError.badRequest(
        'PRODUCT_CHANGE_NO_OP',
        'This line is already mapped to that RS Product.',
      );
    }

    /*
      Stock already promised to orders under the current identity. Approving
      would move it to different goods without any of allocation's checks
      running, so the request could never be granted — say so now.
    */
    if (item.allocations.length > 0) {
      throw AppError.conflict(
        'PURCHASE_LINE_HAS_ALLOCATIONS',
        'Release this line’s allocations before requesting a different RS Product.',
      );
    }

    // Checked for a readable message; the partial unique index is what actually
    // guarantees it when two people race the same line.
    if (await repo.findPendingChangeForItem(tx, itemId)) {
      throw AppError.conflict(
        'PRODUCT_CHANGE_ALREADY_PENDING',
        'This line already has a product change waiting for approval. That one has to be decided first.',
      );
    }

    await tx.purchaseItemProductChange.create({
      data: {
        billId,
        itemId,
        fromRsProductId: item.rsProductId,
        toRsProductId: target.id,
        reason: input.reason,
        status: 'PENDING',
        requestedById: actor.id,
      },
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.productChange.requested',
    entityType: 'PurchaseBillItem',
    entityId: itemId,
    actorId: actor.id,
    newValue: { toRsProductId: target.id, toRsProductTitle: target.title, reason: input.reason },
  });

  return getBill(billId);
}

/** The approval queue, or one bill's history of requests. */
export async function listProductChanges(
  query: ProductChangeListQuery,
): Promise<ProductChangeView[]> {
  const rows = await repo.findProductChanges({
    ...(query.status ? { status: query.status } : {}),
    ...(query.billId ? { billId: query.billId } : {}),
  });
  return rows.map(toProductChangeView);
}

type Decision = 'APPROVED' | 'REJECTED';

/**
 * Decides a request, and — only on approval — applies it.
 *
 * Everything is revalidated inside the lock rather than trusted from the route
 * or from the request row: that the reviewer still holds the capability, that
 * the request is still pending, that the line still exists, that it still names
 * the product the request was filed against, and that no stock has been
 * allocated through it since. Two reviewers racing therefore produce one
 * decision and one honest PRODUCT_CHANGE_NOT_PENDING, which is also what makes
 * a repeated approval safe rather than doubly applied.
 *
 * A rejection is only ever a record. The existing mapping is left exactly alone
 * — that is the guarantee the whole workflow is for.
 */
async function review(
  req: Request,
  actor: AuthenticatedUser,
  changeId: string,
  decision: Decision,
  input: ReviewProductChangeInput,
): Promise<ProductChangeView[]> {
  const reviewer = await mayReview(actor);
  /*
    Checked here as well as at the route, so a hand-crafted call that somehow
    reached the service — a future route registered without the middleware, a
    direct import — cannot decide a request either. Neither layer is sufficient
    alone and both are cheap.
  */
  if (!reviewer) {
    throw AppError.forbidden('Deciding a product change request needs approval rights.');
  }

  const billId = await prisma.$transaction(async (tx) => {
    const change = await repo.findProductChange(tx, changeId);
    if (!change) throw changeNotFound();

    await repo.lockBillItem(tx, change.itemId);

    if (change.status !== 'PENDING') {
      throw AppError.conflict(
        'PRODUCT_CHANGE_NOT_PENDING',
        'That change request has already been decided.',
      );
    }

    await tx.purchaseItemProductChange.update({
      where: { id: changeId },
      // Status, reviewer and moment written together, satisfying
      // product_change_review_recorded_together and
      // product_change_decided_has_reviewer.
      data: {
        status: decision,
        reviewedById: actor.id,
        reviewedAt: new Date(),
        ...(input.note ? { reviewNote: input.note } : {}),
      },
    });

    if (decision === 'REJECTED') return change.billId;

    const item = await repo.findBillItem(tx, change.itemId);
    if (!item) throw itemNotFound();

    /*
      The line must still say what the request said it said.

      If somebody re-mapped it in between — which needs its own approval, so it
      is rare but possible — this request describes a move that no longer starts
      where it claimed. Applying it anyway would silently overwrite that later
      decision, so it is refused and a fresh request is filed against the state
      that actually exists.
    */
    if (item.rsProductId !== change.fromRsProductId) {
      throw AppError.conflict(
        'PRODUCT_CHANGE_STALE',
        'This line’s RS Product has changed since the request was raised. Raise a new request against its current mapping.',
      );
    }

    // Re-checked at the moment of the write, not merely when it was requested:
    // stock can be allocated through the line while a request waits.
    if (item.allocations.length > 0) {
      throw AppError.conflict(
        'PURCHASE_LINE_HAS_ALLOCATIONS',
        'Stock has been allocated from this line since the request was raised. Release it before approving.',
      );
    }

    /*
      The mapping moves, and its stock has to move with it.

      Released from the old product first, then re-credited to the new one by
      the reconcile below. Doing it in that order is what stops the old product
      keeping goods it no longer has any line accounting for — the movement is
      always attached to the product it belongs to.
    */
    await releaseLineStock(tx, change.itemId);

    await tx.purchaseBillItem.update({
      where: { id: change.itemId },
      data: { rsProductId: change.toRsProductId },
    });

    await reconcileLineStock(tx, change.itemId);

    return change.billId;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action:
      decision === 'APPROVED'
        ? 'procurement.productChange.approved'
        : 'procurement.productChange.rejected',
    entityType: 'PurchaseItemProductChange',
    entityId: changeId,
    actorId: actor.id,
    newValue: { decision, note: input.note ?? null, billId },
  });

  return listProductChanges({ billId });
}

export function approveProductChange(
  req: Request,
  actor: AuthenticatedUser,
  changeId: string,
  input: ReviewProductChangeInput,
): Promise<ProductChangeView[]> {
  return review(req, actor, changeId, 'APPROVED', input);
}

export function rejectProductChange(
  req: Request,
  actor: AuthenticatedUser,
  changeId: string,
  input: ReviewProductChangeInput,
): Promise<ProductChangeView[]> {
  return review(req, actor, changeId, 'REJECTED', input);
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
      rsProductId: line.rsProductId,
      linked: line.rsProductId !== null,
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
