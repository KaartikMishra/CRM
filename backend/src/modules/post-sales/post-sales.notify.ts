/**
 * The three notices Post Sales raises.
 *
 * A thin layer over the existing notification service — no second notification
 * system, no second WebSocket, no second retention policy. `persist` writes the
 * rows inside a transaction and `deliver` pushes them to whoever is connected,
 * exactly as Procurement and Dispatch already do.
 *
 * ### Why only three
 *
 * The bell groups by type, and a notice per field edit would be spam. These are
 * the three events somebody genuinely needs pushed at them:
 *
 *   - **assigned** — a case is now your work
 *   - **critical/high** — a case was raised that somebody senior should see
 *   - **reopened** — a case you had finished has come back
 *
 * A status move to AWAITING_VENDOR, a priority nudge from LOW to MEDIUM, a new
 * note: all of those are visible on the case and in the audit trail, and pushing
 * them would train people to ignore the bell.
 *
 * ### Why each call is its own transaction
 *
 * Every one of these runs **after** the case write has committed. A notice about a
 * case that failed to save would be a notice about nothing, and holding a database
 * transaction open across a WebSocket write would make a slow socket a slow
 * database. The notice is durable the moment `persist` commits; delivery is
 * best-effort on top of that, and `deliver` already swallows and logs its own
 * failures.
 */

import type { PostSalesPriority } from '@rs/shared';
import { POST_SALES_PRIORITY_LABELS } from '@rs/shared';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { usersWithPermission } from '../../services/permission.service.js';
import { deliver, persist } from '../notification/notification.service.js';

/** Where a notice points. Stored, so an old notice survives a routing change. */
const caseHref = (caseId: string): string => `/post-sales/${caseId}`;

type Kind =
  | 'POST_SALES_CASE_ASSIGNED'
  | 'POST_SALES_CASE_CRITICAL'
  | 'POST_SALES_CASE_REOPENED';

/**
 * Writes and pushes one notice.
 *
 * Failures are logged and swallowed. A notification that could not be raised must
 * never fail the case write that prompted it — the case is the record that
 * matters, and the person will see it on the board regardless.
 */
async function raise(
  recipientIds: string[],
  type: Kind,
  caseId: string,
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
        href: caseHref(caseId),
        entityType: 'PostSalesCase',
        entityId: caseId,
      }),
    );
    await deliver(unique, type, caseId);
  } catch (error) {
    logger.error({ err: error, type, caseId }, 'Failed to raise post-sales notification');
  }
}

/** A case became somebody's work. Never raised for a self-assignment. */
export async function notifyCaseAssigned(
  caseId: string,
  caseNumber: string,
  assigneeId: string,
  actor: AuthenticatedUser,
): Promise<void> {
  await raise(
    [assigneeId],
    'POST_SALES_CASE_ASSIGNED',
    caseId,
    `Case ${caseNumber} assigned to you`,
    `${actor.name} assigned you this post-sales case.`,
  );
}

/**
 * A case was raised, or escalated, at a priority somebody senior should see.
 *
 * Goes to everyone who may manage the module — resolved through the existing
 * permission rules rather than a hard-coded list, so a grant or revocation changes
 * who is told without a code change. The actor is excluded: telling somebody what
 * they just did is noise.
 */
export async function notifyCriticalCase(
  caseId: string,
  caseNumber: string,
  priority: PostSalesPriority,
  actor: AuthenticatedUser,
): Promise<void> {
  const managers = await usersWithPermission('POST_SALES', 'ASSIGN');
  const recipients = managers.map((u) => u.id).filter((id) => id !== actor.id);

  await raise(
    recipients,
    'POST_SALES_CASE_CRITICAL',
    caseId,
    `${POST_SALES_PRIORITY_LABELS[priority]} priority case ${caseNumber}`,
    `${actor.name} raised a ${POST_SALES_PRIORITY_LABELS[priority].toLowerCase()} priority post-sales case.`,
  );
}

/** A finished case has come back. The person who owned it needs to know. */
export async function notifyCaseReopened(
  caseId: string,
  caseNumber: string,
  assigneeId: string,
  actor: AuthenticatedUser,
): Promise<void> {
  if (assigneeId === actor.id) return;

  await raise(
    [assigneeId],
    'POST_SALES_CASE_REOPENED',
    caseId,
    `Case ${caseNumber} reopened`,
    `${actor.name} reopened this post-sales case.`,
  );
}
