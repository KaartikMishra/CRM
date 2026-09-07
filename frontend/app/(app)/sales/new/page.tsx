import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/common/page-header';
import { CreateSalesOrderForm } from '@/components/sales/create-sales-order-form';
import { fetchProducts } from '@/lib/procurement-api';
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

  /*
    The catalogue, purely as suggestions for the product field. Failing to load
    it must not block order entry, so fetchProducts returns [] on error and the
    field falls back to plain free text — which is how every order was written
    before the Product master existed.
  */
  const products = await fetchProducts();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Sales"
        title="New order"
        description="Record an order and its payment position. Totals are calculated for you and cannot be typed over."
      />
      <CreateSalesOrderForm products={products} />
    </div>
  );
}
