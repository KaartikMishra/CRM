import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · RoyalStuffs CRM' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">
            RoyalStuffs
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">Internal CRM</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use the credentials issued to you by an administrator.</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm />
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted">
          Accounts are provisioned internally. There is no self sign-up.
        </p>
      </div>
    </main>
  );
}
