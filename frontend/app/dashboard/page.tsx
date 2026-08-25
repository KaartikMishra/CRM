import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-server';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { logoutAction } from './actions';

export const metadata: Metadata = { title: 'Dashboard · RoyalStuffs CRM' };

type MeResponse = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  role: 'ADMIN' | 'USER';
  permissions: { module: string; action: string; allowed: boolean }[];
};

/**
 * §27/§34 — deliberately minimal. Its only job is to prove the whole chain
 * works: session cookie → bearer token → requireAuth → live user lookup.
 * The real CRM dashboard is a later phase.
 */
export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const result = await apiFetch<MeResponse>('/api/auth/me');
  const me = result.success ? result.data : null;

  const granted = me?.permissions.filter((p) => p.allowed) ?? [];

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">
            RoyalStuffs CRM
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            Signed in as {session.user.name}
          </h1>
        </div>
        <form action={logoutAction}>
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Verified by the API</CardTitle>
          <CardDescription>
            {me
              ? 'This came back from Express after it verified the bearer token and re-read the user from the database.'
              : 'The API could not be reached.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {me ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted">Employee ID</dt>
              <dd className="font-medium text-ink">{me.employeeId}</dd>
              <dt className="text-muted">Email</dt>
              <dd className="font-medium text-ink">{me.email}</dd>
              <dt className="text-muted">Role</dt>
              <dd className="font-medium text-ink">{me.role}</dd>
              <dt className="text-muted">Capabilities</dt>
              <dd className="font-medium text-ink">{granted.length} granted</dd>
            </dl>
          ) : (
            <p className="text-sm text-oxide">
              {result.success ? '' : result.message}
            </p>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 text-sm text-muted">
        Authentication only. CRM modules arrive in later phases.
      </p>
    </main>
  );
}
