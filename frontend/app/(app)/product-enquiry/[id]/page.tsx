import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { EfficiencyBadge, StatusBadge } from '@/components/common/status-badge';
import { ErrorMessage } from '@/components/common/error-message';
import { EnquiryActions } from '@/components/product-enquiry/enquiry-actions';
import { HistoryTimeline } from '@/components/product-enquiry/history-timeline';
import { ProductList } from '@/components/product-enquiry/product-list';
import { SlaTimer } from '@/components/product-enquiry/sla-timer';
import { apiFetch } from '@/lib/api-server';
import { fetchEnquiry } from '@/lib/enquiry-api';
import { can, getCurrentUser } from '@/lib/current-user';
import { formatDateTime, label } from '@/lib/format';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const { result } = await fetchEnquiry(id);
  return { title: result.success ? result.data.enquiry.enquiryNo : 'Enquiry' };
}

/**
 * View V2 — the working screen.
 *
 * Every capability shown here is decided on the server from the backend's own
 * permission matrix combined with the ownership rules (§23). Hiding a control
 * is a courtesy, not a security boundary: the API enforces all of it again.
 */
export default async function EnquiryDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  // Independent of each other; see the note on the list page.
  const [{ result, serverTime }, assigneesResult] = await Promise.all([
    fetchEnquiry(id),
    apiFetch<{ assignees: { id: string; name: string; employeeId: string }[] }>(
      '/api/product-enquiries/assignees',
    ),
  ]);

  if (!result.success) {
    if (result.code === 'PRODUCT_ENQUIRY_NOT_FOUND') notFound();
    return <ErrorMessage message={result.message} code={result.code} />;
  }

  const enquiry = result.data.enquiry;

  const assignees = assigneesResult.success ? assigneesResult.data.assignees : [];

  // Mirrors backend/src/policies/enquiry-access.ts. The API is authoritative;
  // this only decides what is worth rendering.
  const isAdmin = user.role === 'ADMIN';
  const isTowards = enquiry.assignedTo.id === user.id;
  const open = enquiry.status !== 'CLOSED';
  const mayEdit = can(user, 'PRODUCT_ENQUIRY', 'EDIT');

  const canRespond = open && mayEdit && (isAdmin || isTowards);
  const canSubmit = canRespond;
  const canAssign = can(user, 'PRODUCT_ENQUIRY', 'ASSIGN') && isAdmin;
  const canReopen = canAssign && !open;

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: 'Customer', value: enquiry.customer.name },
    { label: 'Customer type', value: label(enquiry.customer.type) },
    {
      label: 'Source',
      value: enquiry.sourceDetail
        ? `${label(enquiry.source)} — ${enquiry.sourceDetail}`
        : label(enquiry.source),
    },
    { label: 'Created', value: formatDateTime(enquiry.sla.createdAt) },
    { label: 'Created by', value: enquiry.createdBy.name },
    { label: 'Towards', value: enquiry.assignedTo.name },
    { label: 'Deadline', value: formatDateTime(enquiry.sla.slaDeadlineAt) },
    ...(enquiry.closedAt
      ? [{ label: 'Closed', value: `${formatDateTime(enquiry.closedAt)} · ${enquiry.closedBy?.name ?? ''}` }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" asChild className="w-fit -ml-2">
        <Link href="/product-enquiry">
          <ArrowLeft className="size-4" />
          All enquiries
        </Link>
      </Button>

      {/* ---------------- Header ---------------- */}
      <Card>
        <CardContent className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-mono text-xl font-medium text-ink tabular">
                  {enquiry.enquiryNo}
                </h1>
                <StatusBadge status={enquiry.status} />
                <EfficiencyBadge
                  efficiency={enquiry.sla.efficiency}
                  breached={enquiry.sla.breached}
                />
              </div>
              <p className="mt-1.5 text-[15px] text-ink-2">{enquiry.customer.name}</p>
            </div>

            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                {enquiry.sla.firstSubmitAt ? 'Response time' : `${enquiry.sla.slaMinutes}-minute SLA`}
              </span>
              <SlaTimer
                sla={enquiry.sla}
                serverTime={serverTime ?? new Date().toISOString()}
                size="lg"
                className="items-end"
              />
            </div>
          </div>

          <Separator className="my-5" />

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt className="text-[11px] uppercase tracking-wider text-muted">{fact.label}</dt>
                <dd className="mt-1 text-sm text-ink">{fact.value}</dd>
              </div>
            ))}
          </dl>

          {(canSubmit || canAssign || canReopen) && (
            <>
              <Separator className="my-5" />
              <EnquiryActions
                enquiry={enquiry}
                assignees={assignees}
                canSubmit={canSubmit}
                canAssign={canAssign}
                canReopen={canReopen}
              />
            </>
          )}

          {!open && (
            <div className="mt-5 flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-muted">
              <Lock className="size-4 shrink-0" />
              This enquiry is closed and read-only.
              {canReopen && ' An administrator can reopen it.'}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Products + history ---------------- */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
              Products ({enquiry.products.length})
            </h2>
            {enquiry.products.some((p) => p.similarOptionNeeded) && (
              <Badge variant="outline">Alternatives welcome on some lines</Badge>
            )}
          </div>

          <ProductList enquiryId={enquiry.id} products={enquiry.products} canRespond={canRespond} />
        </section>

        <aside className="min-w-0">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted">
                History
              </CardTitle>
            </CardHeader>
            <CardContent>
              <HistoryTimeline events={enquiry.events} delays={enquiry.delays} />
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
