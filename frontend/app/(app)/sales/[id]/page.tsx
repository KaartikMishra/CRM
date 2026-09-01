import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { EfficiencyBadge } from '@/components/common/status-badge';
import { ErrorMessage } from '@/components/common/error-message';
import { MoneySummary } from '@/components/sales/money-summary';
import { SalesOrderActions } from '@/components/sales/sales-order-actions';
import { SalesItemList } from '@/components/sales/sales-item-list';
import { SalesStatusBadge } from '@/components/sales/sales-status-badge';
import { fetchSalesOrder } from '@/lib/sales-api';
import { can, getCurrentUser } from '@/lib/current-user';
import { formatCurrency, formatDate, formatDateTime, label } from '@/lib/format';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const { result } = await fetchSalesOrder(id);
  return { title: result.success ? result.data.order.orderId : 'Sales Order' };
}

/**
 * The working screen for one order.
 *
 * Every capability shown here is decided on the server from the backend's own
 * permission matrix combined with the ownership rules. Hiding a control is a
 * courtesy, not a security boundary: the API enforces all of it again.
 */
export default async function SalesOrderDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { result } = await fetchSalesOrder(id);

  if (!result.success) {
    if (result.code === 'SALES_ORDER_NOT_FOUND') notFound();
    return <ErrorMessage message={result.message} code={result.code} />;
  }

  const order = result.data.order;

  // Mirrors backend/src/policies/sales-access.ts. The API is authoritative;
  // this only decides what is worth rendering.
  const isAdmin = user.role === 'ADMIN';
  const isCreator = order.createdBy.id === user.id;
  const owns = isAdmin || isCreator;
  const closed = order.status === 'CLOSED';
  const mayEdit = can(user, 'SALES', 'EDIT');

  const canEdit = mayEdit && owns && !closed;
  const canDispatch = mayEdit && owns && order.status === 'OPEN';
  const canClose = mayEdit && owns && order.status === 'DISPATCHED';
  // Approving a proposed line is SALES ASSIGN — resolved from the permission
  // matrix, never from the role, so a per-user grant works here too.
  // Product change requests are deliberately NOT gated on ownership: filing one
  // changes nothing, and cannot be self-approved, so any SALES EDIT holder may
  // raise one against an open order. Mirrors canRequestItemChange on the server.
  const canRequest = can(user, 'SALES', 'EDIT') && !closed;
  // Deciding one is SALES ASSIGN. The service checks it again, and separately
  // refuses self-review.
  const canReview = can(user, 'SALES', 'ASSIGN') && !closed;

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: 'Customer', value: order.customer.name },
    { label: 'Customer type', value: label(order.customer.type) },
    {
      label: 'Phone',
      value: order.customer.phone ? (
        <a href={`tel:${order.customer.phone}`} className="tabular text-accent hover:underline">
          {order.customer.phone}
        </a>
      ) : (
        <span className="text-faint">Not recorded</span>
      ),
    },
    {
      label: 'Email',
      value: order.customer.email ? (
        <a
          href={`mailto:${order.customer.email}`}
          className="break-all text-accent hover:underline"
        >
          {order.customer.email}
        </a>
      ) : (
        <span className="text-faint">Not recorded</span>
      ),
    },
    {
      label: 'Products',
      value: `${order.money.activeItemCount} ${order.money.activeItemCount === 1 ? 'line' : 'lines'}`,
    },
    { label: 'Order total', value: formatCurrency(order.money.total, order.money.currency) },
    { label: 'Order date', value: formatDate(order.orderDate) },
    { label: 'To be dispatched by', value: formatDate(order.toBeDispatchedBy) },
    {
      label: 'Dispatched',
      value: order.dispatchedAt ? formatDateTime(order.dispatchedAt) : '—',
    },
    { label: 'Created by', value: order.createdBy.name },
    ...(order.closedAt
      ? [
          {
            label: 'Closed',
            value: `${formatDateTime(order.closedAt)} · ${order.closedBy?.name ?? ''}`,
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" asChild className="w-fit -ml-2">
        <Link href="/sales">
          <ArrowLeft className="size-4" />
          All orders
        </Link>
      </Button>

      {/* ---------------- Header ---------------- */}
      <Card>
        <CardContent className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-mono text-xl font-medium text-ink tabular">{order.orderId}</h1>
                <SalesStatusBadge status={order.status} />
                <EfficiencyBadge efficiency={order.efficiency} breached={order.overdue} />
              </div>
              <p className="mt-1.5 text-[15px] text-ink-2">{order.customer.name}</p>
            </div>

            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                {order.money.fullyPaid ? 'Settled in full' : 'Outstanding'}
              </span>
              <span
                className={`font-mono text-xl tabular ${
                  order.money.fullyPaid ? 'text-positive' : 'text-warning'
                }`}
              >
                {formatCurrency(order.money.pending, order.money.currency)}
              </span>
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

          {(canEdit || canDispatch || canClose) && (
            <>
              <Separator className="my-5" />
              <SalesOrderActions
                order={order}
                canEdit={canEdit}
                canDispatch={canDispatch}
                canClose={canClose}
              />
            </>
          )}

          {closed && (
            <div className="mt-5 flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-muted">
              <Lock className="size-4 shrink-0" />
              This order is closed and read-only.
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Products + money ---------------- */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className="min-w-0">
          <SalesItemList
            orderId={order.id}
            items={order.items}
            currency={order.money.currency}
            changeRequests={order.changeRequests}
            canRequest={canRequest}
            canReview={canReview}
            currentUserId={user.id}
          />
        </section>

        <aside className="min-w-0">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">
            Payment
          </h2>
          <Card>
            <CardContent className="p-5">
              <MoneySummary money={order.money} />
              <p className="mt-3 text-xs text-muted">
                {order.money.fullyPaid
                  ? 'This order is paid in full.'
                  : `${formatCurrency(order.money.pending, order.money.currency)} still to collect.`}
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
