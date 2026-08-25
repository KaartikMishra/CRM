import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/common/page-header';
import { getCurrentUser } from '@/lib/current-user';
import { fetchEnquiries } from '@/lib/enquiry-api';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Deliberately thin (§67): a way in to the one module that works, plus counts
 * drawn from real API calls. No invented metrics, no charts of nothing — the
 * Leader Dashboard is a later phase with its own requirements.
 */
export default async function DashboardPage() {
  const user = await getCurrentUser();

  const [open, mine] = await Promise.all([
    fetchEnquiries({ status: 'OPEN', limit: '25' }),
    user ? fetchEnquiries({ assignedToId: user.id, status: 'OPEN', limit: '25' }) : null,
  ]);

  const openCount = open.result.success ? open.result.data.enquiries.length : null;
  const mineCount = mine?.result.success ? mine.result.data.enquiries.length : null;
  const overdue = open.result.success
    ? open.result.data.enquiries.filter((e) => e.sla.breached).length
    : null;

  const stats = [
    { label: 'Open enquiries', value: openCount, href: '/product-enquiry?status=OPEN' },
    {
      label: 'Assigned to you',
      value: mineCount,
      href: user ? `/product-enquiry?status=OPEN&assignedToId=${user.id}` : '/product-enquiry',
    },
    { label: 'Past deadline', value: overdue, href: '/product-enquiry?status=OPEN' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`Welcome back, ${user?.name.split(' ')[0] ?? ''}`}
        title="Dashboard"
        description="Product Enquiry is live. The remaining CRM modules arrive in later phases."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted">{stat.label}</p>
              <p className="mt-2 font-mono text-3xl font-medium text-ink tabular">
                {stat.value ?? '—'}
              </p>
              <Link
                href={stat.href}
                className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                View <ArrowRight className="size-3" />
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="size-4 text-accent" />
              Product Enquiry
            </CardTitle>
            <CardDescription className="mt-1">
              Record customer requests, gather vendor options, and respond within fifteen minutes.
            </CardDescription>
          </div>
          <Badge variant="positive">Live</Badge>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/product-enquiry">
              Open module
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
