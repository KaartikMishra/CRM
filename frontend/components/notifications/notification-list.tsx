'use client';

import { useRouter } from 'next/navigation';
import type { NotificationView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { useNotifications } from './notification-provider';
import { relativeTime } from './notification-bell';

/**
 * The full list.
 *
 * Rows come from the server, but reading one goes through the provider so the
 * bell's badge drops at the same moment — two views of one state, not two
 * copies of it.
 */
export function NotificationList({ notifications }: { notifications: NotificationView[] }) {
  const router = useRouter();
  const { markRead } = useNotifications();

  return (
    <ul>
      {notifications.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={() => {
              if (!n.readAt) markRead(n.id);
              router.push(n.href);
            }}
            className="flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors last:border-0 hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">{n.title}</span>
                {!n.readAt && <Badge variant="accent">New</Badge>}
              </span>
              <span className="mt-0.5 block truncate text-sm text-ink-2">{n.body}</span>
            </span>
            <span className="shrink-0 text-xs text-muted">{relativeTime(n.createdAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
