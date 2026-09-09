/**
 * Notification reads and writes.
 *
 * Every query here is scoped by `recipientId`, and that parameter always comes
 * from the authenticated session rather than the request body — a caller who
 * could name a recipient could read or clear somebody else's notices.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

export const notificationSelect = {
  id: true,
  type: true,
  title: true,
  body: true,
  href: true,
  entityType: true,
  entityId: true,
  readAt: true,
  createdAt: true,
} as const;

/**
 * One page of a person's undismissed notices, newest first.
 *
 * Fetches one more row than asked for: the extra row is not returned, it only
 * answers "is there another page" without a second count query.
 */
export async function findForRecipient(
  recipientId: string,
  limit: number,
  cursor?: string,
) {
  return prisma.notification.findMany({
    where: { recipientId, dismissedAt: null },
    select: notificationSelect,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** What the badge shows: unread, undismissed, this person only. */
export function countUnread(recipientId: string): Promise<number> {
  return prisma.notification.count({
    where: { recipientId, dismissedAt: null, readAt: null },
  });
}

/**
 * Writes several notices as part of an existing transaction.
 *
 * Takes a `tx` rather than the global client on purpose: the notice must
 * commit with the business change that caused it, so a rolled-back order
 * cannot leave someone told about an order that does not exist.
 *
 * `skipDuplicates` makes a retried request idempotent against the unique index
 * on (recipient, type, entity) instead of failing the whole transaction.
 */
export function createMany(
  tx: Prisma.TransactionClient,
  rows: Prisma.NotificationCreateManyInput[],
) {
  return tx.notification.createMany({ data: rows, skipDuplicates: true });
}

/**
 * Reads back what was just written, so the socket can deliver real rows.
 *
 * Runs after commit. `createMany` returns only a count, and the socket payload
 * needs ids and timestamps the database assigned.
 */
export function findByEntity(
  recipientIds: string[],
  type: Prisma.NotificationCreateManyInput['type'],
  entityId: string,
) {
  return prisma.notification.findMany({
    where: { recipientId: { in: recipientIds }, type, entityId },
    select: { ...notificationSelect, recipientId: true },
  });
}

/** Marks one notice read, but only if it belongs to this person. */
export function markRead(recipientId: string, id: string) {
  return prisma.notification.updateMany({
    where: { id, recipientId, readAt: null },
    data: { readAt: new Date() },
  });
}

export function markAllRead(recipientId: string) {
  return prisma.notification.updateMany({
    where: { recipientId, readAt: null, dismissedAt: null },
    data: { readAt: new Date() },
  });
}

/**
 * Clear All — hides, never deletes.
 *
 * A cleared notice keeps its row so the history stays auditable and a
 * mis-click costs nothing; retention removes it later on age alone.
 */
export function dismissAll(recipientId: string) {
  return prisma.notification.updateMany({
    where: { recipientId, dismissedAt: null },
    data: { dismissedAt: new Date() },
  });
}

/** Retention: drop notices older than the cutoff, for every recipient. */
export function deleteOlderThan(cutoff: Date) {
  return prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
}
