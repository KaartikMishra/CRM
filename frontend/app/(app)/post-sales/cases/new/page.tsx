import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { CreateCaseForm } from '@/components/post-sales/create-case-form';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'New Post Sales Case' };

/**
 * Raising a case.
 *
 * Gated on CREATE, not VIEW: reading the board and filing a grievance are different
 * privileges, and the form's customer search returns full contact details — which is
 * why the customer endpoint behind it is also CREATE-gated.
 */
export default async function NewPostSalesCasePage() {
  const access = await requireModule('POST_SALES');
  if (!access.allowed) return <NoModuleAccess module="POST_SALES" />;

  if (!can(access.user, 'POST_SALES', 'CREATE')) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          eyebrow="Post Sales & Grievance"
          title="New case"
          description="You do not have permission to raise a case."
        />
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link href="/post-sales/cases">Back to all cases</Link>
        </Button>
      </div>
    );
  }

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
          eyebrow="Post Sales & Grievance"
          title="New case"
          description="Record what a customer has reported after a sale."
        />
      </div>

      <CreateCaseForm />
    </div>
  );
}
