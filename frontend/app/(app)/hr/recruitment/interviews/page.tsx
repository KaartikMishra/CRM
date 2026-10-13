import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { fetchInterviews } from '@/lib/recruitment-api';
import { InterviewList } from '@/components/hr/interview-panel';

export const metadata: Metadata = { title: 'Interviews' };

/**
 * The interview schedule.
 *
 * Reachable without HR_RECRUITMENT, deliberately: an interviewer needs their own
 * schedule and will usually hold no recruitment grant at all. The server scopes the list
 * to the applications they can reach, which by construction includes every interview they
 * are booked on.
 *
 * Two sections, because they answer different questions: what is coming up, and what the
 * viewer still owes feedback on. A single list sorted by date buries the second — and an
 * interviewer who has not reported is the thing holding a hiring decision up.
 */
export default async function InterviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireModule('HR_RECRUITMENT');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const [upcoming, held] = await Promise.all([
    fetchInterviews({ status: 'SCHEDULED', limit: '50', cursor: single('cursor') }),
    fetchInterviews({ status: 'COMPLETED', limit: '25' }),
  ]);

  // Feedback owed, computed from the flag the server set per row rather than guessed at
  // from the panel list — it already accounts for whether the viewer has submitted.
  const owed = upcoming.success
    ? upcoming.data.items.filter((interview) => interview.feedbackPending)
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title="Interviews"
        description="What is booked, and what still needs your feedback."
      />

      {owed.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Waiting on your feedback
          </h2>
          <Card className="p-4">
            <InterviewList interviews={owed} />
          </Card>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Scheduled
        </h2>
        {!upcoming.success ? (
          <ErrorMessage message={upcoming.message} />
        ) : (
          <Card className="p-4">
            <InterviewList interviews={upcoming.data.items} />
          </Card>
        )}
        {upcoming.success && upcoming.data.nextCursor && (
          <div className="flex justify-end">
            <Button asChild variant="outline" size="sm">
              <Link href={`/hr/recruitment/interviews?cursor=${upcoming.data.nextCursor}`}>
                Next page
              </Link>
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Recently held
        </h2>
        {!held.success ? (
          <ErrorMessage message={held.message} />
        ) : (
          <Card className="p-4">
            <InterviewList interviews={held.data.items} />
          </Card>
        )}
      </section>
    </div>
  );
}
