import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/common/page-header';
import { CreateEnquiryForm } from '@/components/product-enquiry/create-enquiry-form';
import { apiFetch } from '@/lib/api-server';
import { can, getCurrentUser } from '@/lib/current-user';

export const metadata: Metadata = { title: 'New Enquiry' };

export default async function NewEnquiryPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  // The UI hides what you may not do; the API refuses it regardless (§9).
  if (!can(user, 'PRODUCT_ENQUIRY', 'CREATE')) redirect('/product-enquiry');

  const result = await apiFetch<{
    assignees: { id: string; name: string; employeeId: string }[];
  }>('/api/product-enquiries/assignees');
  const assignees = result.success ? result.data.assignees : [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Product Enquiry"
        title="New enquiry"
        description="The fifteen-minute response clock starts the moment this is created."
      />
      <CreateEnquiryForm assignees={assignees} currentUserId={user.id} />
    </div>
  );
}
