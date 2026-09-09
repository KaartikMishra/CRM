'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { NotificationView, SocketMessage } from '@rs/shared';
import {
  dismissAllAction,
  listNotificationsAction,
  markAllReadAction,
  markReadAction,
  socketTicketAction,
} from '@/app/(app)/notifications/actions';

/**
 * The one place notification state lives.
 *
 * A context rather than a store library: there is exactly one consumer tree
 * (the bell and its dropdown), one socket to share, and one list to keep in
 * step. Adding Zustand or Redux for that would be more machinery than state.
 *
 * The database is the source of truth throughout. The socket only makes
 * arrivals immediate — everything it delivers is already persisted, so a
 * dropped connection costs latency, never a notification.
 */

type NotificationState = {
  notifications: NotificationView[];
  unreadCount: number;
  connected: boolean;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismissAll: () => void;
};

const NotificationContext = createContext<NotificationState | null>(null);

export function useNotifications(): NotificationState {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used inside NotificationProvider');
  return ctx;
}

/** Backoff between reconnect attempts: quick at first, then patient. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export function retryDelay(attempt: number): number {
  const exponential = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  // Jitter, so many tabs reconnecting after one outage do not arrive together.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/**
 * Merges an arriving notification into the list.
 *
 * Keyed by id, because the same row legitimately arrives twice: once over the
 * socket, and again in the refetch that follows a reconnect. Newest first.
 */
export function mergeNotification(
  list: NotificationView[],
  incoming: NotificationView,
): NotificationView[] {
  if (list.some((n) => n.id === incoming.id)) return list;
  return [incoming, ...list];
}

export function NotificationProvider({
  wsUrl,
  children,
}: {
  /** Where the socket lives. Empty disables realtime and leaves fetching intact. */
  wsUrl: string;
  children: React.ReactNode;
}) {
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);

  /** Replaces the list from the database — the authoritative view. */
  const refresh = useCallback(async () => {
    const result = await listNotificationsAction();
    if (result.ok) {
      setNotifications(result.data.notifications);
      setUnreadCount(result.data.unreadCount);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Socket lifecycle. Re-run only if the URL changes, so a re-render never
  // tears down a healthy connection.
  useEffect(() => {
    if (!wsUrl) return;
    closedRef.current = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (closedRef.current) return;

      // A fresh ticket per attempt: they are single-use, so a reconnect can
      // never replay the one that opened the previous socket.
      const ticket = await socketTicketAction();
      if (!ticket.ok || closedRef.current) {
        scheduleRetry();
        return;
      }

      const socket = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
        // Anything that arrived while disconnected is in the database, not in
        // any socket buffer — so the reconnect is what actually recovers it.
        void refresh();
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as SocketMessage;
          if (message.type !== 'notification') return;
          setNotifications((list) => mergeNotification(list, message.data));
          setUnreadCount((n) => n + 1);
        } catch {
          // A frame we cannot parse is ignored rather than allowed to throw
          // inside the socket handler and kill the connection.
        }
      };

      socket.onclose = () => {
        setConnected(false);
        socketRef.current = null;
        scheduleRetry();
      };

      // onerror is followed by onclose, which owns the retry.
      socket.onerror = () => socket.close();
    };

    const scheduleRetry = (): void => {
      if (closedRef.current) return;
      const delay = retryDelay(attemptRef.current);
      attemptRef.current += 1;
      retryTimer = setTimeout(() => void connect(), delay);
    };

    void connect();

    return () => {
      closedRef.current = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [wsUrl, refresh]);

  /*
    Optimistic, with the server as the arbiter. The badge moves immediately
    because waiting on a round trip to acknowledge a click feels broken; if the
    call fails, the refresh puts the truth back.
  */
  const markRead = useCallback((id: string) => {
    setNotifications((list) =>
      list.map((n) => (n.id === id || n.readAt ? n : { ...n, readAt: new Date().toISOString() })),
    );
    setUnreadCount((n) => Math.max(0, n - 1));
    void markReadAction(id).then((r) => {
      if (!r.ok) void refresh();
    });
  }, [refresh]);

  const markAllRead = useCallback(() => {
    const at = new Date().toISOString();
    setNotifications((list) => list.map((n) => (n.readAt ? n : { ...n, readAt: at })));
    setUnreadCount(0);
    void markAllReadAction().then((r) => {
      if (!r.ok) void refresh();
    });
  }, [refresh]);

  const dismissAll = useCallback(() => {
    setNotifications([]);
    setUnreadCount(0);
    void dismissAllAction().then((r) => {
      if (!r.ok) void refresh();
    });
  }, [refresh]);

  const value = useMemo<NotificationState>(
    () => ({ notifications, unreadCount, connected, markRead, markAllRead, dismissAll }),
    [notifications, unreadCount, connected, markRead, markAllRead, dismissAll],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}
