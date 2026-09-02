import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, ClipboardList, ShieldOff, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { getCurrentUser } from '@/lib/current-user';
import { hasModule } from '@/lib/module-access';
import { fetchEnquiries } from '@/lib/enquiry-api';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Deliberately thin (§67): a way in to the modules that work, plus counts drawn
 * from real API calls. No invented metrics, no charts of nothing — the Leader
 * Dashboard is a later phase with its own requirements.
 *
 * §11 — what is shown follows the same resolved permissions the sidebar uses.
 * Someone without Product Enquiry access is not shown enquiry counts, and the
 * API is not asked for them: the request would be refused, and a row of dashes
 * would be a worse answer than not asking.
 */
export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const canEnquiry = hasModule(user, 'PRODUCT_ENQUIRY');
  const canSales = hasModule(user, 'SALES');

  const [open, mine] = await Promise.all([
    canEnquiry ? fetchEnquiries({ status: 'OPEN', limit: '25' }) : null,
    canEnquiry ? fetchEnquiries({ assignedToId: user.id, status: 'OPEN', limit: '25' }) : null,
  ]);

  const openCount = open?.result.success ? open.result.data.enquiries.length : null;
  const mineCount = mine?.result.success ? mine.result.data.enquiries.length : null;
  const overdue = open?.result.success
    ? open.result.data.enquiries.filter((e) => e.sla.breached).length
    : null;

  const stats = [
    { label: 'Open enquiries', value: openCount, href: '/product-enquiry?status=OPEN' },
    {
      label: 'Assigned to you',
      value: mineCount,
      href: `/product-enquiry?status=OPEN&assignedToId=${user.id}`,
    },
    { label: 'Past deadline', value: overdue, href: '/product-enquiry?status=OPEN' },
  ];

  const modules = [
    {
      show: canEnquiry,
      href: '/product-enquiry',
      icon: ClipboardList,
      title: 'Product Enquiry',
      description:
        'Record customer requests, gather vendor options, and respond within fifteen minutes.',
    },
    {
      show: canSales,
      href: '/sales',
      icon: ShoppingCart,
      title: 'Sales',
      description:
        'Track orders from placement through dispatch, with payments and their settlement.',
    },
  ].filter((m) => m.show);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`Welcome back, ${user.name.split(' ')[0] ?? ''}`}
        title="Dashboard"
        description="The CRM modules you have access to. The rest arrive in later phases."
      />

      {canEnquiry && (
        <div className="grid gap-4 sm:grid-cols-3">
          {stats.map((stat) => (
            <Card key={stat.label}>
              <CardContent className="p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-muted">
                  {stat.label}
                </p>
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
      )}

      {modules.length === 0 ? (
        <Card>
          <EmptyState
            icon={ShieldOff}
            title="No modules yet"
            description="Your account is active but has no CRM modules assigned. Ask an administrator to grant access from User Management."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {modules.map((module) => {
            const Icon = module.icon;
            return (
              <Card key={module.href}>
                <CardHeader className="flex-row items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Icon className="size-4 text-accent" />
                      {module.title}
                    </CardTitle>
                    <CardDescription className="mt-1">{module.description}</CardDescription>
                  </div>
                  <Badge variant="positive">Live</Badge>
                </CardHeader>
                <CardContent>
                  <Button asChild variant="outline">
                    <Link href={module.href}>
                      Open module
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
