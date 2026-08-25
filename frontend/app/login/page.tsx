import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoFull } from '@/components/layout/logo';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · RoyalStuffs CRM' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoFull width={120} />
          <h1 className="mt-3 font-serif text-2xl font-semibold tracking-tight text-ink">
            RoyalStuffs
          </h1>
          <p className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-muted">
            Internal CRM
          </p>
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
