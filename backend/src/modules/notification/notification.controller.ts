import type { Request, Response } from 'express';
import type { NotificationListQuery, SocketTicket } from '@rs/shared';
import { sendSuccess } from '../../utils/apiResponse.js';
import { validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import { mintTicket, TICKET_TTL_SECONDS } from '../../realtime/ticket.js';
import * as service from './notification.service.js';

/**
 * Every handler takes its recipient from the session, never from the request.
 * There is no route here that accepts a user id.
 */

export async function list(req: Request, res: Response): Promise<void> {
  const { limit, cursor } = validatedQuery<NotificationListQuery>(req);
  sendSuccess(res, await service.list(currentUser(req).id, limit, cursor));
}

export async function unreadCount(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { unreadCount: await service.unreadCount(currentUser(req).id) });
}

/**
 * Mints the socket credential.
 *
 * Reached only through requireAuth, so the session has already been verified
 * and the user re-checked against the database before anything is signed.
 */
export async function socketTicket(req: Request, res: Response): Promise<void> {
  const ticket: SocketTicket = {
    ticket: await mintTicket(currentUser(req).id),
    expiresInSeconds: TICKET_TTL_SECONDS,
  };
  sendSuccess(res, ticket);
}

export async function markRead(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  await service.markRead(currentUser(req).id, id);
  sendSuccess(res, { ok: true });
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { updated: await service.markAllRead(currentUser(req).id) });
}

export async function dismissAll(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { dismissed: await service.dismissAll(currentUser(req).id) });
}
