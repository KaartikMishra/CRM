import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchInterview } from '@/lib/recruitment-api';
import { InterviewDetail } from '@/components/hr/interview-panel';

export const metadata: Metadata = { title: 'Interview' };

/**
 * One interview.
 *
 * `interview.feedback` arrives already filtered by the backend's panel rule — an
 * interviewer sees their own entry always and the rest only once they have submitted.
 * There is deliberately no filtering here: doing it client-side would mean the restricted
 * entries had already been sent to a browser where anybody can read them.
 */
export default async function InterviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireModule('HR_RECRUITMENT');
  const { id } = await params;

  const canManage = access.allowed && can(access.user, 'HR_RECRUITMENT', 'EDIT');

  const result = await fetchInterview(id);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Recruitment" title="Interview" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/recruitment/interviews">Back to interviews</Link>
          </Button>
        </div>
      </div>
    );
  }

  const interview = result.data.interview;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title={interview.candidate.displayName}
        description={`${interview.job.title} · ${interview.job.code}`}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href={`/hr/recruitment/applications/${interview.applicationId}`}>
              Application
            </Link>
          </Button>
        }
      />

      <InterviewDetail interview={interview} canManage={canManage} />
    </div>
  );
}
