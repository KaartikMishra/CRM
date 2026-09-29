/**
 * Turning one order's rows into its readiness figures.
 *
 * Extracted from dispatch.service so the partial-request service and the sweep
 * can ask the same question without importing the shipment lifecycle — and, more
 * importantly, without a cycle: the partial service needs readiness, and the
 * dispatch service needs the partial service to report an open request on the
 * board. One of the two had to become a leaf, and readiness is the half that
 * depends on nothing.
 *
 * The arithmetic itself is not here. It lives in dispatch.calc.ts, which knows
 * nothing about Prisma; this file only feeds that arithmetic the rows it needs
 * and shapes the result for the wire.
 */

import type { DispatchReadinessLine, MediaRef } from '@rs/shared';
import { lineReadiness, type LineReadiness } from './dispatch.calc.js';
import type { OrderForDispatch } from './dispatch.repository.js';

/**
 * Units of a line already gone out.
 *
 * Counts every shipment that is not CANCELLED, including one still being
 * packed: those units are committed to a parcel and offering them again to a
 * second shipment would promise the same goods twice. A cancelled pack releases
 * them, which is what makes cancelling meaningful.
 */
export function dispatchedSoFar(item: OrderForDispatch['items'][number]): number {
  return item.dispatchItems
    .filter((d) => d.dispatch.status !== 'CANCELLED')
    .reduce((sum, d) => sum + d.quantity, 0);
}

/**
 * Both shapes of the same answer.
 *
 * `lines` is what the order-level predicates in dispatch.calc consume;
 * `views` is what the API returns. They are produced together so the two can
 * never be computed from different reads of the same order.
 */
export function readinessFor(order: OrderForDispatch): {
  lines: LineReadiness[];
  views: DispatchReadinessLine[];
} {
  const lines: LineReadiness[] = [];
  const views: DispatchReadinessLine[] = [];

  for (const item of order.items) {
    const readiness = lineReadiness({
      quantity: item.quantity,
      cancelledQty: item.cancelledQty,
      alreadyFulfilled: item.alreadyFulfilled,
      allocations: item.allocations,
      dispatchedQty: dispatchedSoFar(item),
    });

    lines.push(readiness);
    views.push({
      salesOrderItemId: item.id,
      lineNo: item.lineNo,
      productName: item.productName,
      image: (item.productImage as MediaRef | null) ?? null,
      // Null for a free-text line, and null for a mapped product whose variant
      // carries none. Both are real states; neither gets a placeholder.
      sku: item.rsProduct?.variants[0]?.sku ?? null,
      requiredQty: readiness.requiredQty,
      readyQty: readiness.readyQty,
      pendingQty: readiness.pendingQty,
      dispatchedQty: readiness.dispatchedQty,
      status: readiness.status,
    });
  }

  return { lines, views };
}
