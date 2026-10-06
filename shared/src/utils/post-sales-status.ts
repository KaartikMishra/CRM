import type { PostSalesCaseStatus } from '../enums.js';

/**
 * Which case statuses may follow which.
 *
 * The map is the specification. It lives in @rs/shared so the service enforces
 * the same rule the form offers: a button that proposes an illegal move is a
 * button that produces a 422, and two separately-written tables would drift the
 * first time a state was added.
 *
 * ### The shape of the lifecycle
 *
 *     NEW ──> ASSIGNED ──> IN_PROGRESS ──> RESOLUTION_IN_PROGRESS ──> RESOLVED
 *                              │  ▲                                      │
 *                              ▼  │                                      ▼
 *                         AWAITING_* ───────┘                         CLOSED
 *                                                                        │
 *                                                       REOPENED <───────┘
 *
 * Four decisions worth naming, because each is a rule somebody could reasonably
 * have written the other way:
 *
 *   - **The AWAITING_* states return to IN_PROGRESS**, and to each other. A case
 *     blocked on the customer can become blocked on a courier without passing
 *     back through IN_PROGRESS first, because that is what actually happens.
 *
 *   - **RESOLVED can go back to IN_PROGRESS.** Marking a case resolved and then
 *     finding it is not is ordinary, and the alternative — forcing a close and a
 *     reopen to correct a mistake — would put a false closure in the history.
 *
 *   - **CLOSED is near-terminal.** Its only exit is REOPENED. A closed case is a
 *     settled record, and editing it in place would rewrite a verdict rather than
 *     revisiting it.
 *
 *   - **Nothing may transition to itself.** Re-setting the current status is not
 *     a change; permitting it would write an audit entry and a timeline entry
 *     saying nothing happened.
 *
 * Deliberately absent: any transition driven by a clock. No status here means
 * "overdue", and nothing in this map fires on its own.
 */
export const POST_SALES_STATUS_TRANSITIONS: Record<
  PostSalesCaseStatus,
  readonly PostSalesCaseStatus[]
> = {
  // A new case is assigned, or worked directly by whoever raised it.
  NEW: ['ASSIGNED', 'IN_PROGRESS'],
  ASSIGNED: ['IN_PROGRESS', 'AWAITING_CUSTOMER', 'AWAITING_INTERNAL'],
  IN_PROGRESS: [
    'AWAITING_CUSTOMER',
    'AWAITING_INTERNAL',
    'AWAITING_VENDOR',
    'AWAITING_COURIER',
    'RESOLUTION_IN_PROGRESS',
    'RESOLVED',
  ],
  // Each blocked state can move to any other, or resume. Waiting on one party
  // and then another is the normal course of a real case.
  AWAITING_CUSTOMER: [
    'IN_PROGRESS',
    'AWAITING_INTERNAL',
    'AWAITING_VENDOR',
    'AWAITING_COURIER',
    'RESOLUTION_IN_PROGRESS',
    'RESOLVED',
  ],
  AWAITING_INTERNAL: [
    'IN_PROGRESS',
    'AWAITING_CUSTOMER',
    'AWAITING_VENDOR',
    'AWAITING_COURIER',
    'RESOLUTION_IN_PROGRESS',
    'RESOLVED',
  ],
  AWAITING_VENDOR: [
    'IN_PROGRESS',
    'AWAITING_CUSTOMER',
    'AWAITING_INTERNAL',
    'AWAITING_COURIER',
    'RESOLUTION_IN_PROGRESS',
    'RESOLVED',
  ],
  AWAITING_COURIER: [
    'IN_PROGRESS',
    'AWAITING_CUSTOMER',
    'AWAITING_INTERNAL',
    'AWAITING_VENDOR',
    'RESOLUTION_IN_PROGRESS',
    'RESOLVED',
  ],
  RESOLUTION_IN_PROGRESS: ['RESOLVED', 'IN_PROGRESS', 'AWAITING_CUSTOMER'],
  // Correctable without a false closure; see the note above.
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: ['REOPENED'],
  REOPENED: ['ASSIGNED', 'IN_PROGRESS'],
};

/** Whether this move is permitted. Self-transitions are never permitted. */
export function canTransitionCase(
  from: PostSalesCaseStatus,
  to: PostSalesCaseStatus,
): boolean {
  if (from === to) return false;
  return POST_SALES_STATUS_TRANSITIONS[from].includes(to);
}

/** Where a case in this status may go, for the UI to offer. */
export function nextCaseStatuses(
  from: PostSalesCaseStatus,
): readonly PostSalesCaseStatus[] {
  return POST_SALES_STATUS_TRANSITIONS[from];
}

/**
 * Statuses that mean the case still needs somebody.
 *
 * "Open" is every state that is not RESOLVED or CLOSED — REOPENED included,
 * because a case that came back is open again. Used by the overview counts and
 * the board's default filter, and defined once so the two agree.
 */
export const POST_SALES_OPEN_STATUSES: readonly PostSalesCaseStatus[] = [
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'AWAITING_CUSTOMER',
  'AWAITING_INTERNAL',
  'AWAITING_VENDOR',
  'AWAITING_COURIER',
  'RESOLUTION_IN_PROGRESS',
  'REOPENED',
];

export const isOpenCaseStatus = (status: PostSalesCaseStatus): boolean =>
  POST_SALES_OPEN_STATUSES.includes(status);
