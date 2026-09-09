import type { NotificationType } from '../enums.js';

/**
 * One notice as the bell renders it.
 *
 * `href` is stored on the row rather than rebuilt from `type` and `entityId`,
 * so a notice raised months ago still links somewhere sensible after the
 * routes around it have moved on.
 */
export type NotificationView = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  href: string;
  entityType: string;
  entityId: string;
  /** Null until the recipient has seen it. */
  readAt: string | null;
  createdAt: string;
};

/** A page of notices, using the same cursor convention as the other lists. */
export type NotificationPage = {
  notifications: NotificationView[];
  nextCursor: string | null;
  /** Unread and undismissed — what the badge shows. */
  unreadCount: number;
};

/** The single-use credential that opens a socket. Never the session token. */
export type SocketTicket = {
  ticket: string;
  /** Seconds until it expires, so the client can retry rather than guess. */
  expiresInSeconds: number;
};

/**
 * What the server sends down the socket.
 *
 * Server → client only. A client that could publish could address a notice to
 * somebody else, so the socket accepts nothing but pong frames.
 */
export type SocketMessage =
  | { type: 'notification'; data: NotificationView }
  | { type: 'ping' };
