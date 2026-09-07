import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import {
  BillStatusBadge,
  BillTypeBadge,
} from '@/components/procurement/procurement-badges';
import { BillItemList } from '@/components/procurement/bill-item-list';
import { fetchProducts, fetchPurchaseBill } from '@/lib/procurement-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const result = await fetchPurchaseBill(id);
  return { title: result.success ? result.data.bill.billNumber : 'Purchase Bill' };
}

export default async function PurchaseBillDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const access = await requireModule('PROCUREMENT');
  if (!access.allowed) return <NoModuleAccess module="PROCUREMENT" />;

  const [result, products] = await Promise.all([fetchPurchaseBill(id), fetchProducts()]);
  if (!result.success) {
    if (result.code === 'PURCHASE_BILL_NOT_FOUND') notFound();
    return <ErrorMessage message={result.message} code={result.code} />;
  }

  const bill = result.data.bill;
  const canEdit = can(access.user, 'PROCUREMENT', 'EDIT');
  const isAdmin = access.user.role === 'ADMIN';

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: 'Vendor', value: bill.vendor.name },
    { label: 'Bill date', value: formatDate(bill.billDate) },
    { label: 'Expected by', value: bill.expectedBy ? formatDate(bill.expectedBy) : '—' },
    { label: 'Recorded by', value: bill.createdBy.name },
    { label: 'Value received', value: formatCurrency(bill.billTotal) },
    { label: 'Standing stock', value: `${bill.totalStandingQty} unit(s)` },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" asChild className="w-fit -ml-2">
        <Link href="/procurement">
          <ArrowLeft className="size-4" />
          All purchase bills
        </Link>
      </Button>

      <Card>
        <CardContent className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-mono text-xl font-medium text-ink tabular">{bill.billNumber}</h1>
                <BillStatusBadge status={bill.status} />
                <BillTypeBadge type={bill.billType} />
              </div>
              <p className="mt-1.5 text-[15px] text-ink-2">{bill.vendor.name}</p>
            </div>

            {bill.billImage && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={bill.billImage.secureUrl}
                alt="Purchase bill"
                className="h-20 w-20 rounded-md border border-line object-cover"
              />
            )}
          </div>

          <Separator className="my-5" />

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt className="text-[11px] uppercase tracking-wider text-muted">{fact.label}</dt>
                <dd className="mt-1 text-sm text-ink">{fact.value}</dd>
              </div>
            ))}
          </dl>

          {bill.isDelayed && (
            <div className="mt-5 flex items-start gap-2 rounded-md border border-critical/30 bg-critical-soft px-3 py-2.5 text-sm text-critical">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong className="font-medium">Delayed.</strong> {bill.delayReason}
              </span>
            </div>
          )}

          {bill.notes && (
            <p className="mt-5 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
              {bill.notes}
            </p>
          )}
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Products ({bill.items.length})
        </h2>
        <BillItemList
          billId={bill.id}
          items={bill.items}
          products={products}
          canEdit={canEdit}
          isAdmin={isAdmin}
        />
      </section>
    </div>
  );
}
