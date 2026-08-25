'use server';

import { AuthError } from 'next-auth';
import { signIn } from '@/auth';

export type LoginState = { error?: string };

/**
 * §9 — one message for every failure. Express already refuses to say whether an
 * email exists; this keeps the frontend from leaking it either.
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email and password.' };
  }

  try {
    await signIn('credentials', { email, password, redirectTo: '/dashboard' });
    return {};
  } catch (error) {
    // A successful sign-in throws a redirect that must reach Next.js untouched.
    if (error instanceof AuthError) {
      return { error: 'Email or password is incorrect.' };
    }
    throw error;
  }
}
