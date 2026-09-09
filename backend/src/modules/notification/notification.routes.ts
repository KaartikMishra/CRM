/**
 * Notification routes.
 *
 * Guarded by requireAuth and nothing else. Notifications are not a CRM module,
 * so there is no module permission to check: everybody has their own, and the
 * handlers scope every query to the caller. Module permissions decide who
 * *receives* a notice, not who may read their own.
 */

import { Router } from 'express';
import { notificationIdParamSchema, notificationListQuerySchema } from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './notification.controller.js';

export const notificationRoutes = Router();

notificationRoutes.use(requireAuth);

notificationRoutes.get(
  '/',
  validate({ query: notificationListQuerySchema }),
  controller.list,
);

notificationRoutes.get('/unread-count', controller.unreadCount);

/** The short-lived credential that opens a socket. POST: it mints state. */
notificationRoutes.post('/socket-ticket', controller.socketTicket);

notificationRoutes.post('/read-all', controller.markAllRead);

/** Clear All — hides, never deletes. */
notificationRoutes.post('/dismiss-all', controller.dismissAll);

/** Declared last so the literal paths above are not read as ids. */
notificationRoutes.patch(
  '/:id/read',
  validate({ params: notificationIdParamSchema }),
  controller.markRead,
);
