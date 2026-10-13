/**
 * HR notifications, on the existing infrastructure.
 *
 * No second notification system, no second WebSocket, no second retention policy.
 * `persist` writes the rows inside a transaction and `deliver` pushes them to
 * whoever is connected, exactly as Post Sales and Dispatch already do — this
 * module only decides *when* an HR event is worth telling somebody about.
 *
 * ### Why only three events
 *
 * Each of these tells somebody something they must act on or could not otherwise
 * know. Creating an employee raises nothing: the HR team already knows, having
 * just done it. Editing a phone number raises nothing. A notice nobody needs is
 * how a notification bell stops being read, and this CRM already carries roughly
 * 35,590 SALES_ORDER_CREATED rows as a standing reminder of what happens when
 * every event becomes a notice.
 *
 * ### Failures never fail the write
 *
 * Every function here swallows its own errors. The employee record is what
 * matters; if the notice cannot be raised, the HR change still stands and the
 * person sees it in the directory regardless. This mirrors `post-sales.notify.ts`
 * and the audit service, both of which take the same position for the same reason.
 */

import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { deliver, persist } from '../notification/notification.service.js';

/** Where a notice points. Stored, so an old notice survives a routing change. */
const employeeHref = (employeeId: string): string => `/hr/employees/${employeeId}`;

type Kind =
  | 'HR_EMPLOYEE_ASSIGNED_TO_MANAGER'
  | 'HR_EMPLOYEE_ACCOUNT_LINKED'
  | 'HR_EMPLOYEE_STATUS_CHANGED';

async function raise(
  recipientIds: string[],
  type: Kind,
  employeeId: string,
  title: string,
  body: string,
): Promise<void> {
  const unique = [...new Set(recipientIds)];
  if (unique.length === 0) return;

  try {
    await prisma.$transaction((tx) =>
      persist(tx, unique, {
        type,
        title,
        body,
        href: employeeHref(employeeId),
        entityType: 'Employee',
        entityId: employeeId,
      }),
    );
    await deliver(unique, type, employeeId);
  } catch (error) {
    logger.error({ err: error, type, employeeId }, 'Failed to raise HR notification');
  }
}

/**
 * A manager gained a report.
 *
 * Worth a notice because a manager cannot otherwise discover it — nothing prompts
 * them to re-read their team list, and somebody joining their team changes what
 * they are accountable for.
 *
 * The employee's name is deliberately absent from the body: the profile is one
 * click away and carries everything, while a name in a notification row is
 * personal data sitting in a table with a 30-day retention and no access control
 * beyond the recipient.
 */
export async function notifyHrEmployeeAssignedToManager(
  managerUserId: string,
  employeeId: string,
): Promise<void> {
  await raise(
    [managerUserId],
    'HR_EMPLOYEE_ASSIGNED_TO_MANAGER',
    employeeId,
    'New team member',
    'Someone has been added to your team',
  );
}

/**
 * Somebody's CRM account was tied to their HR record.
 *
 * Addressed to the account holder, not to HR: it is the account holder who gains
 * something, and it is the one event in this module that a person would want to
 * know happened to their own login. It grants no access by itself — linking
 * records a correspondence between two rows, and permissions stay exactly where
 * they were.
 */
export async function notifyHrEmployeeAccountLinked(
  userId: string,
  employeeId: string,
): Promise<void> {
  await raise(
    [userId],
    'HR_EMPLOYEE_ACCOUNT_LINKED',
    employeeId,
    'Account linked to your employee record',
    'Your CRM account is now linked to your HR profile',
  );
}

/**
 * Somebody a manager manages changed employment status.
 *
 * Raised to the manager because a report going on notice or leaving changes what
 * they can plan, and nothing else would tell them in time.
 *
 * The status itself is not in the body. "Left the company" or "is on notice"
 * sitting in a notification row is somebody's employment circumstance in a table
 * the recipient's colleagues could see over their shoulder; the profile says it
 * to whoever is entitled to read it.
 */
export async function notifyHrEmployeeStatusChanged(
  managerUserId: string,
  employeeId: string,
): Promise<void> {
  await raise(
    [managerUserId],
    'HR_EMPLOYEE_STATUS_CHANGED',
    employeeId,
    'Team member status changed',
    'Someone on your team has had their employment status updated',
  );
}
