import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchPerformanceOverview } from '@/lib/performance-api';

export const metadata: Metadata = { title: 'Performance' };

/**
 * The performance dashboard.
 *
 * ### Who lands here
 *
 * Anybody who can reach the module *or* the employee floor — because the dashboard
 * carries "what you owe", and an employee who could not see their own outstanding
 * self-assessment would have no way to find it. That mirrors the backend's
 * `EMPLOYEE_FLOOR` on `/performance/overview`.
 *
 * ### The numbers are the server's, counted properly
 *
 * Real aggregate counts from the database, each scoped server-side — so a department
 * head's figures are their department's and an employee's are their own. The same
 * approach Phase 4's training overview takes, and for the same reason: a count
 * derived from the length of a page silently stops being a count at page 2.
 *
 * This page does no scoping of its own and could not: the filters are applied inside
 * the queries, so editing the URL cannot widen them.
 */
export default async function PerformancePage() {
  const access = await requireModule('HR_PERFORMANCE');

  // The backend's own floor, mirrored. Not `access.allowed` alone — everybody is
  // appraised, so requiring the module would lock out the people the phase is for.
  const mayReach =
    can(access.user, 'HR_PERFORMANCE', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');

  if (!mayReach) {
    return <NoModuleAccess module="HR_PERFORMANCE" />;
  }

  const canManage = can(access.user, 'HR_PERFORMANCE', 'CREATE');
  const canApprove = can(access.user, 'HR_PERFORMANCE', 'APPROVE');
  const canAssign = can(access.user, 'HR_PERFORMANCE', 'ASSIGN');
  const isAdministrator = can(access.user, 'HR_PERFORMANCE', 'VIEW');

  const result = await fetchPerformanceOverview();

  const overview = result.success ? result.data.overview : null;

  /*
    Two groups of tiles. "What you owe" first, because it is actionable by the person
    reading — and for an ordinary employee it is the only part that concerns them.
  */
  const mine = overview
    ? [
        {
          label: 'Your review',
          value: overview.myOwnReviewPending ? 'Waiting on you' : 'Nothing to do',
          href: '/hr/performance/my-review',
          alarming: overview.myOwnReviewPending,
        },
        {
          label: 'Reviews to write',
          value: String(overview.myReviewsToWrite),
          href: '/hr/performance/reviews?mineToWrite=true',
          alarming: overview.myReviewsToWrite > 0,
        },
      ]
    : [];

  const company = overview
    ? [
        {
          label: 'Open cycles',
          value: overview.activeCycles,
          href: '/hr/performance/cycles?status=ACTIVE',
        },
        {
          label: 'Not started',
          value: overview.reviewsNotStarted,
          href: '/hr/performance/reviews?status=NOT_STARTED',
        },
        {
          label: 'Awaiting manager',
          value: overview.reviewsAwaitingManager,
          href: '/hr/performance/reviews?status=PENDING_MANAGER',
        },
        {
          label: 'Awaiting approval',
          value: overview.reviewsAwaitingApproval,
          href: '/hr/performance/reviews?status=PENDING_APPROVAL',
        },
        {
          label: 'Finalised',
          value: overview.reviewsFinalized,
          href: '/hr/performance/reviews?status=FINALIZED',
        },
        {
          label: 'Self-assessments overdue',
          value: overview.selfAssessmentsOverdue,
          href: '/hr/performance/reviews?overdueOnly=true',
          alarming: true,
        },
        {
          label: 'Manager reviews overdue',
          value: overview.managerReviewsOverdue,
          href: '/hr/performance/reviews?overdueOnly=true',
          alarming: true,
        },
        {
          label: 'Open improvement plans',
          value: overview.openImprovementPlans,
          href: '/hr/performance/plans?kind=IMPROVEMENT&status=OPEN',
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Performance"
        description="Appraisal cycles, goals, and where each review stands."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/performance/my-review">My review</Link>
            </Button>
            {isAdministrator && (
              <Button asChild size="sm" variant="outline">
                <Link href="/hr/performance/reviews">All reviews</Link>
              </Button>
            )}
            <Button asChild size="sm">
              <Link href="/hr/performance/goals">Goals</Link>
            </Button>
          </div>
        }
      />

      {!result.success && <ErrorMessage message={result.message} />}

      {overview && (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              What you owe
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {mine.map((tile) => (
                <Link key={tile.label} href={tile.href}>
                  <Card className="flex h-full flex-col gap-1 p-4 transition-colors hover:bg-surface-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {tile.label}
                    </span>
                    <span
                      className={
                        tile.alarming
                          ? 'text-lg font-semibold text-accent'
                          : 'text-lg font-semibold text-ink'
                      }
                    >
                      {tile.value}
                    </span>
                  </Card>
                </Link>
              ))}
            </div>
          </section>

          {/*
            The company figures show only for somebody holding the module. An
            employee scoped to themselves would see their own single review
            reported as a company total, which reads as though the business has one
            employee.
          */}
          {isAdministrator && (
            <section className="flex flex-col gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Across the business
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {company.map((tile) => (
                  <Link key={tile.label} href={tile.href}>
                    <Card className="flex h-full flex-col gap-1 p-4 transition-colors hover:bg-surface-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                        {tile.label}
                      </span>
                      {/*
                        A non-zero overdue figure is coloured; zero is not. A red
                        nought reads as a problem when it is the opposite.
                      */}
                      <span
                        className={
                          tile.alarming && tile.value > 0
                            ? 'text-2xl font-semibold text-critical'
                            : 'text-2xl font-semibold text-ink'
                        }
                      >
                        {tile.value}
                      </span>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <Card className="flex flex-wrap gap-6 p-4">
            <Figure label="Active goals" value={String(overview.activeGoals)} />
            <Figure label="Goals achieved" value={String(overview.goalsAchieved)} />
            <Figure label="Goals overdue" value={String(overview.goalsOverdue)} />
          </Card>
        </>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Where to go
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NavCard
            href="/hr/performance/my-review"
            title="My review"
            description="Your own self-assessment and its outcome."
          />
          <NavCard
            href="/hr/performance/goals"
            title="Goals"
            description="Individual and department goals, with their indicators."
          />
          {isAdministrator && (
            <NavCard
              href="/hr/performance/cycles"
              title="Cycles"
              description="Appraisal periods, competency sheets and their reviews."
            />
          )}
          <NavCard
            href="/hr/performance/plans"
            title="Development plans"
            description="Improvement and growth plans, and their actions."
          />
        </div>
      </section>

      {(canManage || canAssign || canApprove) && (
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <Button asChild size="sm">
              <Link href="/hr/performance/cycles/new">Create a cycle</Link>
            </Button>
          )}
          {canAssign && (
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/performance/goals/new">Set a goal</Link>
            </Button>
          )}
        </div>
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
      <span className="text-lg font-medium text-ink">{value}</span>
    </div>
  );
}

function NavCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link href={href}>
      <Card className="flex h-full flex-col gap-1 p-4 transition-colors hover:bg-surface-2">
        <span className="text-sm font-medium text-ink">{title}</span>
        <span className="text-xs text-muted">{description}</span>
      </Card>
    </Link>
  );
}
