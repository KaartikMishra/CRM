import type { NotificationPage } from '@rs/shared';
import { apiFetch } from './api-server';

/**
 * Server-side notification readers.
 *
 * Matches `procurement-api.ts`: the shape comes from @rs/shared so the two
 * tiers cannot drift, and a failure returns an empty page rather than throwing
 * — a bell that cannot load must not take the whole layout down with it.
 */
export async function fetchNotifications(limit = 20): Promise<NotificationPage> {
  const result = await apiFetch<NotificationPage>(`/api/notifications?limit=${limit}`);
  return result.success
    ? result.data
    : { notifications: [], nextCursor: null, unreadCount: 0 };
}
