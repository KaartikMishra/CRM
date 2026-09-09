import { z } from 'zod';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Reading one's own notifications.
 *
 * There is deliberately no `recipientId` here. The recipient is always the
 * authenticated user, taken from the session — a client that could name a
 * recipient could read somebody else's mail.
 */
export const notificationListQuerySchema = paginationSchema;

/** Marking one notice read. The id is checked against the caller server-side. */
export const notificationIdParamSchema = z.object({ id: cuidSchema });

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
