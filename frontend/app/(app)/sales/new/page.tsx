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

  /*
    No catalogue is preloaded any more.

    The product field used to receive up to 200 legacy Products so a datalist
    could suggest them. It now searches RS Products from the browser as somebody
    types, which is both a larger catalogue (502 products, not 1) and a smaller
    payload — the list arrives twenty rows at a time, only for what was actually
    searched. Failing to search still cannot block order entry: the field falls
    back to plain free text, exactly as before.
  */

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
