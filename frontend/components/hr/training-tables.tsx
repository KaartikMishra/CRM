import Link from 'next/link';
import { GraduationCap, Users } from 'lucide-react';
import type {
  TrainingEnrollmentSummary,
  TrainingProgramSummary,
  TrainingQualificationView,
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
  ASSIGNMENT_SOURCE_LABELS,
  ENROLLMENT_STATUS_LABELS,
  ENROLLMENT_STATUS_TONES,
  OBLIGATION_LABELS,
  OBLIGATION_TONES,
  PROGRAM_STATUS_LABELS,
  PROGRAM_STATUS_TONES,
  formatDuration,
  formatPercent,
  formatTrainingDay,
  formatTrainingMoment,
  trainingProgress,
} from './training-labels';

/**
 * The training catalogue.
 *
 * Shows the pass mark and the attempt allowance per row, because those are the two
 * numbers that differ between programs and the two a trainer checks before assigning.
 * Both come from the server as decimal strings; nothing here does arithmetic on them.
 */
export function ProgramTable({ programs }: { programs: TrainingProgramSummary[] }) {
  if (programs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={GraduationCap}
          title="No training programs yet"
          description="Create a program and it will appear here."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Program</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>For</TableHead>
            <TableHead className="text-right">Steps</TableHead>
            <TableHead className="text-right">Pass mark</TableHead>
            <TableHead className="text-right">Enrolled</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {programs.map((program) => (
            <TableRow key={program.id}>
              <TableCell>
                <Link
                  href={`/hr/training/programs/${program.id}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm font-medium text-ink">{program.title}</span>
                  <span className="text-xs text-muted">{program.code}</span>
                </Link>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {program.category?.name ?? '—'}
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {program.targetDepartment?.name ?? program.targetDesignation?.name ?? 'Everybody'}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {program.moduleCount}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {formatPercent(program.passingScore)}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {program.enrolledCount}
                <span className="text-muted"> / {program.completedCount} done</span>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {formatDuration(program.estimatedMinutes)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={PROGRAM_STATUS_TONES[program.status]}>
                    {PROGRAM_STATUS_LABELS[program.status]}
                  </Badge>
                  {/* Shown only when required — a badge saying "Optional" on every row
                      is noise that makes the required ones harder to spot. */}
                  {program.obligation === 'MANDATORY' && (
                    <Badge variant={OBLIGATION_TONES.MANDATORY}>
                      {OBLIGATION_LABELS.MANDATORY}
                    </Badge>
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

/**
 * The enrollment board.
 *
 * `isOverdue` arrives computed by the server against the company-time day, not
 * recomputed here — so a colleague abroad does not see work flagged overdue a day
 * early. Progress likewise comes from the two server counts.
 */
export function EnrollmentTable({
  enrollments,
  showLearner = true,
}: {
  enrollments: TrainingEnrollmentSummary[];
  /** Hidden on a learner's own page, where every row is them. */
  showLearner?: boolean;
}) {
  if (enrollments.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title="Nobody is enrolled"
          description="Assign a published program and enrollments appear here."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {showLearner && <TableHead>Learner</TableHead>}
            <TableHead>Program</TableHead>
            <TableHead>Assigned</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Why</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {enrollments.map((enrollment) => {
            const percent = trainingProgress(
              enrollment.completedModuleCount,
              enrollment.requiredModuleCount,
            );

            return (
              <TableRow key={enrollment.id}>
                {showLearner && (
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-ink">
                        {enrollment.employee.displayName}
                      </span>
                      <span className="text-xs text-muted">
                        {enrollment.employee.employeeId}
                      </span>
                    </div>
                  </TableCell>
                )}
                <TableCell>
                  <Link
                    href={`/hr/training/learn/${enrollment.id}`}
                    className="flex flex-col gap-0.5 hover:underline"
                  >
                    <span className="text-sm text-ink-2">{enrollment.program.title}</span>
                    <span className="text-xs text-muted">{enrollment.program.code}</span>
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted">
                  {formatTrainingDay(enrollment.assignedAt.slice(0, 10))}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm text-ink-2">
                      {formatTrainingDay(enrollment.dueOn)}
                    </span>
                    {enrollment.isOverdue && (
                      <span className="text-xs text-critical">Overdue</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-ink-2">
                      {enrollment.completedModuleCount} / {enrollment.requiredModuleCount} ·{' '}
                      {percent}%
                    </span>
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-positive"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted">
                  {ASSIGNMENT_SOURCE_LABELS[enrollment.assignedVia]}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={ENROLLMENT_STATUS_TONES[enrollment.status]}>
                      {ENROLLMENT_STATUS_LABELS[enrollment.status]}
                    </Badge>
                    {enrollment.obligation === 'MANDATORY' && (
                      <Badge variant="accent">Required</Badge>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

/**
 * Who is cleared for live work.
 *
 * A revoked qualification stays in the list rather than disappearing: that somebody
 * was cleared and then was not is exactly the history worth having, and a list that
 * silently dropped them would make the revocation invisible.
 */
export function QualificationTable({
  qualifications,
}: {
  qualifications: TrainingQualificationView[];
}) {
  if (qualifications.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={GraduationCap}
          title="Nobody qualified yet"
          description="Qualification is granted once every required step of a program is complete."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Employee</TableHead>
            <TableHead>Program</TableHead>
            <TableHead>Qualified</TableHead>
            <TableHead className="text-right">Final score</TableHead>
            <TableHead>Certificate</TableHead>
            <TableHead>Granted by</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {qualifications.map((qualification) => (
            <TableRow key={qualification.id}>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-ink">
                    {qualification.employee.displayName}
                  </span>
                  <span className="text-xs text-muted">
                    {qualification.employee.employeeId}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {qualification.program.title}
              </TableCell>
              <TableCell className="text-sm text-muted">
                {formatTrainingMoment(qualification.qualifiedAt)}
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {formatPercent(qualification.finalScore)}
              </TableCell>
              <TableCell className="text-xs text-muted">
                {qualification.certificateCode ?? '—'}
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {qualification.grantedBy.name}
              </TableCell>
              <TableCell>
                {qualification.isActive ? (
                  <Badge variant="positive">Cleared</Badge>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <Badge variant="critical">Revoked</Badge>
                    {qualification.revocationReason && (
                      <span className="text-xs text-muted">
                        {qualification.revocationReason}
                      </span>
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
