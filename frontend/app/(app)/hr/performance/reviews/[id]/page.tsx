import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchPerformanceReview } from '@/lib/performance-api';
import { GoalTable } from '@/components/hr/performance-tables';
import {
  FinalizationPanel,
  ManagerAssessmentPanel,
  NextStepBanner,
  RatingComparison,
  SelfAssessmentPanel,
} from '@/components/hr/review-panels';
import {
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
  formatAttainment,
  formatPerfMoment,
  formatRating,
} from '@/components/hr/performance-labels';

export const metadata: Metadata = { title: 'Review' };

/**
 * One review.
 *
 * ### Everything on this page was decided by the server
 *
 * `review.viewerCan` gates every control. `review.managerAssessment` is already null
 * for an employee whose manager has not submitted — and so are that manager's
 * per-competency ratings. The page renders what came back and asks nothing twice.
 *
 * That is the whole design: the rules are not derivable from the status alone
 * (whether somebody may write the manager assessment depends on who they are
 * relative to this employee), so the server answers and the page obeys. And the API
 * enforces each rule again on every write, so a stale page cannot act on a stale
 * answer.
 *
 * ### Not found rather than forbidden
 *
 * A review outside the reader's scope returns 404. Telling somebody "you may not
 * read employee X's review" would confirm X is being appraised and by whom.
 */
export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireModule('HR_PERFORMANCE');

  const mayReach =
    can(access.user, 'HR_PERFORMANCE', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');
  if (!mayReach) {
    return <NoModuleAccess module="HR_PERFORMANCE" />;
  }

  const { id } = await params;
  const result = await fetchPerformanceReview(id);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Performance" title="Review" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/performance/reviews">Back to reviews</Link>
          </Button>
        </div>
      </div>
    );
  }

  const review = result.data.review;

  /*
    Whether the viewer is the subject — **from the server**, not computed here.

    The obvious client-side test is to compare the session's `employeeId` against
    `review.employee.employeeId`, and it is wrong: `User.employeeId` and
    `Employee.employeeId` are different columns. They share one allocation series so
    they usually agree for a linked person, but linking an account does not sync
    them — so the comparison can be false for the actual subject, who would then be
    shown somebody else's view of their own review.

    `viewerIsSubject` is answered from `Employee.userId` against the actor's id,
    which is unambiguous.
  */
  const isSubject = review.viewerIsSubject;

  // Whether the manager's half has been shared, read off the record rather than
  // inferred from the status — the server's filtering is what actually decides.
  const managerVisible = review.managerAssessment !== null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title={isSubject ? 'Your review' : `${review.employee.displayName}'s review`}
        description={`${review.cycle.name} · ${review.cycle.code}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={REVIEW_STATUS_TONES[review.status]}>
              {REVIEW_STATUS_LABELS[review.status]}
            </Badge>
            <Button asChild size="sm" variant="outline">
              <Link href={`/hr/performance/history/${review.employee.id}`}>History</Link>
            </Button>
          </div>
        }
      />

      {isSubject && <NextStepBanner review={review} />}

      <Card className="flex flex-wrap gap-6 p-4">
        <Figure label="Employee" value={review.employee.displayName} />
        <Figure label="Employee id" value={review.employee.employeeId} />
        <Figure
          label="Reviewer"
          value={review.reviewer?.displayName ?? 'Unassigned — HR writes it'}
        />
        <Figure label="Self rating" value={formatRating(review.selfOverallRating)} />
        {/*
          The manager's overall figure shows only once shared. The summary carries it
          from `managerSubmittedAt` onwards, which is the server's own gate.
        */}
        <Figure
          label="Manager rating"
          value={
            managerVisible || !isSubject
              ? formatRating(review.managerOverallRating)
              : 'Not shared yet'
          }
        />
        <Figure label="Final rating" value={formatRating(review.finalRating)} />
        <Figure label="Goal attainment" value={formatAttainment(review.goalAttainment)} />
        {review.selfSubmittedAt && (
          <Figure
            label="Self submitted"
            value={formatPerfMoment(review.selfSubmittedAt)}
          />
        )}
      </Card>

      {(review.isSelfAssessmentOverdue || review.isManagerReviewOverdue) && (
        <Card className="border-critical/30 bg-critical-soft p-4">
          <p className="text-sm text-critical">
            {review.isSelfAssessmentOverdue
              ? 'The self-assessment is past its due date.'
              : 'The manager review is past its due date.'}
          </p>
        </Card>
      )}

      <SelfAssessmentPanel review={review} />

      <ManagerAssessmentPanel review={review} isSubject={isSubject} />

      <RatingComparison
        ratings={review.competencyRatings}
        managerVisible={managerVisible}
      />

      <FinalizationPanel review={review} isSubject={isSubject} />

      {review.goals.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Goals appraised in this review
          </h2>
          <GoalTable goals={review.goals} showOwner={false} />
        </section>
      )}

      {review.developmentPlans.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Development plans from this review
          </h2>
          <ul className="flex flex-col gap-2">
            {review.developmentPlans.map((plan) => (
              <li key={plan.id}>
                <Link
                  href={`/hr/performance/plans/${plan.id}`}
                  className="text-sm text-accent hover:underline"
                >
                  {plan.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="text-sm font-medium text-ink">{value}</span>
    </div>
  );
}
