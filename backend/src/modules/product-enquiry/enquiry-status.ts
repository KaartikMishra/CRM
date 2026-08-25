/**
 * §17 — the single status guard.
 *
 * No service assigns `status` directly and no route exposes it, so every
 * transition passes through here. A move that is not in the map is impossible
 * to write rather than merely discouraged.
 */

import type { EnquiryStatus } from '@rs/shared';
import { AppError } from '../../utils/AppError.js';

const ALLOWED: Record<EnquiryStatus, EnquiryStatus[]> = {
  // Partial Submit narrows coverage; Full Submit closes.
  OPEN: ['PARTIAL_CLOSED', 'CLOSED'],
  // A partially closed enquiry keeps accepting responses until it is closed.
  PARTIAL_CLOSED: ['PARTIAL_CLOSED', 'CLOSED'],
  // §24 — leaving CLOSED is a separate, admin-only, audited reopen.
  CLOSED: [],
};

export function assertTransition(from: EnquiryStatus, to: EnquiryStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new AppError(
      'INVALID_STATUS_TRANSITION',
      409,
      `An enquiry cannot move from ${from} to ${to}.`,
    );
  }
}

/** §24 — the one sanctioned way out of CLOSED, checked separately. */
export function assertReopenable(from: EnquiryStatus): void {
  if (from !== 'CLOSED') {
    throw new AppError(
      'INVALID_STATUS_TRANSITION',
      409,
      'Only a closed enquiry can be reopened.',
    );
  }
}

/** §24 — a closed enquiry is not editable through ordinary routes. */
export function assertNotClosed(status: EnquiryStatus): void {
  if (status === 'CLOSED') {
    throw new AppError(
      'ENQUIRY_CLOSED',
      409,
      'This enquiry is closed. An administrator must reopen it first.',
    );
  }
}
