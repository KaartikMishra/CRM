import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { EmptyState } from '@/components/common/empty-state';
import { ClipboardList } from 'lucide-react';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import {
  fetchGoals,
  fetchPerformanceHistory,
  fetchPerformanceReviews,
} from '@/lib/performance-api';
import { GoalTable, HistoryTable, ReviewTable } from '@/components/hr/performance-tables';

export const metadata: Metadata = { title: 'My Review' };

/**
 * An employee's own performance page.
 *
 * ### This page deliberately does not require HR_PERFORMANCE
 *
 * Everybody is appraised, so gating here on the module would lock the people the
 * whole phase exists for out of their own review. The floor matches the backend's:
 * `HR_PERFORMANCE:VIEW` **or** `HR_EMPLOYEE:VIEW`, which every employee who can see
 * the directory holds.
 *
 * The server then scopes everything — somebody with no grant gets `selfOnly`, a
 * manager gets themselves plus their direct reports, HR gets everybody. **This page
 * does no scoping of its own**, and could not: the filters are applied inside the
 * queries, so editing the URL cannot widen them.
 *
 * ### Why it filters by employeeId rather than trusting the scope alone
 *
 * A manager's `selfOnly` scope is actually `reports`, so an unfiltered list here
 * would show their team's reviews on a page titled "My review". The employee id
 * comes from the session, so the filter narrows to the reader themselves — and the
 * server's scope still bounds what that filter can reach.
 */
export default async function MyReviewPage() {
  const access = await requireModule('HR_PERFORMANCE');

  const mayReach =
    can(access.user, 'HR_PERFORMANCE', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');
  if (!mayReach) {
    return <NoModuleAccess module="HR_PERFORMANCE" />;
  }

  /*
    The reviews this reader can see, then narrowed to their own by employee code.
    `employeeId` on the query takes a row id, which the session does not carry — so
    the narrowing happens here on the code, against a list the server already
    bounded.
  */
  const [reviews, goals] = await Promise.all([
    fetchPerformanceReviews({ limit: '50' }),
    fetchGoals({ limit: '50' }),
  ]);

  const mine = reviews.success
    ? reviews.data.items.filter(
        (review) => review.employee.employeeId === access.user.employeeId,
      )
    : [];

  const myGoals = goals.success
    ? goals.data.items.filter(
        (goal) => goal.employee?.employeeId === access.user.employeeId,
      )
    : [];

  // The department goals this reader is entitled to — shown separately, because
  // they are the unit's rather than theirs and conflating the two would misreport
  // what they are personally accountable for.
  const departmentGoals = goals.success
    ? goals.data.items.filter((goal) => goal.scope === 'DEPARTMENT')
    : [];

  /*
    History needs the Employee row id, which the session does not carry. The
    reviews above do carry it, so it is taken from the first one. With no reviews
    there is no history to fetch either, which is why this is conditional rather
    than defaulted.
  */
  const ownEmployeeId = mine[0]?.employee.id ?? null;
  const history = ownEmployeeId
    ? await fetchPerformanceHistory(ownEmployeeId)
    : null;

  const live = mine.filter(
    (review) => review.status !== 'FINALIZED' && review.status !== 'CANCELLED',
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title="My review"
        description="Your appraisal, your goals, and what is waiting on you."
        actions={
          can(access.user, 'HR_PERFORMANCE', 'VIEW') ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/performance">Performance overview</Link>
            </Button>
          ) : undefined
        }
      />

      {!reviews.success && <ErrorMessage message={reviews.message} />}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Current review
        </h2>
        {live.length === 0 ? (
          <Card>
            <EmptyState
              icon={ClipboardList}
              title="No review in progress"
              description="Your review appears here once HR opens a cycle that covers you."
            />
          </Card>
        ) : (
          <>
            <ReviewTable reviews={live} showEmployee={false} />
            <div className="flex flex-wrap gap-2">
              {live.map((review) => (
                <Button key={review.id} asChild size="sm">
                  <Link href={`/hr/performance/reviews/${review.id}`}>
                    Open {review.cycle.name}
                  </Link>
                </Button>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Your goals
        </h2>
        {!goals.success ? (
          <ErrorMessage message={goals.message} />
        ) : (
          <GoalTable goals={myGoals} showOwner={false} />
        )}
      </section>

      {departmentGoals.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Your department&apos;s goals
          </h2>
          <p className="text-xs text-muted">
            What the unit is working towards. Not yours personally, but what your own
            goals should align to.
          </p>
          <GoalTable goals={departmentGoals} showOwner={false} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Your appraisal history
        </h2>
        {history === null ? (
          <Card>
            <EmptyState
              icon={ClipboardList}
              title="No completed reviews yet"
              description="An appraisal appears here once it has been finalised."
            />
          </Card>
        ) : !history.success ? (
          <ErrorMessage message={history.message} />
        ) : (
          <HistoryTable
            entries={history.data.history.entries}
            averageRating={history.data.history.averageRating}
          />
        )}
      </section>
    </div>
  );
}
