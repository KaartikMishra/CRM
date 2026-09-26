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
  /*
    CANCELLED leaves the line rather than extending it.

    An order can be called off while it is still open, and after it has gone
    out — a customer who refuses delivery cancels an order that was already
    DISPATCHED. It cannot be cancelled once CLOSED: closing means the money is
    settled and the order is history, and history is not rewritten. It cannot
    be un-cancelled either, for the same reason there is no reopen.
  */
  OPEN: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['CLOSED', 'CANCELLED'],
  // There is no reopen: leaving CLOSED is not a sanctioned move.
  CLOSED: [],
  CANCELLED: [],
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

/**
 * A closed or cancelled order is not editable through ordinary routes.
 *
 * Both are terminal, and for the same reason: whatever the order says is now
 * the record of what happened. A cancelled order still accepts one thing —
 * refunds — because money owed back is settled after the goods are called off,
 * never before. That route does not call this.
 */
export function assertNotClosed(status: SalesOrderStatus): void {
  if (status === 'CLOSED') {
    throw new AppError(
      'ORDER_CLOSED',
      409,
      'This order is closed and can no longer be changed.',
    );
  }

  if (status === 'CANCELLED') {
    throw new AppError(
      'ORDER_CANCELLED',
      409,
      'This order is cancelled and can no longer be changed.',
    );
  }
}
