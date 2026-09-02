import { redirect } from 'next/navigation';
import type { AppModule } from '@rs/shared';
import { getCurrentUser, type CurrentUser } from './current-user';
import { hasModule } from './module-access';

/**
 * §6 — the page-level half of module access.
 *
 * Typing /sales directly must not render the Sales module for somebody with no
 * Sales access, even though the sidebar never offered the link.
 *
 * This returns a verdict rather than redirecting. `redirect()` throws
 * NEXT_REDIRECT and depends on that error reaching the router untouched; inside
 * a page that also awaits other work the signal can be lost, and the page then
 * renders as though the check had passed. A returned value cannot be swallowed,
 * so the caller renders <NoModuleAccess /> instead and the outcome is the same
 * every time.
 *
 * Signing in is different: there is no page to show a signed-out visitor, so
 * that case still redirects — and it does so before any other await, which is
 * where redirect() is reliable.
 *
 * None of this is the security boundary. The API rejects the same request on
 * its own authority; this decides what is worth rendering.
 */
export type ModuleAccess =
  | { allowed: true; user: CurrentUser }
  | { allowed: false; user: CurrentUser };

export async function requireModule(module: AppModule): Promise<ModuleAccess> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return { allowed: hasModule(user, module), user };
}

/** The same, for administrator-only areas outside the seven CRM modules. */
export async function requireAdminUser(): Promise<{ allowed: boolean; user: CurrentUser }> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return { allowed: user.role === 'ADMIN', user };
}
