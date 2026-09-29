import type {
  DispatchReadinessLine,
  DispatchStatus,
  DispatchView,
  PartialDispatchRequestView,
} from '@rs/shared';

/**
 * The decisions the Dispatch screens make, as pure functions.
 *
 * Kept out of the components on purpose, exactly as procurement.calc.ts is kept
 * out of the services: these are rules, they are worth testing on their own, and
 * the frontend test suite has no DOM. A component that embeds a rule inline can
 * only be tested by rendering it; a rule that lives here can be asserted
 * directly.
 *
 * ### What is deliberately not here
 *
 * Anything the backend decides. None of these functions grant permission,
 * compute readiness or settle a request — they read figures the API already
 * derived and answer questions about what to *show*. Where a check looks like
 * validation (the quantity rules below), it exists to give a friendly message
 * before a round trip, never to replace the API's own refusal: the server
 * re-checks every one of them under a lock, and its answer wins.
 */

// ---------------------------------------------------------------------------
//  Packing quantities
// ---------------------------------------------------------------------------

export type PackLine = {
  salesOrderItemId: string;
  /** What the dispatcher typed. */
  quantity: number;
};

export type QuantityProblem = {
  salesOrderItemId: string;
  message: string;
};

/**
 * Friendly validation for a pack being assembled.
 *
 * Three ways a selection can be wrong, and each gets its own sentence because
 * "invalid quantity" tells a dispatcher nothing about which box to fix:
 *
 *   - a quantity that is not a whole number of at least one — you cannot pack
 *     half a cooker, and zero means "do not include this line", which is
 *     expressed by leaving it out rather than by typing 0;
 *   - more than the line can currently supply;
 *   - the same line chosen twice, which would promise the same units to one
 *     parcel under two headings.
 */
export function validatePack(
  lines: PackLine[],
  readiness: DispatchReadinessLine[],
): QuantityProblem[] {
  const problems: QuantityProblem[] = [];
  const byId = new Map(readiness.map((line) => [line.salesOrderItemId, line]));
  const seen = new Set<string>();

  for (const line of lines) {
    if (seen.has(line.salesOrderItemId)) {
      problems.push({
        salesOrderItemId: line.salesOrderItemId,
        message: 'That product is already on this shipment.',
      });
      continue;
    }
    seen.add(line.salesOrderItemId);

    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      problems.push({
        salesOrderItemId: line.salesOrderItemId,
        message: 'Enter a whole number of at least 1, or remove the line.',
      });
      continue;
    }

    const available = dispatchableQty(byId.get(line.salesOrderItemId));
    if (line.quantity > available) {
      problems.push({
        salesOrderItemId: line.salesOrderItemId,
        message:
          available === 0
            ? 'None of this product is ready to send.'
            : `Only ${available} ready to send.`,
      });
    }
  }

  return problems;
}

/**
 * What one line can still put in a parcel.
 *
 * The API reports `readyQty` and `dispatchedQty` separately; what is left is
 * the difference, floored at zero. Over-dispatch is a data problem to report
 * rather than a negative number to offer.
 */
export function dispatchableQty(line: DispatchReadinessLine | undefined): number {
  if (!line) return 0;
  return Math.max(0, line.readyQty - line.dispatchedQty);
}

/** True when any line on the order could go in a parcel right now. */
export function hasAnythingToPack(readiness: DispatchReadinessLine[]): boolean {
  return readiness.some((line) => dispatchableQty(line) > 0);
}

// ---------------------------------------------------------------------------
//  A shipment's next step
// ---------------------------------------------------------------------------

/**
 * The one action a shipment is waiting for.
 *
 * Mirrors the backend's TRANSITIONS table rather than inventing a second
 * lifecycle: a shipment moves DRAFT → PACKING → PACKED → DISPATCHED, and the
 * terminal states offer nothing. This only decides which button to draw; the
 * API refuses an out-of-order move on its own authority.
 */
export type ShipmentStep = 'START_PACKING' | 'MARK_PACKED' | 'DISPATCH' | null;

export function nextStep(status: DispatchStatus): ShipmentStep {
  switch (status) {
    case 'DRAFT':
      return 'START_PACKING';
    case 'PACKING':
      return 'MARK_PACKED';
    case 'PACKED':
      return 'DISPATCH';
    default:
      return null;
  }
}

/** Whether a shipment can still be abandoned. Sent goods cannot be un-sent. */
export function canCancel(status: DispatchStatus): boolean {
  return status !== 'DISPATCHED' && status !== 'CANCELLED';
}

/** Whether its carrier and AWB can still be edited. */
export function canEditShipment(status: DispatchStatus): boolean {
  return status !== 'DISPATCHED' && status !== 'CANCELLED';
}

/** Shipments still in play, newest first — what the detail page acts on. */
export function activeShipments(dispatches: DispatchView[]): DispatchView[] {
  return dispatches.filter((d) => d.status !== 'CANCELLED' && d.status !== 'DISPATCHED');
}

// ---------------------------------------------------------------------------
//  Partial dispatch
// ---------------------------------------------------------------------------

/**
 * Whether asking about a partial dispatch makes sense right now.
 *
 * The API refuses the question on a fully ready order ("just send it") and on
 * one with nothing ready ("there is no parcel to send"), so the button is only
 * offered in the case that is actually a question — and only when no earlier
 * question is still open.
 */
export function canRequestPartial({
  fullyReady,
  partiallyReady,
  pendingRequest,
}: {
  fullyReady: boolean;
  partiallyReady: boolean;
  pendingRequest: PartialDispatchRequestView | null;
}): boolean {
  if (pendingRequest) return false;
  return partiallyReady && !fullyReady;
}

/** The open question on an order, if there is one. At most one can exist. */
export function openRequest(
  requests: PartialDispatchRequestView[],
): PartialDispatchRequestView | null {
  return requests.find((request) => request.status === 'PENDING') ?? null;
}

/**
 * How long is left before the deadline decides for Procurement.
 *
 * Returns whole hours and minutes, and reports `expired` once the moment has
 * passed — at which point the sweep will settle it within a few minutes. The
 * screen says "due" rather than counting into negative numbers, because a
 * request past its deadline is not overdue by an amount anybody acts on.
 */
export type Countdown = {
  expired: boolean;
  hours: number;
  minutes: number;
  label: string;
};

export function deadlineCountdown(deadline: string, now: Date = new Date()): Countdown {
  const remaining = new Date(deadline).getTime() - now.getTime();

  if (remaining <= 0) {
    return { expired: true, hours: 0, minutes: 0, label: 'Deadline passed' };
  }

  const totalMinutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return {
    expired: false,
    hours,
    minutes,
    label: hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`,
  };
}

/**
 * What a request's outcome should say in one line.
 *
 * The automatic allow is the case this function exists for. It has no reason —
 * `reason` is null by database constraint — so the sentence has to explain the
 * silence instead, and it must never be confused with a reason somebody gave.
 */
export function outcomeLine(request: PartialDispatchRequestView): string | null {
  if (request.status === 'PENDING') return null;

  if (request.autoDecided) {
    return 'Auto-allowed — no Procurement response received within 24 hours.';
  }

  if (request.status === 'MOOT') {
    return 'No longer needed — the rest of the order became ready.';
  }

  return request.reason;
}

/**
 * Whether the decision controls should be drawn at all.
 *
 * Permission is checked by the caller through `can(user, 'PROCUREMENT',
 * 'ASSIGN')` — never `role === 'ADMIN'`, so a per-user grant or revocation
 * applies here as it does everywhere else. This adds the other half: there has
 * to be an open question to answer.
 */
export function canDecide(
  request: PartialDispatchRequestView | null,
  hasAssignPermission: boolean,
): boolean {
  return hasAssignPermission && request !== null && request.status === 'PENDING';
}
