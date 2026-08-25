import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { MobileNav } from '@/components/layout/mobile-nav';
import { getCurrentUser, initials } from '@/lib/current-user';
import { signOutAction } from './actions';

/**
 * The authenticated shell.
 *
 * The identity rendered here comes from the API rather than the session cookie,
 * so a role change or a deactivation takes effect on the next page load. If the
 * API will not vouch for the session, the person goes back to sign-in.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          name={user.name}
          employeeId={user.employeeId}
          role={user.role}
          initials={initials(user.name)}
          onSignOut={signOutAction}
        />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
        <MobileNav />
      </div>
    </div>
  );
}
