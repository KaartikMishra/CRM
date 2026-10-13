import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchTrainingEnrollment } from '@/lib/training-api';
import { LearningJourney } from '@/components/hr/learning-journey';
import { QualificationPanel } from '@/components/hr/training-review-panels';
import {
  ATTEMPT_STATUS_LABELS,
  ATTEMPT_STATUS_TONES,
  ENROLLMENT_STATUS_LABELS,
  ENROLLMENT_STATUS_TONES,
  formatPercent,
  formatScoreOf,
  formatTrainingMoment,
} from '@/components/hr/training-labels';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = { title: 'Learning' };

/**
 * One enrollment, as the learner works through it.
 *
 * ### Who may open it
 *
 * The same floor as My Learning — `HR_TRAINING:VIEW` or `HR_EMPLOYEE:VIEW` — because
 * the learner holds no training grant. The backend then answers **not found** for an
 * enrollment outside the reader's scope rather than forbidden: telling somebody "you
 * may not see learner X's course" confirms X is doing it. This page relays whatever
 * came back and does not second-guess it.
 *
 * ### The learner identity comes from the record, not the viewer's hopes
 *
 * `isLearner` compares the session's employee code against the enrollment's. Every
 * control that only a learner may use is behind it — and the API refuses everybody
 * else regardless, including an administrator holding every grant, so this decides
 * only what renders.
 *
 * ### Nothing on this page computes a gate
 *
 * `isUnlocked`, `lockedReason`, each attempt's score and `qualificationGaps` all
 * arrive computed. A second copy in the browser would be a second answer, and for the
 * gating ones a second answer would be a learner walking past a gate.
 */
export default async function LearnPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireModule('HR_TRAINING');

  const mayLearn =
    can(access.user, 'HR_TRAINING', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');

  if (!mayLearn) {
    return <NoModuleAccess module="HR_TRAINING" />;
  }

  const { id } = await params;
  const result = await fetchTrainingEnrollment(id);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Training" title="Learning" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/training/my-learning">Back to my learning</Link>
          </Button>
        </div>
      </div>
    );
  }

  const enrollment = result.data.enrollment;
  const isLearner = access.user.employeeId === enrollment.employee.employeeId;
  const canGrant = can(access.user, 'HR_TRAINING', 'APPROVE');

  // Settled attempts only. An in-progress attempt comes back with no questions —
  // the review shape carries the answer key, and in-progress is exactly when the
  // learner must not have it — so listing one here would show an empty result card.
  const settledAttempts = enrollment.attempts.filter(
    (attempt) => attempt.status !== 'IN_PROGRESS',
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Training"
        title={enrollment.program.title}
        description={
          isLearner
            ? 'Work through the steps in order. Each one unlocks the next.'
            : `${enrollment.employee.displayName}'s progress.`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={ENROLLMENT_STATUS_TONES[enrollment.status]}>
              {ENROLLMENT_STATUS_LABELS[enrollment.status]}
            </Badge>
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/training/my-learning">My learning</Link>
            </Button>
          </div>
        }
      />

      <Card className="flex flex-wrap gap-6 p-4">
        <Figure label="Learner" value={enrollment.employee.displayName} />
        <Figure label="Employee" value={enrollment.employee.employeeId} />
        <Figure label="Assigned by" value={enrollment.assignedBy.name} />
        <Figure label="Assigned" value={formatTrainingMoment(enrollment.assignedAt)} />
        {enrollment.startedAt && (
          <Figure label="Started" value={formatTrainingMoment(enrollment.startedAt)} />
        )}
        {enrollment.completedAt && (
          <Figure label="Finished" value={formatTrainingMoment(enrollment.completedAt)} />
        )}
      </Card>

      <LearningJourney enrollment={enrollment} isLearner={isLearner} />

      {/*
        Readiness. The gaps are the server's list — this panel renders them and the
        grant button appears only when the list is empty and the viewer is not the
        learner. The API recomputes the gaps before writing, so a stale page cannot
        clear anybody.
      */}
      <QualificationPanel
        enrollmentId={enrollment.id}
        learnerName={enrollment.employee.displayName}
        gaps={enrollment.qualificationGaps}
        qualification={enrollment.qualification}
        canGrant={canGrant}
        isOwnRecord={isLearner}
      />

      {settledAttempts.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Test history
          </h2>
          <div className="flex flex-col gap-3">
            {settledAttempts.map((attempt) => (
              <Card key={attempt.id} className="flex flex-wrap items-center gap-6 p-4">
                <Figure label="Test" value={attempt.assessmentTitle} />
                <Figure label="Attempt" value={String(attempt.attemptNumber)} />
                <Figure
                  label="Score"
                  value={formatScoreOf(attempt.score, attempt.maxScore)}
                />
                <Figure label="Percentage" value={formatPercent(attempt.percentage)} />
                {/*
                  The threshold as it stood when the attempt was judged, not the
                  program's current one. A pass mark raised afterwards must not
                  retroactively fail somebody who passed under the old number.
                */}
                <Figure
                  label="Pass mark then"
                  value={formatPercent(attempt.passingScore)}
                />
                <Figure
                  label="Submitted"
                  value={
                    attempt.submittedAt ? formatTrainingMoment(attempt.submittedAt) : '—'
                  }
                />
                <Badge variant={ATTEMPT_STATUS_TONES[attempt.status]}>
                  {ATTEMPT_STATUS_LABELS[attempt.status]}
                </Badge>
              </Card>
            ))}
          </div>
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
