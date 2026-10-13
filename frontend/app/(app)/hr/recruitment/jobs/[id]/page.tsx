import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchApplications, fetchCandidates, fetchJob, fetchJobs } from '@/lib/recruitment-api';
import { ApplicationTable } from '@/components/hr/candidate-table';
import { JobActions } from '@/components/hr/job-actions';
import { CreateApplicationForm } from '@/components/hr/recruitment-forms';
import {
  JOB_PRIORITY_LABELS,
  JOB_PRIORITY_TONES,
  JOB_STATUS_LABELS,
  JOB_STATUS_TONES,
  formatDay,
  formatMoment,
  formatRange,
} from '@/components/hr/recruitment-labels';
import { EMPLOYMENT_TYPE_LABELS, WORK_MODE_LABELS } from '@/components/hr/hr-labels';

export const metadata: Metadata = { title: 'Role' };

/**
 * One requisition, with its pipeline.
 *
 * ### The salary range may be absent even on a role the reader can see
 *
 * `salaryRangeMin/Max` arrive as `null` for anybody without HR_RECRUITMENT:VIEW — a
 * hiring manager sees the role they own without seeing what it pays. The field renders a
 * dash in that case, which reads identically to "no range was advertised". That
 * ambiguity is correct: the reader is not entitled to know which it is.
 *
 * ### A missing role is a 404-shaped answer, not a 403
 *
 * The API returns not-found for a requisition out of the reader's scope, deliberately:
 * telling somebody "you may not see role X" confirms X exists, and that the business is
 * hiring for it. This page shows whatever error came back rather than second-guessing it.
 */
export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireModule('HR_RECRUITMENT');
  const { id } = await params;

  const canApprove = access.allowed && can(access.user, 'HR_RECRUITMENT', 'APPROVE');
  const canEdit = access.allowed && can(access.user, 'HR_RECRUITMENT', 'EDIT');
  const canCreate = access.allowed && can(access.user, 'HR_RECRUITMENT', 'CREATE');

  const [result, applications, candidates, jobs] = await Promise.all([
    fetchJob(id),
    fetchApplications({ jobRequisitionId: id, limit: '50' }),
    // For the "add application" picker. Only needed when the viewer may create one.
    canCreate ? fetchCandidates({ isActive: 'true', limit: '100' }) : Promise.resolve(null),
    canCreate ? fetchJobs({ status: 'PUBLISHED', limit: '100' }) : Promise.resolve(null),
  ]);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Recruitment" title="Role" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/recruitment/jobs">Back to roles</Link>
          </Button>
        </div>
      </div>
    );
  }

  const job = result.data.job;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`Recruitment · ${job.code}`}
        title={job.title}
        badge={
          <div className="flex items-center gap-1.5">
            <Badge variant={JOB_STATUS_TONES[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
            {job.priority !== 'NORMAL' && (
              <Badge variant={JOB_PRIORITY_TONES[job.priority]}>
                {JOB_PRIORITY_LABELS[job.priority]}
              </Badge>
            )}
          </div>
        }
        description={`${job.activeApplicationCount} live of ${job.applicationCount} applications`}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/hr/recruitment/jobs">All roles</Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex flex-col gap-3 p-4 lg:col-span-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            The role
          </h2>

          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <Field label="Department" value={job.department?.name ?? '—'} />
            <Field label="Designation" value={job.designation?.name ?? '—'} />
            <Field label="Employment type" value={EMPLOYMENT_TYPE_LABELS[job.employmentType]} />
            <Field label="Work mode" value={WORK_MODE_LABELS[job.workMode]} />
            <Field label="Location" value={job.location ?? '—'} />
            <Field label="Openings" value={String(job.openings)} />
            <Field label="Target joining" value={formatDay(job.targetJoinDate)} />
            <Field
              label="Advertised range"
              value={formatRange(job.salaryRangeMin, job.salaryRangeMax, job.salaryCurrency)}
            />
          </div>

          {job.description && <Section title="About the role" body={job.description} />}
          {job.requirements && <Section title="Requirements" body={job.requirements} />}
          {job.responsibilities && (
            <Section title="Responsibilities" body={job.responsibilities} />
          )}

          <div className="flex flex-col gap-0.5 border-t border-line pt-3 text-xs text-muted">
            <span>Raised by {job.createdBy.name}</span>
            {job.publishedAt && <span>Published {formatMoment(job.publishedAt)}</span>}
            {job.closedAt && <span>Closed {formatMoment(job.closedAt)}</span>}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <JobActions job={job} canPublish={canApprove} canEdit={canEdit} />

          <Card className="flex flex-col gap-2 p-4">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Who is handling it
            </h2>
            <Field label="Hiring manager" value={job.hiringManager?.displayName ?? 'Not set'} />
            <Field label="Recruiter" value={job.recruiter?.displayName ?? 'Not set'} />
          </Card>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Pipeline
          </h2>
          {canCreate && candidates?.success && jobs?.success && (
            <CreateApplicationForm
              jobs={jobs.data.items}
              candidates={candidates.data.items}
              fixedJobId={job.id}
            />
          )}
        </div>

        {!applications.success ? (
          <ErrorMessage message={applications.message} />
        ) : (
          <ApplicationTable applications={applications.data.items} showJob={false} />
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <span className="font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className="text-ink-2">{value}</span>
    </div>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
      </span>
      {/* `whitespace-pre-line` so a pasted job description keeps its paragraphs. */}
      <p className="whitespace-pre-line text-sm text-ink-2">{body}</p>
    </div>
  );
}
