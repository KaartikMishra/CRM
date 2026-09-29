import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { OrderDetail } from '@/components/dispatch/order-detail';
import { fetchDispatchOrder } from '@/lib/dispatch-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const result = await fetchDispatchOrder(id);
  return { title: result.success ? result.data.detail.orderId : 'Dispatch' };
}

export default async function DispatchOrderPage({ params }: { params: Params }) {
  const { id } = await params;

  const access = await requireModule('PACKING_DISPATCH');
  if (!access.allowed) return <NoModuleAccess module="PACKING_DISPATCH" />;

  const result = await fetchDispatchOrder(id);
  if (!result.success) {
    if (result.code === 'SALES_ORDER_NOT_FOUND') notFound();
    return <ErrorMessage message={result.message} code={result.code} />;
  }

  const detail = result.data.detail;

  /*
    Four separate questions, each resolved through the permission matrix rather
    than from the role — a per-user grant or revocation applies here exactly as
    it does everywhere else. `isAdmin` is the one thing that genuinely is about
    the role: an administrator's partial-dispatch request is allowed the moment
    it is made, and the dialog has to ask them for the reason the API requires.
    It decides what the form collects, never what anybody is permitted to do.
  */
  const canCreate = can(access.user, 'PACKING_DISPATCH', 'CREATE');
  const canEdit = can(access.user, 'PACKING_DISPATCH', 'EDIT');
  const canAssign = can(access.user, 'PROCUREMENT', 'ASSIGN');
  const isAdmin = access.user.role === 'ADMIN';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/dispatch">
            <ArrowLeft className="size-4" />
            Back to the board
          </Link>
        </Button>

        <PageHeader
          eyebrow="Packing & Dispatch"
          title={detail.orderId}
          description={`${detail.customer.name} · ${detail.readiness.lines.length} line${
            detail.readiness.lines.length === 1 ? '' : 's'
          }`}
        />
      </div>

      <OrderDetail
        detail={detail}
        canCreate={canCreate}
        canEdit={canEdit}
        canAssign={canAssign}
        isAdmin={isAdmin}
      />
    </div>
  );
}
