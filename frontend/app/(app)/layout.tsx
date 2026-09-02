import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { visibleNavItems } from '@/components/layout/nav-items';
import { getCurrentUser, initials } from '@/lib/current-user';
import { accessibleModules } from '@/lib/module-access';
import { signOutAction } from './actions';

/**
 * The authenticated shell.
 *
 * The identity rendered here comes from the API rather than the session cookie,
 * so a role change or a deactivation takes effect on the next page load. If the
 * API will not vouch for the session, the person goes back to sign-in.
 *
 * §11 — navigation is built from the same resolved permission matrix, so the
 * sidebar shows exactly the modules this person can actually open. That is a
 * courtesy only: every page guards itself and every API route guards itself
 * again, so hiding a link is never what keeps anyone out.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const items = visibleNavItems(accessibleModules(user), user.role === 'ADMIN');

  return (
    <div className="flex min-h-screen">
      <Sidebar items={items} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          name={user.name}
          employeeId={user.employeeId}
          role={user.role}
          initials={initials(user.name)}
          items={items}
          onSignOut={signOutAction}
        />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
