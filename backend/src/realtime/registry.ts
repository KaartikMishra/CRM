/**
 * Who is currently connected, and how to reach them.
 *
 * One user may hold several sockets at once — a second browser tab is a second
 * connection, not a replacement for the first — so the registry maps a user to
 * a *set* of sockets and writes to every one of them. Nothing coordinates the
 * tabs; each simply receives the same message.
 *
 * State is process-local, which is correct while the backend runs as a single
 * process. A second instance would need the fan-out to cross processes
 * (Redis pub/sub); until then a Map is both smaller and faster than anything
 * that could replace it.
 */

import type { WebSocket } from 'ws';
import type { SocketMessage } from '@rs/shared';
import { logger } from '../config/logger.js';

const connections = new Map<string, Set<WebSocket>>();

export function register(userId: string, socket: WebSocket): void {
  const existing = connections.get(userId);
  if (existing) existing.add(socket);
  else connections.set(userId, new Set([socket]));
}

/**
 * Removes one socket, and the user's entry once their last socket is gone.
 *
 * Dropping the empty set matters: without it the map would grow by one entry
 * per user who has ever connected and never shrink.
 */
export function unregister(userId: string, socket: WebSocket): void {
  const sockets = connections.get(userId);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) connections.delete(userId);
}

/**
 * Sends to every socket this user currently holds.
 *
 * A send that throws is logged and skipped rather than allowed to abort the
 * loop — one dead tab must not stop the person's other tabs being told.
 */
export function publishToUser(userId: string, message: SocketMessage): void {
  const sockets = connections.get(userId);
  if (!sockets || sockets.size === 0) return;

  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    try {
      // 1 === OPEN. Compared numerically so this module needs no runtime
      // import of ws purely for a constant.
      if (socket.readyState === 1) socket.send(payload);
    } catch (error) {
      logger.warn({ err: error, userId }, 'Failed to write to a notification socket');
    }
  }
}

/** Test and shutdown helpers. */
export const connectionCount = (userId: string): number => connections.get(userId)?.size ?? 0;
export const totalConnections = (): number =>
  [...connections.values()].reduce((sum, set) => sum + set.size, 0);
export function closeAll(): void {
  for (const sockets of connections.values()) {
    for (const socket of sockets) socket.close(1001, 'Server shutting down');
  }
  connections.clear();
}
