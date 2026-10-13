import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDepartments, fetchDesignations, fetchEmployees } from '@/lib/hr-api';
import { fetchApplication } from '@/lib/recruitment-api';
import { AtsPipeline, StageHistory } from '@/components/hr/ats-pipeline';
import { InterviewList } from '@/components/hr/interview-panel';
import { OfferList } from '@/components/hr/offer-panel';
import {
  CreateOfferForm,
  RequestBackgroundCheckForm,
  ScheduleInterviewForm,
  StartOnboardingForm,
} from '@/components/hr/recruitment-forms';
import {
  ASSESSMENT_STATUS_LABELS,
  ASSESSMENT_STATUS_TONES,
  BACKGROUND_CHECK_STATUS_LABELS,
  BACKGROUND_CHECK_STATUS_TONES,
  BACKGROUND_CHECK_TYPE_LABELS,
  CANDIDATE_SOURCE_LABELS,
  formatDay,
  formatMoment,
  formatScore,
} from '@/components/hr/recruitment-labels';

export const metadata: Metadata = { title: 'Application' };

/**
 * One application — the hub the whole phase converges on.
 *
 * ### Three things on this page may be absent for reasons other than "not recorded"
 *
 *   `screeningNotes`    stripped for anybody without HR_RECRUITMENT:VIEW. An interviewer
 *                       reading "weak on the phone screen" has been told the answer
 *                       before forming their own view.
 *   `backgroundChecks`  arrives as an empty array for the same reader. A verification
 *                       result ends somebody's prospects, and only the people
 *                       accountable for the decision should hold it.
 *   interview feedback  filtered by the panel rule — see the interview page.
 *
 * In every case the narrowing happens server-side and this page renders what it was
 * given. There is no client-side filter, because a filter here would mean the data had
 * already been sent to a browser where anybody can read it in a network tab. **An empty
 * section is the protection working**, which is why each one says so rather than
 * implying nothing exists.
 */
export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireModule('HR_RECRUITMENT');
  const { id } = await params;

  const canView = access.allowed && can(access.user, 'HR_RECRUITMENT', 'VIEW');
  const canEdit = access.allowed && can(access.user, 'HR_RECRUITMENT', 'EDIT');
  const canCreate = access.allowed && can(access.user, 'HR_RECRUITMENT', 'CREATE');
  const canDecide = access.allowed && can(access.user, 'HR_RECRUITMENT', 'APPROVE');

  const result = await fetchApplication(id);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Recruitment" title="Application" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/recruitment/applications">Back to applications</Link>
          </Button>
        </div>
      </div>
    );
  }

  const application = result.data.application;
  const latestOffer = application.offers[0] ?? null;
  const acceptedOffer = application.offers.find((offer) => offer.status === 'ACCEPTED') ?? null;

  /*
    Lookups for the forms, fetched only when the viewer can use them. An interviewer who
    cannot schedule or offer has no reason to cost three extra requests.
  */
  const [departments, designations, employees] = await Promise.all([
    canDecide ? fetchDepartments({ status: 'ACTIVE', limit: '100' }) : Promise.resolve(null),
    canDecide ? fetchDesignations({ status: 'ACTIVE', limit: '200' }) : Promise.resolve(null),
    canCreate || canDecide
      ? fetchEmployees({ employedOnly: 'true', limit: '200' })
      : Promise.resolve(null),
  ]);

  const panelCandidates =
    employees?.success
      ? employees.data.employees.map((e) => ({ id: e.id, displayName: e.displayName }))
      : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title={application.candidate.displayName}
        description={`${application.job.title} · ${application.job.code}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/hr/recruitment/candidates/${application.candidate.id}`}>
                Candidate
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={`/hr/recruitment/jobs/${application.job.id}`}>Role</Link>
            </Button>
          </div>
        }
      />

      <AtsPipeline application={application} canMove={canEdit} canDecide={canDecide} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Application
          </h2>
          <Field label="Applied" value={formatDay(application.appliedAt.slice(0, 10))} />
          <Field label="Source" value={CANDIDATE_SOURCE_LABELS[application.source]} />
          <Field label="Recruiter" value={application.recruiter?.displayName ?? 'Not set'} />
          <Field
            label="Hiring manager"
            value={application.hiringManager?.displayName ?? 'Not set'}
          />
          {application.selectedBy && (
            <Field
              label="Selected by"
              value={`${application.selectedBy.name}${
                application.selectedAt ? ` · ${formatMoment(application.selectedAt)}` : ''
              }`}
            />
          )}
        </Card>

        <Card className="flex flex-col gap-2 p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Screening
          </h2>
          {canView ? (
            <>
              <Field
                label="Score"
                value={
                  application.screeningScore === null
                    ? 'Not scored'
                    : `${application.screeningScore} / 100`
                }
              />
              <p className="text-sm text-ink-2">
                {application.screeningNotes ?? 'No screening notes recorded.'}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">
              Screening notes are visible to the recruitment team only.
            </p>
          )}
        </Card>

        <Card className="flex flex-col gap-3 p-4 lg:col-span-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Stage history
          </h2>
          <StageHistory application={application} />
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Interviews
          </h2>
          {canCreate && application.status === 'ACTIVE' && (
            <ScheduleInterviewForm applicationId={application.id} employees={panelCandidates} />
          )}
        </div>
        <Card className="p-4">
          <InterviewList interviews={application.interviews} />
          {application.interviews.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Open an interview to give or read feedback.
            </p>
          )}
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Assessments
        </h2>
        <Card className="flex flex-col gap-2 p-4">
          {application.assessments.length === 0 ? (
            <p className="text-sm text-muted">No assessment has been set.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {application.assessments.map((assessment) => (
                <li
                  key={assessment.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line p-2.5"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-ink">{assessment.title}</span>
                    <span className="text-xs text-muted">
                      {assessment.assessmentType}
                      {assessment.dueAt ? ` · due ${formatDay(assessment.dueAt.slice(0, 10))}` : ''}
                    </span>
                    {assessment.notes && (
                      <span className="text-xs text-ink-2">{assessment.notes}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-ink-2">
                      {formatScore(assessment.score, assessment.maxScore)}
                    </span>
                    <Badge variant={ASSESSMENT_STATUS_TONES[assessment.status]}>
                      {ASSESSMENT_STATUS_LABELS[assessment.status]}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Offer
          </h2>
          {canDecide &&
            application.selectedAt !== null &&
            application.status === 'ACTIVE' &&
            latestOffer === null &&
            departments?.success &&
            designations?.success && (
              <CreateOfferForm
                applicationId={application.id}
                defaultPosition={application.job.title}
                departments={departments.data.departments}
                designations={designations.data.designations}
              />
            )}
        </div>
        <Card className="flex flex-col gap-2 p-4">
          <OfferList offers={application.offers} />
          {latestOffer && (
            <div className="pt-1">
              <Button asChild size="sm" variant="outline">
                <Link href={`/hr/recruitment/offers/${latestOffer.id}`}>Open the offer</Link>
              </Button>
            </div>
          )}
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Background verification
          </h2>
          {canCreate && canView && <RequestBackgroundCheckForm applicationId={application.id} />}
        </div>
        <Card className="flex flex-col gap-2 p-4">
          {/*
            An empty array here means one of two things, and the message covers both
            honestly: either no check has been requested, or this reader is not entitled
            to results. The server decides which, and does not tell the browser.
          */}
          {application.backgroundChecks.length === 0 ? (
            <p className="text-sm text-muted">
              {canView
                ? 'No background check has been requested.'
                : 'Verification results are visible to the recruitment team only.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {application.backgroundChecks.map((check) => (
                <li
                  key={check.id}
                  className="flex flex-col gap-1 rounded-md border border-line p-2.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="text-sm font-medium text-ink">
                      {BACKGROUND_CHECK_TYPE_LABELS[check.checkType]}
                    </span>
                    <Badge variant={BACKGROUND_CHECK_STATUS_TONES[check.status]}>
                      {BACKGROUND_CHECK_STATUS_LABELS[check.status]}
                    </Badge>
                  </div>
                  {check.result && <p className="text-xs text-ink-2">{check.result}</p>}
                  {check.notes && <p className="text-xs text-muted">{check.notes}</p>}
                  <span className="text-xs text-muted">
                    Requested {formatDay(check.requestedAt.slice(0, 10))}
                    {check.verifierName ? ` · ${check.verifierName}` : ''}
                    {check.verifiedBy ? ` · recorded by ${check.verifiedBy.name}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Onboarding
          </h2>
          {canCreate &&
            application.onboardingId === null &&
            application.currentStage === 'OFFER_ACCEPTED' &&
            departments?.success &&
            designations?.success && (
              <StartOnboardingForm
                applicationId={application.id}
                departments={departments.data.departments}
                designations={designations.data.designations}
                employees={panelCandidates}
                defaultJoiningDate={acceptedOffer?.proposedJoiningDate ?? null}
              />
            )}
        </div>
        <Card className="flex flex-col gap-2 p-4">
          {application.onboardingId ? (
            <>
              <p className="text-sm text-ink-2">This hire is being onboarded.</p>
              <div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/hr/onboarding/${application.onboardingId}`}>
                    Open the checklist
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">
              Onboarding starts once an offer has been accepted.
            </p>
          )}
        </Card>
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
