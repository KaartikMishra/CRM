/**
 * Packing & Dispatch business logic.
 *
 * The module answers one question and records one fact. The question is "can
 * this order go?", which is *derived* from Procurement's own figures on every
 * read. The fact is what actually left: which lines, how many units, by which
 * carrier, under which airway bill, packed and sent by whom.
 *
 * ### What this module never does
 *
 * **It does not move stock.** `ShopifyVariant.crmStockQty` has exactly one
 * writer, `reconcileLineStock` in Procurement. Allocation already took these
 * goods out of free stock when they were committed to the order; decrementing
 * again at dispatch would count the same units twice. Nothing in this file
 * reads or writes a stock figure.
 *
 * **It does not gate on payment.** An unpaid order is dispatchable — that is a
 * commercial decision the business makes, not a technical one this module
 * imposes. The amounts are shown on the detail for context only.
 *
 * **It does not store readiness.** See dispatch.calc.ts.
 */

import type { Request } from 'express';
import {
  DISPATCH_CARRIERS,
  DISPATCH_CHANNELS,
  type CreateDispatchInput,
  type DispatchCarrier,
  type DispatchChannel,
  type DispatchDetail,
  type DispatchListQuery,
  type DispatchOrderInput,
  type DispatchReadiness,
  type DispatchReadinessLine,
  type DispatchSummary,
  type DispatchView,
  type MediaRef,
  type UpdateDispatchInput,
  type UserRef,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { dispatchVerdict } from '../sales/sales-efficiency.js';
import {
  customerDispatchChecks,
  orderFullyDispatched,
  orderFullyReady,
  orderPartiallyReady,
} from './dispatch.calc.js';
import { readinessFor } from './dispatch.readiness.js';
import { toView as toPartialRequestView } from './dispatch-partial.service.js';
import * as repo from './dispatch.repository.js';
import type { DispatchRecord, OrderForDispatch } from './dispatch.repository.js';

/** Neon is a network hop away; the same budget the rest of the CRM uses. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

const orderNotFound = (): AppError =>
  AppError.notFound('SALES_ORDER_NOT_FOUND', 'That sales order could not be found.');

const dispatchNotFound = (): AppError =>
  AppError.notFound('DISPATCH_NOT_FOUND', 'That dispatch could not be found.');

// ---------------------------------------------------------------------------
//  Readiness — derived, never stored
// ---------------------------------------------------------------------------

/**
 * Units of a line already gone out.
 *
 * Counts every shipment that is not CANCELLED, including one still being
 * packed: those units are committed to a parcel and offering them again to a
 * second shipment would promise the same goods twice. A cancelled pack releases
 * them, which is what makes cancelling meaningful.
 */
function toReadiness(order: OrderForDispatch): DispatchReadiness {
  const { lines, views } = readinessFor(order);
  const { blockers, warnings } = customerDispatchChecks(order.customer);

  return {
    salesOrderId: order.id,
    orderId: order.orderId,
    fullyReady: orderFullyReady(lines),
    partiallyReady: orderPartiallyReady(lines),
    lines: views,
    blockers,
    warnings,
  };
}

// ---------------------------------------------------------------------------
//  Mappers
// ---------------------------------------------------------------------------

const iso = (d: Date): string => d.toISOString();

function toDispatchView(row: DispatchRecord): DispatchView {
  return {
    id: row.id,
    salesOrderId: row.salesOrderId,
    orderId: row.salesOrder.orderId,
    status: row.status,
    isPartial: row.isPartial,
    // Narrowed from the plain String columns: the shared z.enum is what
    // guarantees only permitted values were ever written.
    channel: (row.channel as DispatchChannel | null) ?? null,
    channelOther: row.channelOther,
    carrier: (row.carrier as DispatchCarrier | null) ?? null,
    carrierOther: row.carrierOther,
    awb: row.awb,
    items: row.items.map((item) => ({
      id: item.id,
      salesOrderItemId: item.salesOrderItem.id,
      lineNo: item.salesOrderItem.lineNo,
      productName: item.salesOrderItem.productName,
      image: (item.salesOrderItem.productImage as MediaRef | null) ?? null,
      quantity: item.quantity,
    })),
    packedBy: (row.packedBy as UserRef | null) ?? null,
    packedAt: row.packedAt ? iso(row.packedAt) : null,
    dispatchedBy: (row.dispatchedBy as UserRef | null) ?? null,
    dispatchedAt: row.dispatchedAt ? iso(row.dispatchedAt) : null,
    createdBy: row.createdBy as UserRef,
    createdAt: iso(row.createdAt),
  };
}

// ---------------------------------------------------------------------------
//  Reads
// ---------------------------------------------------------------------------

export async function listBoard(
  query: DispatchListQuery,
): Promise<{ orders: DispatchSummary[]; nextCursor: string | null }> {
  const rows = await repo.listBoardOrders({
    limit: query.limit,
    cursor: query.cursor,
    q: query.q,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  /*
    Every open question for the whole page in one query, rather than one per
    row. The board is the module's busiest read and a per-order lookup would
    make its cost grow with the page size for a column that is usually null.
  */
  const pending = await repo.findPendingRequestsForOrders(page.map((order) => order.id));
  const pendingByOrder = new Map(pending.map((request) => [request.salesOrderId, request]));

  const orders = await Promise.all(
    page.map(async (order): Promise<DispatchSummary> => {
      const { lines } = readinessFor(order);
      const dispatches = await repo.listDispatchesForOrder(order.id);
      const open = pendingByOrder.get(order.id);

      return {
        salesOrderId: order.id,
        orderId: order.orderId,
        customerName: order.customer.name,
        // Already selected by orderForDispatchSelect for the customer checks;
        // these only surface what the row was already carrying.
        customerPhone: order.customer.phone,
        customerEmail: order.customer.email,
        customerAddress: order.customer.address,
        orderDate: iso(order.orderDate),
        toBeDispatchedBy: iso(order.toBeDispatchedBy),
        fullyReady: orderFullyReady(lines),
        partiallyReady: orderPartiallyReady(lines),
        readyLines: lines.filter((l) => l.pendingQty === 0).length,
        totalLines: lines.length,
        /*
          What is actually packable now, which is not the same question as how
          many lines are complete: an order with seven of ten units ready has
          zero complete lines and seven units waiting to go.
        */
        dispatchableQty: lines.reduce((sum, l) => sum + l.dispatchableQty, 0),
        latestDispatchStatus: dispatches[0]?.status ?? null,
        pendingPartialRequest: open ? toPartialRequestView(open) : null,
      };
    }),
  );

  return { orders, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
}

export async function getDetail(salesOrderId: string): Promise<DispatchDetail> {
  const order = await repo.findOrderForDispatch(salesOrderId);
  if (!order) throw orderNotFound();

  const [dispatches, partialRequests] = await Promise.all([
    repo.listDispatchesForOrder(salesOrderId),
    repo.listPartialRequests(salesOrderId),
  ]);

  // Shown for context only — dispatch does not gate on payment.
  const orderTotal = order.items.reduce(
    (sum, item) =>
      sum + Number(item.price) * Math.max(0, item.quantity - item.cancelledQty),
    0,
  );

  return {
    salesOrderId: order.id,
    orderId: order.orderId,
    customer: order.customer,
    orderDate: iso(order.orderDate),
    toBeDispatchedBy: iso(order.toBeDispatchedBy),
    orderTotal: orderTotal.toFixed(2),
    paidAmount: order.paidAmount.toString(),
    readiness: toReadiness(order),
    dispatches: dispatches.map(toDispatchView),
    /*
      The whole history, newest first — not just the open one. A dispatcher
      looking at a part-sent order needs to see that a request was refused last
      week and why, which a current-state-only view would hide.
    */
    partialRequests: partialRequests.map(toPartialRequestView),
  };
}

// ---------------------------------------------------------------------------
//  Creating a shipment
// ---------------------------------------------------------------------------

/**
 * Opens a shipment against an order.
 *
 * Every quantity is checked against what is actually dispatchable *inside the
 * lock*, not trusted from the request: readiness can change between the screen
 * being drawn and the button being pressed — an allocation released, a line
 * cancelled, another pack started — and a shipment promising goods that are no
 * longer there would be a parcel nobody can fill.
 */
export async function createDispatch(
  req: Request,
  actor: AuthenticatedUser,
  input: CreateDispatchInput,
): Promise<DispatchView> {
  const id = await prisma.$transaction(async (tx) => {
    await repo.lockOrder(tx, input.salesOrderId);

    const order = await repo.findOrderForDispatch(input.salesOrderId, tx);
    if (!order) throw orderNotFound();

    if (order.status === 'CANCELLED' || order.status === 'CLOSED') {
      throw AppError.conflict(
        'ORDER_NOT_DISPATCHABLE',
        `That order is ${order.status.toLowerCase()} and cannot be dispatched.`,
      );
    }

    const { lines } = readinessFor(order);
    const byItemId = new Map(order.items.map((item, i) => [item.id, lines[i]!]));

    for (const requested of input.items) {
      const readiness = byItemId.get(requested.salesOrderItemId);
      if (!readiness) {
        throw AppError.badRequest(
          'LINE_NOT_ON_ORDER',
          'One of those products is not an active line on this order.',
        );
      }

      if (requested.quantity > readiness.dispatchableQty) {
        throw AppError.conflict(
          'QUANTITY_NOT_READY',
          `Only ${readiness.dispatchableQty} of that product is ready to send; ${requested.quantity} was asked for.`,
        );
      }
    }

    /*
      Partial when this shipment does not carry the whole remaining order —
      either because a line is short, or because fewer units were chosen than
      are available. Recorded rather than derived later: what a parcel was
      *intended* to be is a fact about the moment it was packed.
    */
    const coversEverything = order.items.every((item, i) => {
      const readiness = lines[i]!;
      const taking =
        input.items.find((r) => r.salesOrderItemId === item.id)?.quantity ?? 0;
      return readiness.dispatchedQty + taking >= readiness.requiredQty;
    });

    const created = await repo.createDispatch(tx, {
      salesOrderId: input.salesOrderId,
      createdById: actor.id,
      isPartial: !coversEverything,
      items: input.items,
    });

    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'dispatch.created',
    entityType: 'Dispatch',
    entityId: id,
    actorId: actor.id,
    newValue: { salesOrderId: input.salesOrderId, lines: input.items.length },
  });

  return loadView(id);
}

// ---------------------------------------------------------------------------
//  Packing
// ---------------------------------------------------------------------------

/** The states a shipment may move between, and nothing else. */
const TRANSITIONS: Record<DispatchRecord['status'], DispatchRecord['status'][]> = {
  DRAFT: ['PACKING', 'CANCELLED'],
  PACKING: ['PACKED', 'CANCELLED'],
  PACKED: ['DISPATCHED', 'CANCELLED'],
  // Terminal. Goods that have left cannot be un-sent.
  DISPATCHED: [],
  CANCELLED: [],
};

function assertTransition(from: DispatchRecord['status'], to: DispatchRecord['status']): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw AppError.conflict(
      'DISPATCH_TRANSITION_NOT_ALLOWED',
      `A ${from.toLowerCase()} shipment cannot become ${to.toLowerCase()}.`,
    );
  }
}

/** Records how the shipment travels. Optional while packing. */
export async function updateDispatch(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: UpdateDispatchInput,
): Promise<DispatchView> {
  await prisma.$transaction(async (tx) => {
    const current = await repo.findDispatch(id, tx);
    if (!current) throw dispatchNotFound();

    if (current.status === 'DISPATCHED' || current.status === 'CANCELLED') {
      throw AppError.conflict(
        'DISPATCH_SETTLED',
        `A ${current.status.toLowerCase()} shipment can no longer be edited.`,
      );
    }

    await repo.updateDispatch(tx, id, {
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.channelOther !== undefined ? { channelOther: input.channelOther } : {}),
      ...(input.carrier !== undefined ? { carrier: input.carrier } : {}),
      ...(input.carrierOther !== undefined ? { carrierOther: input.carrierOther } : {}),
      ...(input.awb !== undefined ? { awb: input.awb } : {}),
    });
  }, TX_OPTIONS).catch(rethrowDuplicateAwb);

  await recordAudit(req, {
    action: 'dispatch.updated',
    entityType: 'Dispatch',
    entityId: id,
    actorId: actor.id,
    newValue: { ...input },
  });

  return loadView(id);
}

/** Moves a shipment between packing states. */
export async function setDispatchStatus(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  to: 'PACKING' | 'PACKED' | 'CANCELLED',
): Promise<DispatchView> {
  await prisma.$transaction(async (tx) => {
    const current = await repo.findDispatch(id, tx);
    if (!current) throw dispatchNotFound();

    assertTransition(current.status, to);

    const at = await databaseNow(tx);

    await repo.updateDispatch(tx, id, {
      status: to,
      // Who sealed the parcel, recorded at the moment it was sealed.
      ...(to === 'PACKED' ? { packedBy: { connect: { id: actor.id } }, packedAt: at } : {}),
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: `dispatch.${to.toLowerCase()}`,
    entityType: 'Dispatch',
    entityId: id,
    actorId: actor.id,
    newValue: { status: to },
  });

  return loadView(id);
}

// ---------------------------------------------------------------------------
//  Sending
// ---------------------------------------------------------------------------

/**
 * Sends the goods.
 *
 * The last point at which anything can be refused, so everything is checked
 * here even though the screen checked it too: the customer's details, the
 * tracing fields, and the state. A parcel that has left cannot be recalled by
 * validating it afterwards.
 */
export async function dispatchShipment(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: DispatchOrderInput,
): Promise<DispatchView> {
  const orderDispatched = await prisma.$transaction(async (tx) => {
    const current = await repo.findDispatch(id, tx);
    if (!current) throw dispatchNotFound();

    await repo.lockOrder(tx, current.salesOrderId);
    assertTransition(current.status, 'DISPATCHED');

    const order = await repo.findOrderForDispatch(current.salesOrderId, tx);
    if (!order) throw orderNotFound();

    /*
      The customer's details, checked against the record rather than the
      request. A parcel cannot be addressed without them, and a courier cannot
      redirect one without a number. A missing email is reported as a warning
      and deliberately does not stop the goods.
    */
    const { blockers } = customerDispatchChecks(order.customer);
    if (blockers.length > 0) {
      throw AppError.validation(
        'This order cannot be dispatched yet.',
        blockers.map((message) => ({ path: 'customer', message })),
      );
    }

    const at = await databaseNow(tx);

    await repo.updateDispatch(tx, id, {
      status: 'DISPATCHED',
      channel: input.channel,
      channelOther: input.channelOther ?? null,
      carrier: input.carrier,
      carrierOther: input.carrierOther ?? null,
      awb: input.awb,
      dispatchedBy: { connect: { id: actor.id } },
      dispatchedAt: at,
      // A pack sent without passing through PACKED still records who sealed it.
      ...(current.packedAt ? {} : { packedBy: { connect: { id: actor.id } }, packedAt: at }),
    });

    /*
      The order itself moves to DISPATCHED only once everything owed has gone.
      A partial shipment leaves the order OPEN, which is what keeps the rest of
      it on the dispatch board and on Procurement's shortage board.
    */
    const after = await repo.findOrderForDispatch(current.salesOrderId, tx);
    const { lines } = readinessFor(after!);

    if (order.status === 'OPEN' && orderFullyDispatched(lines)) {
      await repo.markOrderDispatched(
        tx,
        current.salesOrderId,
        at,
        // Sales' own verdict function, so one order cannot acquire two
        // different answers depending on which screen sent it.
        dispatchVerdict(at, order.toBeDispatchedBy),
      );
      return true;
    }

    return false;
  }, TX_OPTIONS).catch(rethrowDuplicateAwb);

  await recordAudit(req, {
    action: 'dispatch.dispatched',
    entityType: 'Dispatch',
    entityId: id,
    actorId: actor.id,
    newValue: {
      carrier: input.carrier,
      channel: input.channel,
      awb: input.awb,
      orderFullyDispatched: orderDispatched,
    },
  });

  return loadView(id);
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Turns the AWB unique index into the module's own vocabulary.
 *
 * The index is the authority on duplicates — a check-then-insert would let two
 * concurrent dispatches both pass and one still fail — so this catches the
 * constraint rather than pre-empting it.
 */
function rethrowDuplicateAwb(error: unknown): never {
  if ((error as { code?: string }).code === 'P2002') {
    throw AppError.conflict(
      'AWB_ALREADY_USED',
      'That AWB number is already recorded against this carrier. Check the number, or the shipment it belongs to.',
    );
  }
  throw error;
}

async function loadView(id: string): Promise<DispatchView> {
  const row = await repo.findDispatch(id);
  if (!row) throw dispatchNotFound();
  return toDispatchView(row);
}

export async function getDispatch(id: string): Promise<DispatchView> {
  return loadView(id);
}

/** Re-exported so the routes can name the vocabularies in one place. */
export { DISPATCH_CARRIERS, DISPATCH_CHANNELS };
