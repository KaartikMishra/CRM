import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import {
  POST_SALES_CASE_TYPE_LABELS,
  POST_SALES_ISSUE_CATEGORY_LABELS,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import {
  CaseAttachments,
  CaseControls,
  CaseTimeline,
} from '@/components/post-sales/case-detail-panels';
import { CasePriorityBadge, CaseStatusBadge } from '@/components/post-sales/post-sales-badges';
import { fetchPostSalesCase } from '@/lib/post-sales-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { formatCurrency, formatDateTime } from '@/lib/format';

/**
 * One case in full.
 *
 * Everything on the page comes from one request: the customer, the order with its
 * derived total, the affected lines with their product identity, the timeline and
 * the attachments. A case with ten activities is one round trip, not eleven.
 *
 * `requireModule` returns a verdict rather than redirecting, because `redirect()`
 * throws NEXT_REDIRECT and a later await can swallow it.
 */

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const result = await fetchPostSalesCase(id);
  return { title: result.success ? result.data.case.caseNumber : 'Post Sales Case' };
}

export default async function PostSalesCasePage({ params }: { params: Params }) {
  const { id } = await params;

  const access = await requireModule('POST_SALES');
  if (!access.allowed) return <NoModuleAccess module="POST_SALES" />;

  const result = await fetchPostSalesCase(id);
  if (!result.success) {
    if (result.code === 'POST_SALES_CASE_NOT_FOUND') notFound();
    return <ErrorMessage message={result.message} code={result.code} />;
  }

  const view = result.data.case;

  /*
    Two separate verdicts. EDIT does the work — status, priority, notes,
    attachments; ASSIGN decides who owns it. Resolved through the permission matrix
    rather than the role, so a per-user grant or revocation applies here as
    everywhere else.
  */
  const canEdit = can(access.user, 'POST_SALES', 'EDIT');
  const canAssign = can(access.user, 'POST_SALES', 'ASSIGN');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/post-sales/cases">
            <ArrowLeft className="size-4" />
            Back to all cases
          </Link>
        </Button>

        <PageHeader
          eyebrow={`Post Sales · ${view.caseNumber}`}
          title={view.subject}
          description={`${view.customer.name}${
            view.customer.phone ? ` · ${view.customer.phone}` : ''
          }`}
        />

        <div className="flex flex-wrap items-center gap-2">
          <CaseStatusBadge status={view.status} />
          <CasePriorityBadge priority={view.priority} />
        </div>
      </div>

      <CaseControls view={view} canEdit={canEdit} canAssign={canAssign} />

      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Case type" value={POST_SALES_CASE_TYPE_LABELS[view.caseType]} />
        <Field label="Issue" value={POST_SALES_ISSUE_CATEGORY_LABELS[view.issueCategory]} />
        <Field label="Raised on" value={formatDateTime(view.createdAt)} />
        <Field label="Raised by" value={view.raisedBy.name} />
        <Field
          label="Order"
          value={view.order?.orderId ?? 'No order linked'}
          note={view.order ? formatDateTime(view.order.orderDate) : null}
        />
        <Field
          label="Order value"
          value={view.order ? formatCurrency(view.order.total) : '—'}
          note={view.order ? 'From the linked sales order' : 'No order linked'}
        />
        <Field
          label="Resolved"
          value={view.resolvedAt ? formatDateTime(view.resolvedAt) : 'Not yet'}
        />
        <Field label="Closed" value={view.closedAt ? formatDateTime(view.closedAt) : 'Not yet'} />
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-base font-semibold text-ink">What the customer reported</h2>
        <p className="whitespace-pre-wrap text-sm text-ink-2">{view.description}</p>
      </Card>

      {/* Affected lines, with product identity read from the order line itself. */}
      {view.items.length > 0 && (
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-base font-semibold text-ink">Affected products</h2>
          <ul className="flex flex-col gap-2">
            {view.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-2 bg-surface p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    <span className="text-muted">Line {item.salesOrderItem.lineNo}.</span>{' '}
                    {item.salesOrderItem.productName}
                  </p>
                  {item.salesOrderItem.rsProduct?.sku && (
                    <p className="text-xs text-muted">
                      SKU {item.salesOrderItem.rsProduct.sku}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-sm tabular text-ink-2">
                  {item.affectedQty} of {item.salesOrderItem.quantity} affected
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <CaseTimeline view={view} canEdit={canEdit} />
      <CaseAttachments view={view} canEdit={canEdit} />
    </div>
  );
}

function Field({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm text-ink">{value}</span>
      {note && <span className="text-xs text-faint">{note}</span>}
    </div>
  );
}
