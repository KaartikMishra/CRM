import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/common/page-header';
import { CreateBillForm } from '@/components/procurement/create-bill-form';
import { fetchVendors } from '@/lib/procurement-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'New Purchase Bill' };

export default async function NewPurchaseBillPage() {
  const access = await requireModule('PROCUREMENT');
  if (!access.allowed) return <NoModuleAccess module="PROCUREMENT" />;

  // The UI hides what you may not do; the API refuses it regardless.
  if (!can(access.user, 'PROCUREMENT', 'CREATE')) redirect('/procurement');

  const vendors = await fetchVendors();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Purchase & Procurement"
        title="New purchase bill"
        description="Record what a vendor supplied. Only received quantities can be allocated to orders."
      />
      <CreateBillForm vendors={vendors} />
    </div>
  );
}
