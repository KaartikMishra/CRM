import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchPracticals, fetchShadowings } from '@/lib/training-api';
import {
  PracticalReviewQueue,
  ShadowingQueue,
} from '@/components/hr/training-review-panels';

export const metadata: Metadata = { title: 'Training Reviews' };

/**
 * The reviewer's and mentor's queue.
 *
 * ### Not gated on the training module, deliberately
 *
 * A reviewer is usually an ordinary colleague holding no training grant — being
 * assigned to review somebody's practical is a fact about rows, not a permission.
 * Gating this page on `HR_TRAINING` would lock the people who do the reviewing out of
 * the queue.
 *
 * So the floor matches the backend's learner floor, and the server scopes what comes
 * back: a reviewer sees their own queue, HR sees everything. The service then refuses
 * **the learner first**, before any permission check, because an independent review is
 * the entire value of this gate.
 *
 * ### Two queues on one page
 *
 * A practical and a shadowing sign-off are different acts with different rules, but
 * they land on the same person at the same time, and splitting them across two routes
 * would mean checking two pages to find out whether anything is waiting.
 */
export default async function TrainingReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_TRAINING');

  const mayReview =
    can(access.user, 'HR_TRAINING', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');

  if (!mayReview) {
    return <NoModuleAccess module="HR_TRAINING" />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // `all=1` widens to settled records too, for somebody looking back at what they
  // decided. The default is the queue, because that is what somebody opens this for.
  const showAll = single('all') === '1';

  const [practicals, shadowings] = await Promise.all([
    fetchPracticals({
      ...(showAll ? {} : { pendingOnly: 'true' }),
      limit: '50',
    }),
    fetchShadowings({
      ...(showAll ? {} : { pendingOnly: 'true' }),
      limit: '50',
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Training"
        title="Reviews"
        description="Practical work waiting on a decision, and shadowing waiting on a sign-off."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant={showAll ? 'outline' : 'default'}>
              <Link href="/hr/training/reviews">Waiting</Link>
            </Button>
            <Button asChild size="sm" variant={showAll ? 'default' : 'outline'}>
              <Link href="/hr/training/reviews?all=1">Everything</Link>
            </Button>
          </div>
        }
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Practical exercises
        </h2>
        {!practicals.success ? (
          <ErrorMessage message={practicals.message} />
        ) : (
          <PracticalReviewQueue
            practicals={practicals.data.items}
            viewerEmployeeCode={access.user.employeeId}
          />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Shadowing
        </h2>
        {!shadowings.success ? (
          <ErrorMessage message={shadowings.message} />
        ) : (
          <ShadowingQueue
            shadowings={shadowings.data.items}
            viewerEmployeeCode={access.user.employeeId}
          />
        )}
      </section>
    </div>
  );
}
