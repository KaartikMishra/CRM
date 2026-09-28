import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { ContentPage, ContentPageHeader } from '@/components/common/content-page';
import { ClockBoard } from '@/components/procurement/clock-board';
import {
  ProcurementDelayQueue,
  PurchaseDelayQueue,
} from '@/components/procurement/delay-queues';
import {
  fetchProcurementClock,
  fetchProcurementDelayQueue,
  fetchPurchaseDelayQueue,
} from '@/lib/procurement-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'Procurement Clock' };

/**
 * Procurement Clock — a submodule of Purchase & Procurement.
 *
 * A static segment beside `new` and `[id]`, so the URL says what the sidebar
 * says: this lives *under* Purchase & Procurement rather than beside it. Next
 * resolves a static segment ahead of a dynamic one, so `/procurement/clock`
 * reaches this page and never falls into `/procurement/[id]`.
 *
 * Access is PROCUREMENT, the parent's module, deliberately — a submodule inherits
 * its parent's access rather than inventing one, so granting or revoking Purchase
 * & Procurement moves both together and no new AppModule value, permission row or
 * migration was needed to stand this up.
 *
 * WHAT THIS PAGE IS NOT. It is not a timer. Nothing here ticks: a deadline is a
 * date, the state says which side of it an order is on, and a second-by-second
 * countdown would redraw the screen to say what a date already says. It is also
 * not a second view of Sales — every figure is procurement's own arithmetic over
 * the order's lines, fetched from the API, and this page recomputes none of it.
 */
export default async function ProcurementClockPage() {
  const access = await requireModule('PROCUREMENT');
  if (!access.allowed) return <NoModuleAccess module="PROCUREMENT" />;

  /*
    Three capabilities, all resolved the same way the rest of the module resolves
    them — never `role === 'ADMIN'` for a module capability. EDIT reports a delay,
    ASSIGN decides one and accounts for a late order, and deciding procurement's
    own account is the one thing that goes above the module, so it reads the role.
    All three only decide what is rendered; the API refuses each action on its own
    authority regardless.
  */
  const canEdit = can(access.user, 'PROCUREMENT', 'EDIT');
  const canReview = can(access.user, 'PROCUREMENT', 'ASSIGN');
  const isAdmin = access.user.role === 'ADMIN';

  // Independent of each other, and each queue is skipped entirely for somebody
  // who could not act on it.
  const [orders, purchaseDelays, procurementDelays] = await Promise.all([
    fetchProcurementClock(),
    canReview ? fetchPurchaseDelayQueue() : Promise.resolve([]),
    isAdmin ? fetchProcurementDelayQueue() : Promise.resolve([]),
  ]);

  return (
    <ContentPage>
      <ContentPageHeader>
        <PageHeader
          eyebrow="Purchase & Procurement"
          title="Procurement Clock"
          description="Every sales order against a deadline two days after its order date, and what each one still needs bought."
        />
      </ContentPageHeader>

      {canReview && <PurchaseDelayQueue reasons={purchaseDelays} />}
      {isAdmin && <ProcurementDelayQueue reasons={procurementDelays} />}

      <ClockBoard
        orders={orders}
        canEdit={canEdit}
        canReview={canReview}
        isAdmin={isAdmin}
      />
    </ContentPage>
  );
}
