import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/common/page-header';
import { CreateSalesOrderForm } from '@/components/sales/create-sales-order-form';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'New Sales Order' };

export default async function NewSalesOrderPage() {
  const access = await requireModule('SALES');
  if (!access.allowed) return <NoModuleAccess module="SALES" />;
  const user = access.user;

  // The UI hides what you may not do; the API refuses it regardless.
  if (!can(user, 'SALES', 'CREATE')) redirect('/sales');

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Sales"
        title="New order"
        description="Record an order and its payment position. Totals are calculated for you and cannot be typed over."
      />
      <CreateSalesOrderForm />
    </div>
  );
}
