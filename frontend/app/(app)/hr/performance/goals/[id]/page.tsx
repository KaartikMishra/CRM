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
import { fetchGoal } from '@/lib/performance-api';
import { GoalLifecyclePanel, KpiPanel } from '@/components/hr/goal-panels';
import {
  GOAL_SCOPE_LABELS,
  GOAL_STATUS_LABELS,
  GOAL_STATUS_TONES,
  formatAttainment,
  formatPerfDay,
  formatPerfMoment,
} from '@/components/hr/performance-labels';

export const metadata: Metadata = { title: 'Goal' };

/**
 * One goal, with its measurable indicators.
 *
 * ### Who may do what
 *
 * The owner records progress on their own goal — they are the one who knows the
 * number — but cannot edit the target or close it. That asymmetry is the point: a
 * goal somebody can rewrite is not a target, and declaring your own target achieved
 * is the same act as approving your own review.
 *
 * The flags below are a courtesy. The API refuses each of these independently, and
 * `isOwner` is computed from the employee code the session carries rather than from
 * anything the page could be told.
 */
export default async function GoalDetailPage({
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
  const result = await fetchGoal(id);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Performance" title="Goal" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/performance/goals">Back to goals</Link>
          </Button>
        </div>
      </div>
    );
  }

  const goal = result.data.goal;

  /*
    The viewer's relationship to this goal, compared on the employee *code* — which
    is what `/api/auth/me` carries. Comparing against the row id would be false for
    everybody, silently showing an owner the controls they must not have.
  */
  const isOwner =
    goal.employee !== null && goal.employee.employeeId === access.user.employeeId;

  /*
    Never the owner, whatever they hold — the API refuses the subject before any
    permission check, and rendering a button that always 403s would be worse than
    rendering none. A manager's own authority over a report's goal is a fact about
    rows the API knows and this page does not, so the floor here is deliberately
    permissive and the API is the control.
  */
  const canEdit = !isOwner;
  const canClose = !isOwner;
  const canRecord = true;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title={goal.title}
        description={goal.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={GOAL_STATUS_TONES[goal.status]}>
              {GOAL_STATUS_LABELS[goal.status]}
            </Badge>
          </div>
        }
      />

      <Card className="flex flex-wrap gap-6 p-4">
        <Figure label="Reference" value={goal.code} />
        <Figure label="Scope" value={GOAL_SCOPE_LABELS[goal.scope]} />
        <Figure
          label="Owner"
          value={goal.employee?.displayName ?? goal.department?.name ?? '—'}
        />
        <Figure label="Runs from" value={formatPerfDay(goal.startOn)} />
        <Figure label="Due" value={formatPerfDay(goal.dueOn)} />
        <Figure label="Weight" value={goal.weight} />
        {/*
          "Not measured" rather than 0% where nothing is recorded. A goal on track
          but unmeasured must not read as a failure.
        */}
        <Figure label="Attainment" value={formatAttainment(goal.attainment)} />
        <Figure label="Cycle" value={goal.cycle?.name ?? 'Not tied to a cycle'} />
        <Figure label="Created by" value={goal.createdBy.name} />
        <Figure label="Created" value={formatPerfMoment(goal.createdAt)} />
      </Card>

      {goal.isOverdue && (
        <Card className="border-critical/30 bg-critical-soft p-4">
          <p className="text-sm text-critical">
            Past its due date of {formatPerfDay(goal.dueOn)} and not yet closed.
          </p>
        </Card>
      )}

      {goal.successCriteria && (
        <Card className="flex flex-col gap-1 p-4">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            How success was defined
          </span>
          <p className="whitespace-pre-line text-sm text-ink-2">{goal.successCriteria}</p>
          <span className="text-xs text-muted">
            Kept verbatim — this is what was originally agreed.
          </span>
        </Card>
      )}

      <GoalLifecyclePanel
        goal={goal}
        canActivate={canEdit}
        canClose={canClose}
        isOwner={isOwner}
      />

      <KpiPanel goal={goal} canEdit={canEdit} canRecord={canRecord} />
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
