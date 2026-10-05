import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { CreateLeadForm } from '@/components/lead/create-lead-form';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Create Lead / Deal' };

export default async function CreateLeadPage() {
  const access = await requireModule('LEAD_DEAL');
  if (!access.allowed) return <NoModuleAccess module="LEAD_DEAL" />;

  /*
    Reading the module is not the same as recording a lead. Somebody with VIEW
    can open this page and look a customer up; creating one needs CREATE, and
    the API refuses it without — so the form is only drawn for people who can
    actually finish it.
  */
  const canCreate = can(access.user, 'LEAD_DEAL', 'CREATE');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Sales"
        title="Create Lead / Deal"
        description="Record an enquiry: where it came from, what it is for, and who it is from."
      />

      {canCreate ? (
        <CreateLeadForm />
      ) : (
        <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
          You can view this module, but recording a lead needs create access.
        </p>
      )}
    </div>
  );
}
