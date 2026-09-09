import type { Metadata } from 'next';
import { BellOff } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { fetchNotifications } from '@/lib/notification-api';
import { NotificationList } from '@/components/notifications/notification-list';

export const metadata: Metadata = { title: 'Notifications' };

/**
 * The full history, for when the dropdown's recent few are not enough.
 *
 * Server-rendered from the database rather than from the provider's live list:
 * this page is the record, and it should read the same whether or not a socket
 * happens to be connected.
 */
export default async function NotificationsPage() {
  const page = await fetchNotifications(50);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Activity"
        title="Notifications"
        description="Assignments and orders that were sent to you."
      />

      {page.notifications.length === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-3 p-5 text-sm text-muted">
            <BellOff className="size-4 shrink-0" />
            Nothing here yet. New enquiry assignments and sales orders will appear as they happen.
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <NotificationList notifications={page.notifications} />
        </Card>
      )}
    </div>
  );
}
