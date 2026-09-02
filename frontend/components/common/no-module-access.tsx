import Link from 'next/link';
import { ShieldOff } from 'lucide-react';
import { APP_MODULE_LABELS, type AppModule } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/common/empty-state';

/**
 * What a person sees when they open a module they cannot reach.
 *
 * Rendered in place rather than redirected to. `redirect()` works by throwing
 * NEXT_REDIRECT and relying on that error reaching the router untouched, which
 * makes it fragile inside a page that also awaits other work — the signal can
 * be swallowed and the page renders anyway, which is precisely the bug this
 * replaced. Returning UI cannot fail that way: there is no throw to lose.
 *
 * Deliberately plain: it names the module and says access is missing, without
 * hinting at what is inside. The API refuses the same request regardless, so
 * this is the courtesy, not the boundary.
 */
export function NoModuleAccess({ module }: { module: AppModule }) {
  return (
    <Card className="mx-auto max-w-xl">
      <EmptyState
        icon={ShieldOff}
        title={`You do not have access to ${APP_MODULE_LABELS[module]}`}
        description="Ask an administrator to grant it from User Management, then reload this page."
        action={
          <Button asChild variant="outline">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        }
      />
    </Card>
  );
}

/** The same, for the administrator-only areas outside the seven CRM modules. */
export function NoAdminAccess() {
  return (
    <Card className="mx-auto max-w-xl">
      <EmptyState
        icon={ShieldOff}
        title="You do not have access to User Management"
        description="This area is restricted to administrators."
        action={
          <Button asChild variant="outline">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        }
      />
    </Card>
  );
}
