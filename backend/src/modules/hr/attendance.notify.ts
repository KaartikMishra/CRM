/**
 * Attendance and Leave notifications, on the existing infrastructure.
 *
 * No second notification system, no second WebSocket, no second retention
 * policy. `persist` writes the rows inside a transaction and `deliver` pushes
 * them to whoever is connected, exactly as Post Sales, Dispatch and HR Phase 1
 * already do — this module only decides *when* an event is worth telling
 * somebody about.
 *
 * ### Why these events and not others
 *
 * Each one tells somebody something they must act on or could not otherwise
 * know. Clocking in raises nothing: the person just did it, and their manager
 * does not need a notice per morning. Nor does a holiday being configured, or a
 * balance accruing.
 *
 * A notice nobody needs is how a bell stops being read, and this CRM already
 * carries roughly 35,590 SALES_ORDER_CREATED rows as a standing reminder.
 *
 * ### Reusing the Phase 1 notification types
 *
 * Phase 2 adds no `NotificationType` values of its own beyond the three HR ones
 * Phase 1 introduced. Leave and correction notices reuse
 * `HR_EMPLOYEE_STATUS_CHANGED` as the generic "something about your employment
 * changed" channel, with the title and body saying which — because the bell
 * groups by type, and six near-identical HR types would fragment one person's
 * notices into six piles without telling them anything more.
 *
 * ### Failures never fail the write
 *
 * Every function swallows its own errors. The attendance or leave record is what
 * matters; if the notice cannot be raised, the change still stands and the person
 * sees it on the page. This mirrors `post-sales.notify.ts`, `hr.notify.ts` and
 * the audit service, all of which take the same position for the same reason.
 */

import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { deliver, persist } from '../notification/notification.service.js';

/** Where a notice points. Stored, so an old notice survives a routing change. */
const leaveHref = (): string => '/hr/leave';
const attendanceHref = (): string => '/hr/attendance';

type Kind = 'HR_EMPLOYEE_STATUS_CHANGED';

async function raise(
  recipientIds: string[],
  entityType: string,
  entityId: string,
  href: string,
  title: string,
  body: string,
): Promise<void> {
  const unique = [...new Set(recipientIds)];
  if (unique.length === 0) return;

  const type: Kind = 'HR_EMPLOYEE_STATUS_CHANGED';

  try {
    await prisma.$transaction((tx) =>
      persist(tx, unique, { type, title, body, href, entityType, entityId }),
    );
    await deliver(unique, type, entityId);
  } catch (error) {
    logger.error({ err: error, entityType, entityId }, 'Failed to raise HR Phase 2 notification');
  }
}

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

/**
 * A correction needs a decision.
 *
 * Addressed to the manager, because nothing else would prompt them to look — an
 * approval queue nobody is told about is a queue that grows.
 */
export async function notifyCorrectionRequested(
  managerUserId: string,
  correctionId: string,
): Promise<void> {
  await raise(
    [managerUserId],
    'AttendanceCorrectionRequest',
    correctionId,
    attendanceHref(),
    'Attendance correction to review',
    'Someone on your team has asked for an attendance correction',
  );
}

/**
 * A correction was decided.
 *
 * Addressed to the requester. The outcome is in the body because that is the
 * whole content of the message — being told "a decision was made" without which
 * way would send everybody to the page to find out.
 */
export async function notifyCorrectionDecided(
  employeeUserId: string,
  correctionId: string,
  decision: 'APPROVED' | 'REJECTED',
): Promise<void> {
  await raise(
    [employeeUserId],
    'AttendanceCorrectionRequest',
    correctionId,
    attendanceHref(),
    decision === 'APPROVED' ? 'Attendance correction approved' : 'Attendance correction rejected',
    decision === 'APPROVED'
      ? 'Your attendance has been corrected'
      : 'Your attendance correction was not approved',
  );
}

// ---------------------------------------------------------------------------
//  Leave
// ---------------------------------------------------------------------------

/** A leave request needs a decision. To the manager, for the same reason. */
export async function notifyLeaveRequested(
  managerUserId: string,
  leaveRequestId: string,
): Promise<void> {
  await raise(
    [managerUserId],
    'LeaveRequest',
    leaveRequestId,
    leaveHref(),
    'Leave request to review',
    'Someone on your team has applied for leave',
  );
}

/**
 * A leave request was decided.
 *
 * The dates are deliberately absent from the body: somebody's leave dates in a
 * notification row are personal data in a table with a 30-day retention, and the
 * page one click away shows them to whoever is entitled to see them.
 */
export async function notifyLeaveDecided(
  employeeUserId: string,
  leaveRequestId: string,
  decision: 'APPROVED' | 'REJECTED',
): Promise<void> {
  await raise(
    [employeeUserId],
    'LeaveRequest',
    leaveRequestId,
    leaveHref(),
    decision === 'APPROVED' ? 'Leave approved' : 'Leave rejected',
    decision === 'APPROVED'
      ? 'Your leave request has been approved'
      : 'Your leave request was not approved',
  );
}

/**
 * An approved leave was cancelled.
 *
 * Raised to the manager rather than the employee when the employee cancelled it
 * themselves: they already know, and the manager's team plan has just changed.
 */
export async function notifyLeaveCancelled(
  recipientUserIds: string[],
  leaveRequestId: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'LeaveRequest',
    leaveRequestId,
    leaveHref(),
    'Leave cancelled',
    'A leave request has been cancelled',
  );
}
