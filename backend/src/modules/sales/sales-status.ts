/**
 * The single status guard for Sales Orders.
 *
 * No service assigns `status` directly and no route accepts it as input, so
 * every transition passes through here. A move that is not in the map is
 * impossible to write rather than merely discouraged.
 *
 * The lifecycle is deliberately linear. An order is dispatched before it is
 * closed, which is what guarantees every closed order carries a frozen
 * efficiency verdict — a direct OPEN → CLOSED would leave a permanent null and
 * quietly hole the dispatch reporting.
 */

import type { SalesOrderStatus } from '@rs/shared';
import { AppError } from '../../utils/AppError.js';

const ALLOWED: Record<SalesOrderStatus, SalesOrderStatus[]> = {
  OPEN: ['DISPATCHED'],
  DISPATCHED: ['CLOSED'],
  // There is no reopen: leaving CLOSED is not a sanctioned move.
  CLOSED: [],
};

export function assertTransition(from: SalesOrderStatus, to: SalesOrderStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new AppError(
      'INVALID_STATUS_TRANSITION',
      409,
      `A sales order cannot move from ${from} to ${to}.`,
    );
  }
}

/** A closed order is not editable through ordinary routes. */
export function assertNotClosed(status: SalesOrderStatus): void {
  if (status === 'CLOSED') {
    throw new AppError(
      'ORDER_CLOSED',
      409,
      'This order is closed and can no longer be changed.',
    );
  }
}
