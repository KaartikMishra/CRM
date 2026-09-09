'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck, PackageSearch } from 'lucide-react';
import type { NotificationView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useNotifications } from './notification-provider';

/** How many fit in the dropdown before "View all" earns its place. */
const VISIBLE = 8;

/**
 * Relative time, to the nearest sensible unit.
 *
 * Rendered client-side only, inside a component that already requires JS —
 * formatting this on the server would bake in the moment of the render and be
 * wrong by the time anyone read it.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** The coloured dot: which module the notice came from. */
function TypeDot({ type }: { type: NotificationView['type'] }) {
  const tone = type === 'SALES_ORDER_CREATED' ? 'bg-warning' : 'bg-accent';
  return <span className={`mt-1.5 size-2 shrink-0 rounded-full ${tone}`} aria-hidden />;
}

export function NotificationBell() {
  const router = useRouter();
  const { notifications, unreadCount, markRead, markAllRead, dismissAll } = useNotifications();
  const visible = notifications.slice(0, VISIBLE);

  function open(notification: NotificationView): void {
    if (!notification.readAt) markRead(notification.id);
    router.push(notification.href);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative rounded-md p-2 transition-colors hover:bg-surface-2"
          aria-label={
            unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
          }
        >
          <Bell className="size-5 text-ink-2" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-critical px-1 text-[10px] font-medium leading-4 text-white tabular">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80 p-0 sm:w-96">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-sm font-medium text-ink">Notifications</span>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <Button variant="ghost" size="sm" onClick={markAllRead} title="Mark all as read">
                <CheckCheck className="size-3.5" />
              </Button>
            )}
            {notifications.length > 0 && (
              <Button variant="ghost" size="sm" onClick={dismissAll}>
                Clear all
              </Button>
            )}
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="flex items-center gap-3 px-3 py-8 text-sm text-muted">
            <PackageSearch className="size-4 shrink-0" />
            Nothing new. Assignments and new orders will appear here.
          </div>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {visible.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => open(n)}
                  className={`flex w-full gap-2.5 border-b border-line px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-surface-2 ${
                    n.readAt ? '' : 'bg-surface-2/60'
                  }`}
                >
                  <TypeDot type={n.type} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{n.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-ink-2">{n.body}</span>
                    <span className="mt-1 block text-[11px] text-muted">
                      {relativeTime(n.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-line px-3 py-2 text-right">
          <Link href="/notifications" className="text-xs text-muted transition-colors hover:text-ink">
            View all
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
