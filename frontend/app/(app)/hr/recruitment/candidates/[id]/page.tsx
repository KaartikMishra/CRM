import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchApplications, fetchCandidate } from '@/lib/recruitment-api';
import { ApplicationTable } from '@/components/hr/candidate-table';
import {
  CANDIDATE_SOURCE_LABELS,
  DOCUMENT_VERIFICATION_TONES,
  formatDay,
  formatExperience,
  formatMoment,
} from '@/components/hr/recruitment-labels';
import { VERIFICATION_STATUS_LABELS } from '@/components/hr/hr-labels';

export const metadata: Metadata = { title: 'Candidate' };

/**
 * One candidate.
 *
 * ### Documents are metadata only
 *
 * The list below shows what was uploaded, its type and whether it was verified — and
 * **no URL**. The bytes live in Cloudinary under authenticated delivery through the
 * existing SecureDocument service; links are minted per request, signed and short-lived.
 * A stored link outlives every access check and cannot be revoked, which is exactly how
 * MediaAsset became publicly fetchable, so there is deliberately no `url` field on the
 * view type for this page to render.
 *
 * ### Notes are internal
 *
 * `notes` is a recruiter's private assessment, stripped by the server for anybody whose
 * scope is narrower than the module. There is no candidate-facing route in this CRM at
 * all, which is the simplest guarantee that it cannot reach its subject.
 */
export default async function CandidateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireModule('HR_RECRUITMENT');
  const { id } = await params;

  const canView = access.allowed && can(access.user, 'HR_RECRUITMENT', 'VIEW');

  const [result, applications] = await Promise.all([
    fetchCandidate(id),
    fetchApplications({ candidateId: id, limit: '50' }),
  ]);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Recruitment" title="Candidate" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/recruitment/candidates">Back to candidates</Link>
          </Button>
        </div>
      </div>
    );
  }

  const candidate = result.data.candidate;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title={candidate.displayName}
        badge={
          candidate.isActive ? undefined : (
            <Badge variant="neutral">No longer being considered</Badge>
          )
        }
        description={candidate.email}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/hr/recruitment/candidates">All candidates</Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex flex-col gap-3 p-4 lg:col-span-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Profile
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Email" value={candidate.email} />
            <Field label="Phone" value={candidate.phone ?? '—'} />
            <Field label="Location" value={candidate.location ?? '—'} />
            <Field label="Source" value={CANDIDATE_SOURCE_LABELS[candidate.source]} />
            <Field label="Referred by" value={candidate.sourceDetail ?? '—'} />
            <Field
              label="Experience"
              value={formatExperience(candidate.totalExperienceYears)}
            />
            <Field label="Current employer" value={candidate.currentEmployer ?? '—'} />
            <Field label="Current role" value={candidate.currentDesignation ?? '—'} />
          </div>

          {candidate.skills.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-line pt-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Skills
              </span>
              <div className="flex flex-wrap gap-1.5">
                {candidate.skills.map((skill) => (
                  <Badge key={skill} variant="outline">
                    {skill}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1 border-t border-line pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Internal notes
            </span>
            <p className="whitespace-pre-line text-sm text-ink-2">
              {canView
                ? (candidate.notes ?? 'No notes recorded.')
                : 'Notes are visible to the recruitment team only.'}
            </p>
          </div>

          <div className="flex flex-col gap-0.5 border-t border-line pt-3 text-xs text-muted">
            <span>Added by {candidate.createdBy.name}</span>
            <span>{formatMoment(candidate.createdAt)}</span>
          </div>
        </Card>

        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Documents
          </h2>
          {candidate.documents.length === 0 ? (
            <p className="text-sm text-muted">No documents have been attached.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {candidate.documents.map((document) => (
                <li
                  key={document.id}
                  className="flex flex-col gap-0.5 rounded-md border border-line p-2.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="text-sm text-ink">{document.title}</span>
                    <Badge variant={DOCUMENT_VERIFICATION_TONES[document.verificationStatus]}>
                      {VERIFICATION_STATUS_LABELS[document.verificationStatus]}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted">
                    Uploaded by {document.uploadedBy.name} ·{' '}
                    {formatDay(document.createdAt.slice(0, 10))}
                  </span>
                  {document.verifiedBy && (
                    <span className="text-xs text-muted">
                      Checked by {document.verifiedBy.name}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/*
            Why there is no download link here. Stated rather than left as a gap, because
            somebody will look for one.
          */}
          <p className="border-t border-line pt-2 text-xs text-muted">
            Files are held under authenticated storage. Links are issued on request and
            expire, so none is shown here.
          </p>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Applications
        </h2>
        {!applications.success ? (
          <ErrorMessage message={applications.message} />
        ) : (
          <ApplicationTable applications={applications.data.items} />
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
