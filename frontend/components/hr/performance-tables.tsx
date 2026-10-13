import Link from 'next/link';
import { ClipboardList, Target, TrendingUp } from 'lucide-react';
import type {
  DevelopmentPlanSummary,
  GoalSummary,
  PerformanceHistoryEntry,
  PerformanceReviewSummary,
  ReviewCycleSummary,
} from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/common/empty-state';
import {
  CADENCE_LABELS,
  CYCLE_STATUS_LABELS,
  CYCLE_STATUS_TONES,
  GOAL_SCOPE_LABELS,
  GOAL_STATUS_LABELS,
  GOAL_STATUS_TONES,
  PLAN_KIND_LABELS,
  PLAN_KIND_TONES,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_TONES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
  formatAttainment,
  formatPerfDay,
  formatPerfMoment,
  formatPeriod,
  formatRating,
  planProgress,
} from './performance-labels';

/**
 * The Phase 5 tables.
 *
 * Server components: no state, no actions, no client bundle. Every figure arrives
 * computed — `attainment`, `isOverdue`, each rating — and nothing here does
 * arithmetic on one.
 */

// ---------------------------------------------------------------------------
//  Cycles
// ---------------------------------------------------------------------------

export function CycleTable({ cycles }: { cycles: ReviewCycleSummary[] }) {
  if (cycles.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ClipboardList}
          title="No review cycles yet"
          description="Create a cycle and it will appear here."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Cycle</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Cadence</TableHead>
            <TableHead className="text-right">Reviews</TableHead>
            <TableHead className="text-right">Finalised</TableHead>
            <TableHead>Self due</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cycles.map((cycle) => (
            <TableRow key={cycle.id}>
              <TableCell>
                <Link
                  href={`/hr/performance/cycles/${cycle.id}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm font-medium text-ink">{cycle.name}</span>
                  <span className="text-xs text-muted">{cycle.code}</span>
                </Link>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {formatPeriod(cycle.periodStart, cycle.periodEnd)}
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {CADENCE_LABELS[cycle.cadence]}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {cycle.reviewCount}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {cycle.finalizedCount}
              </TableCell>
              <TableCell className="text-sm text-muted">
                {formatPerfDay(cycle.selfAssessmentDueOn)}
              </TableCell>
              <TableCell>
                <Badge variant={CYCLE_STATUS_TONES[cycle.status]}>
                  {CYCLE_STATUS_LABELS[cycle.status]}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

/**
 * The review board.
 *
 * ### The ratings shown here are already filtered by the server
 *
 * `managerOverallRating` is on the summary and is **not** withheld — unlike the
 * manager's narrative and per-competency ratings, which the detail view nulls for
 * the subject until submitted. That asymmetry is the server's: a submitted overall
 * figure is part of the record, and the summary only carries it once
 * `managerSubmittedAt` is set.
 *
 * This component does not decide any of that. It renders what came back.
 */
export function ReviewTable({
  reviews,
  showEmployee = true,
}: {
  reviews: PerformanceReviewSummary[];
  /** Hidden on a learner's own page, where every row is them. */
  showEmployee?: boolean;
}) {
  if (reviews.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ClipboardList}
          title="No reviews"
          description="Reviews appear here once a cycle is opened and its reviews are generated."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {showEmployee && <TableHead>Employee</TableHead>}
            <TableHead>Cycle</TableHead>
            <TableHead>Reviewer</TableHead>
            <TableHead className="text-right">Self</TableHead>
            <TableHead className="text-right">Manager</TableHead>
            <TableHead className="text-right">Final</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reviews.map((review) => (
            <TableRow key={review.id}>
              {showEmployee && (
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-ink">
                      {review.employee.displayName}
                    </span>
                    <span className="text-xs text-muted">{review.employee.employeeId}</span>
                  </div>
                </TableCell>
              )}
              <TableCell>
                <Link
                  href={`/hr/performance/reviews/${review.id}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm text-ink-2">{review.cycle.name}</span>
                  <span className="text-xs text-muted">{review.cycle.code}</span>
                </Link>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {review.reviewer?.displayName ?? (
                  <span className="text-muted">Unassigned — HR writes it</span>
                )}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {formatRating(review.selfOverallRating)}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {formatRating(review.managerOverallRating)}
              </TableCell>
              <TableCell className="text-right text-sm font-medium text-ink">
                {formatRating(review.finalRating)}
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <Badge variant={REVIEW_STATUS_TONES[review.status]}>
                    {REVIEW_STATUS_LABELS[review.status]}
                  </Badge>
                  {/*
                    Overdue flags come from the server, computed against the
                    company-time day — so a colleague abroad is not told their work
                    is late a day early.
                  */}
                  {review.isSelfAssessmentOverdue && (
                    <span className="text-xs text-critical">Self-assessment overdue</span>
                  )}
                  {review.isManagerReviewOverdue && (
                    <span className="text-xs text-critical">Manager review overdue</span>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Goals
// ---------------------------------------------------------------------------

export function GoalTable({
  goals,
  showOwner = true,
}: {
  goals: GoalSummary[];
  showOwner?: boolean;
}) {
  if (goals.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Target}
          title="No goals set"
          description="Goals appear here once somebody sets one."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Goal</TableHead>
            {showOwner && <TableHead>Owner</TableHead>}
            <TableHead>Scope</TableHead>
            <TableHead>Due</TableHead>
            <TableHead className="text-right">Indicators</TableHead>
            <TableHead className="text-right">Attainment</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {goals.map((goal) => (
            <TableRow key={goal.id}>
              <TableCell>
                <Link
                  href={`/hr/performance/goals/${goal.id}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm font-medium text-ink">{goal.title}</span>
                  <span className="text-xs text-muted">{goal.code}</span>
                </Link>
              </TableCell>
              {showOwner && (
                <TableCell className="text-sm text-ink-2">
                  {goal.employee?.displayName ?? goal.department?.name ?? '—'}
                </TableCell>
              )}
              <TableCell className="text-sm text-ink-2">
                {GOAL_SCOPE_LABELS[goal.scope]}
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-ink-2">{formatPerfDay(goal.dueOn)}</span>
                  {goal.isOverdue && <span className="text-xs text-critical">Overdue</span>}
                </div>
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">{goal.kpiCount}</TableCell>
              {/*
                "Not measured" rather than 0% where nothing is recorded. Nothing
                recorded is not the same as nothing achieved, and a goal on track but
                unmeasured must not read as a failure.
              */}
              <TableCell className="text-right text-sm text-ink-2">
                {formatAttainment(goal.attainment)}
              </TableCell>
              <TableCell>
                <Badge variant={GOAL_STATUS_TONES[goal.status]}>
                  {GOAL_STATUS_LABELS[goal.status]}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

export function PlanTable({ plans }: { plans: DevelopmentPlanSummary[] }) {
  if (plans.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={TrendingUp}
          title="No development plans"
          description="Improvement and growth plans appear here."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Plan</TableHead>
            <TableHead>Employee</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Review on</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((plan) => {
            const percent = planProgress(plan.completedActionCount, plan.actionCount);
            return (
              <TableRow key={plan.id}>
                <TableCell>
                  <Link
                    href={`/hr/performance/plans/${plan.id}`}
                    className="text-sm font-medium text-ink hover:underline"
                  >
                    {plan.title}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm text-ink-2">{plan.employee.displayName}</span>
                    <span className="text-xs text-muted">{plan.employee.employeeId}</span>
                  </div>
                </TableCell>
                <TableCell>
                  {/*
                    An improvement plan and a growth plan must not look alike — one
                    is a formal process with consequences, the other is somebody
                    doing well who wants a next step.
                  */}
                  <Badge variant={PLAN_KIND_TONES[plan.kind]}>
                    {PLAN_KIND_LABELS[plan.kind]}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm text-ink-2">{formatPerfDay(plan.reviewOn)}</span>
                    {plan.isOverdue && (
                      <span className="text-xs text-critical">Review overdue</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-ink-2">
                      {plan.completedActionCount} / {plan.actionCount} · {percent}%
                    </span>
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-positive"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={PLAN_STATUS_TONES[plan.status]}>
                    {PLAN_STATUS_LABELS[plan.status]}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  History
// ---------------------------------------------------------------------------

/**
 * One person's appraisal history.
 *
 * Finalized reviews only — that is what the server returns, and the reason a
 * finalized review cannot be edited: this list would otherwise change
 * retroactively.
 */
export function HistoryTable({
  entries,
  averageRating,
}: {
  entries: PerformanceHistoryEntry[];
  averageRating: string | null;
}) {
  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ClipboardList}
          title="No completed reviews yet"
          description="An appraisal appears here once it has been finalised."
        />
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3 overflow-x-auto p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Cycle</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Reviewer</TableHead>
            <TableHead className="text-right">Rating</TableHead>
            <TableHead className="text-right">Goal attainment</TableHead>
            <TableHead>Finalised</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.reviewId}>
              <TableCell>
                <Link
                  href={`/hr/performance/reviews/${entry.reviewId}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm font-medium text-ink">{entry.cycle.name}</span>
                  <span className="text-xs text-muted">{entry.cycle.code}</span>
                </Link>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {formatPeriod(entry.periodStart, entry.periodEnd)}
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {entry.reviewer?.displayName ?? '—'}
              </TableCell>
              <TableCell className="text-right text-sm font-medium text-ink">
                {formatRating(entry.finalRating)}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {formatAttainment(entry.goalAttainment)}
              </TableCell>
              <TableCell className="text-sm text-muted">
                {formatPerfMoment(entry.finalizedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {averageRating !== null && (
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Mean of finalised ratings
          </span>
          <span className="text-sm font-medium text-ink">{formatRating(averageRating)}</span>
        </div>
      )}
    </Card>
  );
}
