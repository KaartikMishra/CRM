'use server';

import type { NotificationPage, SocketTicket } from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * Notification mutations, as server actions.
 *
 * The same shape as the procurement actions: the session token never leaves
 * the server, and each action relays the backend's answer verbatim.
 *
 * Nothing here names a recipient. The backend takes it from the session, so a
 * caller cannot read, mark or clear somebody else's notices however the call
 * is crafted.
 */

export type NotificationActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string };

async function call<T>(path: string, init: RequestInit): Promise<NotificationActionResult<T>> {
  const result = await apiFetch<T>(path, init);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, message: result.message, ...(result.code ? { code: result.code } : {}) };
}

export async function listNotificationsAction(
  limit = 20,
): Promise<NotificationActionResult<NotificationPage>> {
  return call(`/api/notifications?limit=${limit}`, { method: 'GET' });
}

/**
 * Mints the socket credential.
 *
 * The session token can never reach the browser, so the client gets a
 * thirty-second, single-use ticket that opens a socket and does nothing else.
 */
export async function socketTicketAction(): Promise<NotificationActionResult<SocketTicket>> {
  return call('/api/notifications/socket-ticket', { method: 'POST' });
}

export async function markReadAction(
  id: string,
): Promise<NotificationActionResult<{ ok: boolean }>> {
  return call(`/api/notifications/${id}/read`, { method: 'PATCH' });
}

export async function markAllReadAction(): Promise<NotificationActionResult<{ updated: number }>> {
  return call('/api/notifications/read-all', { method: 'POST' });
}

/** Clear All — hides them; the rows survive until retention removes them. */
export async function dismissAllAction(): Promise<NotificationActionResult<{ dismissed: number }>> {
  return call('/api/notifications/dismiss-all', { method: 'POST' });
}
