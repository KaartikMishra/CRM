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
import {
  fetchCycleReport,
  fetchPerformanceReviews,
  fetchReviewCycle,
} from '@/lib/performance-api';
import { ReviewTable } from '@/components/hr/performance-tables';
import {
  AddCompetencyForm,
  GenerateReviewsForm,
} from '@/components/hr/performance-forms';
import { CycleLifecycleActions } from '@/components/hr/cycle-actions';
import { CompetencyRow } from '@/components/hr/competency-controls';
import {
  CADENCE_LABELS,
  CYCLE_STATUS_LABELS,
  CYCLE_STATUS_TONES,
  formatAttainment,
  formatPerfDay,
  formatPerfMoment,
  formatPeriod,
  formatRating,
} from '@/components/hr/performance-labels';

export const metadata: Metadata = { title: 'Review Cycle' };

/**
 * One cycle: its terms, its sheet, its reviews and its standing.
 *
 * ### The report is fetched only for somebody entitled to it
 *
 * `/cycles/:id/report` is gated on HR_PERFORMANCE:VIEW rather than the employee
 * floor, because a report is company-wide aggregate data — distributions and
 * departmental averages — that an individual employee has no entitlement to even
 * about a cycle they are in. So it is requested conditionally rather than requested
 * and then hidden, which would mean fetching data this reader may not have.
 */
export default async function CycleDetailPage({
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

  const canManage = can(access.user, 'HR_PERFORMANCE', 'CREATE');
  const canApprove = can(access.user, 'HR_PERFORMANCE', 'APPROVE');
  const isAdministrator = can(access.user, 'HR_PERFORMANCE', 'VIEW');

  const [result, reviews, report] = await Promise.all([
    fetchReviewCycle(id),
    fetchPerformanceReviews({ cycleId: id, limit: '50' }),
    isAdministrator ? fetchCycleReport(id) : Promise.resolve(null),
  ]);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Performance" title="Review cycle" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/performance/cycles">Back to cycles</Link>
          </Button>
        </div>
      </div>
    );
  }

  const cycle = result.data.cycle;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title={cycle.name}
        description={cycle.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={CYCLE_STATUS_TONES[cycle.status]}>
              {CYCLE_STATUS_LABELS[cycle.status]}
            </Badge>
          </div>
        }
      />

      <Card className="flex flex-wrap gap-6 p-4">
        <Figure label="Reference" value={cycle.code} />
        <Figure label="Period" value={formatPeriod(cycle.periodStart, cycle.periodEnd)} />
        <Figure label="Cadence" value={CADENCE_LABELS[cycle.cadence]} />
        <Figure
          label="Covers"
          value={cycle.targetDepartment?.name ?? 'The whole company'}
        />
        <Figure
          label="Self-assessments due"
          value={formatPerfDay(cycle.selfAssessmentDueOn)}
        />
        <Figure label="Manager reviews due" value={formatPerfDay(cycle.managerReviewDueOn)} />
        <Figure label="Reviews" value={String(cycle.reviewCount)} />
        <Figure label="Finalised" value={String(cycle.finalizedCount)} />
      </Card>

      {/*
        The thresholds this cycle judges goals by — stated plainly rather than left
        in the edit form, because somebody reading a cycle needs to know what
        "achieved" means in it. These are per-cycle, not a company constant.
      */}
      <Card className="flex flex-wrap gap-6 p-4">
        <Figure
          label="Goal achieved at"
          value={`${cycle.goalAchievementThreshold}%`}
        />
        <Figure label="Partially met at" value={`${cycle.goalPartialThreshold}%`} />
        <Figure label="Created by" value={cycle.createdBy.name} />
        {cycle.activatedAt && (
          <Figure label="Opened" value={formatPerfMoment(cycle.activatedAt)} />
        )}
        {cycle.closedAt && (
          <Figure label="Closed" value={formatPerfMoment(cycle.closedAt)} />
        )}
      </Card>

      <CycleLifecycleActions cycle={cycle} canApprove={canApprove} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Competencies rated in this cycle
          </h2>
          {canManage && cycle.status === 'DRAFT' && <AddCompetencyForm cycleId={cycle.id} />}
        </div>

        {cycle.competencies.length === 0 ? (
          <Card className="p-4">
            <p className="text-sm text-muted">
              No competencies yet. A cycle with none cannot be opened — its reviews
              would be unratable.
            </p>
          </Card>
        ) : (
          <Card className="flex flex-col gap-2 p-4">
            {cycle.status !== 'DRAFT' && (
              <p className="text-xs text-muted">
                Fixed now the cycle has opened, so everybody in this round is rated on
                the same things.
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {cycle.competencies.map((competency) => (
                /*
                  Edit and remove appear only on a DRAFT cycle and only for somebody
                  holding CREATE. The API refuses both on an open cycle regardless,
                  and refuses removing a competency that has any rating against it —
                  so history is preserved rather than cascaded away.
                */
                <CompetencyRow
                  key={competency.id}
                  competency={competency}
                  cycleId={cycle.id}
                  editable={canManage && cycle.status === 'DRAFT'}
                />
              ))}
            </ul>
          </Card>
        )}
      </section>

      {canApprove && cycle.status === 'ACTIVE' && <GenerateReviewsForm cycleId={cycle.id} />}

      {/* The report, only for somebody entitled to aggregate data. */}
      {report !== null && report.success && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Standing
          </h2>
          <Card className="flex flex-wrap gap-6 p-4">
            <Figure
              label="Average final rating"
              value={formatRating(report.data.report.averageFinalRating)}
            />
            <Figure
              label="Average goal attainment"
              value={formatAttainment(report.data.report.averageGoalAttainment)}
            />
          </Card>

          <Card className="flex flex-col gap-2 p-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Rating distribution
            </span>
            {/*
              Every bucket shows, including the empty ones — a distribution missing
              its empty buckets misrepresents the shape.
            */}
            <ul className="flex flex-wrap gap-6">
              {report.data.report.ratingDistribution.map((bucket) => (
                <li key={bucket.rating} className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted">{bucket.rating} / 5</span>
                  <span className="text-sm font-medium text-ink">{bucket.count}</span>
                </li>
              ))}
            </ul>
          </Card>

          {report.data.report.byDepartment.length > 0 && (
            <Card className="flex flex-col gap-2 p-4">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                By department
              </span>
              <ul className="flex flex-col gap-1.5">
                {report.data.report.byDepartment.map((row) => (
                  <li
                    key={row.department.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2.5"
                  >
                    <span className="text-sm text-ink">{row.department.name}</span>
                    <span className="text-xs text-muted">
                      {row.finalizedCount} of {row.reviewCount} finalised · average{' '}
                      {formatRating(row.averageFinalRating)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}

      {report !== null && !report.success && (
        <ErrorMessage message={report.message} />
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Reviews in this cycle
        </h2>
        {!reviews.success ? (
          <ErrorMessage message={reviews.message} />
        ) : (
          <ReviewTable reviews={reviews.data.items} />
        )}
      </section>
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
