import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import type { ManagedUser } from '@rs/shared';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import { CreateUserDialog } from '@/components/users/create-user-dialog';
import { UserTable } from '@/components/users/user-table';
import { apiFetch } from '@/lib/api-server';
import { requireAdminUser } from '@/lib/require-module';
import { NoAdminAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'User Management' };

/**
 * §2/§12 — administrator-only user management.
 *
 * Guarded twice over: requireAdminUser stops the page rendering for anyone
 * else, and /api/users refuses the request on its own authority regardless of
 * how it was reached. The page guard exists so a USER who types the URL sees an
 * honest "no access" screen rather than an empty table.
 */
export default async function UserManagementPage() {
  const access = await requireAdminUser();
  if (!access.allowed) return <NoAdminAccess />;

  const result = await apiFetch<{ users: ManagedUser[] }>('/api/users?limit=100');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Administration"
        title="User Management"
        description="Who can sign in, and which of the seven CRM modules each person can open."
        actions={<CreateUserDialog />}
      />

      {!result.success ? (
        <ErrorMessage message={result.message} code={result.code} />
      ) : result.data.users.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="No users yet"
            description="Create the first account and choose the modules it can reach."
            action={<CreateUserDialog />}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <UserTable users={result.data.users} />
        </Card>
      )}
    </div>
  );
}
