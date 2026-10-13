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
import { fetchDepartments, fetchDesignations } from '@/lib/hr-api';
import { fetchTrainingCategories, fetchTrainingEnrollments, fetchTrainingProgram } from '@/lib/training-api';
import { EnrollmentTable } from '@/components/hr/training-tables';
import { ProgramForm } from '@/components/hr/training-forms';
import { AddModuleForm } from '@/components/hr/training-forms';
import { ModuleSequence, ProgramLifecycleActions } from '@/components/hr/program-authoring';
import {
  OBLIGATION_LABELS,
  OBLIGATION_TONES,
  PROGRAM_STATUS_LABELS,
  PROGRAM_STATUS_TONES,
  formatDuration,
  formatPercent,
  formatTrainingMoment,
} from '@/components/hr/training-labels';

export const metadata: Metadata = { title: 'Training Program' };

/**
 * One program: what it teaches, in what order, and who is doing it.
 *
 * ### Editing is a tab-less toggle on the same page
 *
 * `?edit=1` renders the form over the detail rather than at its own route. A program is
 * mostly a sequence of steps, and sending somebody to a separate edit page to change a
 * pass mark would lose the sequence they were looking at.
 *
 * ### The sequence is data, not a state machine
 *
 * Every step is an ordinary row. The thirteen-step required journey is a seeding
 * template, applied once at creation, and nothing reads it afterwards — which is why
 * steps can be reordered, removed and added here at all.
 */
export default async function TrainingProgramDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_TRAINING');
  if (!access.allowed) {
    return <NoModuleAccess module="HR_TRAINING" />;
  }

  const { id } = await params;
  const query = await searchParams;
  const editing = query.edit === '1';

  const canEdit = can(access.user, 'HR_TRAINING', 'EDIT');
  const canApprove = can(access.user, 'HR_TRAINING', 'APPROVE');

  const [result, enrollments, categories, departments, designations] = await Promise.all([
    fetchTrainingProgram(id),
    fetchTrainingEnrollments({ programId: id, limit: '50' }),
    // Only needed for the edit form, but cheap and it keeps the request count fixed.
    canEdit ? fetchTrainingCategories({ status: 'ACTIVE' }) : Promise.resolve(null),
    canEdit ? fetchDepartments({ status: 'ACTIVE', limit: '100' }) : Promise.resolve(null),
    canEdit ? fetchDesignations({ status: 'ACTIVE', limit: '100' }) : Promise.resolve(null),
  ]);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Training" title="Program" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/training/programs">Back to programs</Link>
          </Button>
        </div>
      </div>
    );
  }

  const program = result.data.program;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Training"
        title={program.title}
        description={program.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={PROGRAM_STATUS_TONES[program.status]}>
              {PROGRAM_STATUS_LABELS[program.status]}
            </Badge>
            <Badge variant={OBLIGATION_TONES[program.obligation]}>
              {OBLIGATION_LABELS[program.obligation]}
            </Badge>
            {canEdit && !editing && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/hr/training/programs/${program.id}?edit=1`}>Edit</Link>
              </Button>
            )}
            {editing && (
              <Button asChild size="sm" variant="ghost">
                <Link href={`/hr/training/programs/${program.id}`}>Stop editing</Link>
              </Button>
            )}
          </div>
        }
      />

      {editing && canEdit ? (
        <ProgramForm
          categories={categories?.success ? categories.data.categories : []}
          departments={departments?.success ? departments.data.departments : []}
          designations={designations?.success ? designations.data.designations : []}
          program={program}
        />
      ) : (
        <>
          <Card className="flex flex-wrap gap-6 p-4">
            <Figure label="Reference" value={program.code} />
            <Figure label="Pass mark" value={formatPercent(program.passingScore)} />
            <Figure label="Attempts allowed" value={String(program.maxAttempts)} />
            <Figure label="Steps" value={String(program.moduleCount)} />
            <Figure label="Enrolled" value={String(program.enrolledCount)} />
            <Figure label="Finished" value={String(program.completedCount)} />
            <Figure label="Effort" value={formatDuration(program.estimatedMinutes)} />
            <Figure
              label="Due within"
              value={program.dueWithinDays ? `${program.dueWithinDays} days` : '—'}
            />
            <Figure label="Category" value={program.category?.name ?? '—'} />
            <Figure
              label="Intended for"
              value={
                program.targetDepartment?.name ??
                program.targetDesignation?.name ??
                'Everybody'
              }
            />
          </Card>

          {program.objectives && (
            <Card className="flex flex-col gap-1 p-4">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                What the learner will be able to do
              </span>
              <p className="whitespace-pre-line text-sm text-ink-2">{program.objectives}</p>
            </Card>
          )}

          {/*
            The gates. These flags are what the server computes `qualificationGaps`
            from, so they are stated plainly rather than hidden in the edit form —
            somebody reading a program needs to know what it actually requires.
          */}
          <Card className="flex flex-col gap-2 p-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Required before live work
            </span>
            <ul className="flex flex-col gap-1 text-sm text-ink-2">
              <Gate on={program.requiresPractical} label="An approved practical exercise" />
              <Gate on={program.requiresShadowing} label="A signed-off shadowing period" />
              <Gate
                on={program.requiresFinalAssessment}
                label="A passed final assessment"
              />
            </ul>
            <span className="text-xs text-muted">
              Created by {program.createdBy.name} · {formatTrainingMoment(program.createdAt)}
              {program.publishedAt
                ? ` · published ${formatTrainingMoment(program.publishedAt)}`
                : ''}
              {program.archivedAt
                ? ` · retired ${formatTrainingMoment(program.archivedAt)}`
                : ''}
            </span>
          </Card>

          <ProgramLifecycleActions program={program} canApprove={canApprove} />

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                The sequence
              </h2>
              {canEdit && <AddModuleForm programId={program.id} />}
            </div>
            <ModuleSequence program={program} canEdit={canEdit} />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Who is doing this
            </h2>
            {!enrollments.success ? (
              <ErrorMessage message={enrollments.message} />
            ) : (
              <EnrollmentTable enrollments={enrollments.data.items} />
            )}
          </section>
        </>
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

function Gate({ on, label }: { on: boolean; label: string }) {
  return (
    <li className={on ? 'text-ink-2' : 'text-muted line-through'}>
      {label}
      {on ? '' : ' — not required by this program'}
    </li>
  );
}
