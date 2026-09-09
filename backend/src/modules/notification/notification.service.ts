/**
 * Raising and reading notifications.
 *
 * Two rules shape everything here.
 *
 * The row is written *inside* the transaction that caused it, so a rolled-back
 * order cannot leave somebody told about an order that never existed. The
 * socket is fired *after* that transaction commits, so a socket failure can
 * never fail the business operation — the row is already durable and the
 * client will fetch it regardless.
 *
 * Delivery therefore follows `recordAudit`'s contract: log and swallow, never
 * rethrow. A notice nobody could be told about in real time is still a notice.
 */

import type { Prisma } from '@prisma/client';
import type { NotificationPage, NotificationView } from '@rs/shared';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/AppError.js';
import { usersWithPermission } from '../../services/permission.service.js';
import { publishToUser } from '../../realtime/registry.js';
import * as repo from './notification.repository.js';

/** How long a notice survives before retention removes it. */
const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

type Row = Awaited<ReturnType<typeof repo.findForRecipient>>[number];

function toView(row: Row): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    href: row.href,
    entityType: row.entityType,
    entityId: row.entityId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
//  Reading — always scoped to the caller
// ---------------------------------------------------------------------------

export async function list(
  recipientId: string,
  limit: number,
  cursor?: string,
): Promise<NotificationPage> {
  const [rows, unreadCount] = await Promise.all([
    repo.findForRecipient(recipientId, limit, cursor),
    repo.countUnread(recipientId),
  ]);

  // One row beyond the page was fetched only to answer "is there more".
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    notifications: page.map(toView),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    unreadCount,
  };
}

export function unreadCount(recipientId: string): Promise<number> {
  return repo.countUnread(recipientId);
}

/**
 * Marks one notice read.
 *
 * The update is scoped by recipient, so naming somebody else's notice changes
 * nothing — and a zero count is reported as not-found rather than as success,
 * so the caller cannot use this to probe which ids exist.
 */
export async function markRead(recipientId: string, id: string): Promise<void> {
  const { count } = await repo.markRead(recipientId, id);
  if (count === 0) {
    // Already read is not an error; a missing or someone else's row is.
    const exists = await prisma.notification.findFirst({
      where: { id, recipientId },
      select: { id: true },
    });
    if (!exists) {
      throw AppError.notFound('NOTIFICATION_NOT_FOUND', 'That notification could not be found.');
    }
  }
}

export async function markAllRead(recipientId: string): Promise<number> {
  return (await repo.markAllRead(recipientId)).count;
}

export async function dismissAll(recipientId: string): Promise<number> {
  return (await repo.dismissAll(recipientId)).count;
}

// ---------------------------------------------------------------------------
//  Raising — persist inside the transaction, deliver after it commits
// ---------------------------------------------------------------------------

type Draft = {
  type: Prisma.NotificationCreateManyInput['type'];
  title: string;
  body: string;
  href: string;
  entityType: string;
  entityId: string;
};

/**
 * Queues notices for several recipients inside the caller's transaction.
 *
 * Returns nothing useful on purpose: the ids do not exist in a form worth
 * reading until the transaction commits, and the caller should hand the same
 * recipients to `deliver` afterwards rather than trying to thread rows through.
 */
export async function persist(
  tx: Prisma.TransactionClient,
  recipientIds: string[],
  draft: Draft,
): Promise<void> {
  if (recipientIds.length === 0) return;
  await repo.createMany(
    tx,
    recipientIds.map((recipientId) => ({ recipientId, ...draft })),
  );
}

/**
 * Sends what was persisted, to whoever is currently connected.
 *
 * Called only after the transaction has committed. Every failure is logged and
 * swallowed: the notice is already in the database, so the worst case is that
 * the recipient sees it on their next fetch instead of instantly.
 */
export async function deliver(
  recipientIds: string[],
  type: Draft['type'],
  entityId: string,
): Promise<void> {
  if (recipientIds.length === 0) return;
  try {
    const rows = await repo.findByEntity(recipientIds, type, entityId);
    for (const row of rows) {
      publishToUser(row.recipientId, { type: 'notification', data: toView(row) });
    }
  } catch (error) {
    logger.error({ err: error, type, entityId }, 'Failed to deliver notification');
  }
}

// ---------------------------------------------------------------------------
//  The two events this version raises
// ---------------------------------------------------------------------------

/** Everyone who could act on a new order, from the existing permission rules. */
export async function procurementRecipients(): Promise<string[]> {
  const users = await usersWithPermission('PROCUREMENT', 'VIEW');
  return users.map((u) => u.id);
}

/**
 * The enquiry number is the whole body on purpose.
 *
 * The customer's name would have to be fetched inside the creation
 * transaction, widening a query that already selects exactly what it needs.
 * The number identifies the enquiry, and the detail page one click away shows
 * everything else.
 */
export const enquiryAssignedDraft = (enquiryNo: string, enquiryId: string): Draft => ({
  type: 'ENQUIRY_ASSIGNED',
  title: 'New enquiry assigned',
  body: `${enquiryNo} has been assigned to you`,
  href: `/product-enquiry/${enquiryId}`,
  entityType: 'ProductEnquiry',
  entityId: enquiryId,
});

/**
 * The order number and what it is for.
 *
 * The customer's name is deliberately absent: fetching it would widen the
 * creation transaction's queries, and procurement acts on the product and
 * quantity. The order page one click away carries the rest.
 */
export const salesOrderCreatedDraft = (
  orderNumber: string,
  summary: string,
  orderId: string,
): Draft => ({
  type: 'SALES_ORDER_CREATED',
  title: 'New sales order',
  body: `${orderNumber} · ${summary}`,
  href: `/sales/${orderId}`,
  entityType: 'SalesOrder',
  entityId: orderId,
});

// ---------------------------------------------------------------------------
//  Retention
// ---------------------------------------------------------------------------

/**
 * Drops notices past their keep-window.
 *
 * Age alone decides — not read or dismissed state — so nothing lingers because
 * somebody never opened their bell. Failures are logged rather than thrown:
 * this runs on a timer with no request to fail.
 */
export async function purgeExpired(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS);
    const { count } = await repo.deleteOlderThan(cutoff);
    if (count > 0) logger.info({ count, cutoff }, 'Purged expired notifications');
    return count;
  } catch (error) {
    logger.error({ err: error }, 'Notification retention sweep failed');
    return 0;
  }
}
