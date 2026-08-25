'use server';

import { signOut } from '@/auth';
import { apiFetch } from '@/lib/api-server';

/** §26 — the backend records the sign-out, then Auth.js destroys the session. */
export async function signOutAction(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  await signOut({ redirectTo: '/login' });
}
