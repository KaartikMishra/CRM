'use server';

import { signOut } from '@/auth';
import { apiFetch } from '@/lib/api-server';

/**
 * §26 — the backend records the event in the same audit trail as sign-in, then
 * Auth.js destroys the session cookie and the person lands back on /login.
 */
export async function logoutAction(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  await signOut({ redirectTo: '/login' });
}
