import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchTrainingOverview } from '@/lib/training-api';

export const metadata: Metadata = { title: 'Training' };

/**
 * The training landing page.
 *
 * ### The numbers are the server's, counted properly
 *
 * Unlike the recruitment dashboard — which derives tiles from the length of a scoped
 * page — training has a real `/overview` endpoint doing aggregate counts in the
 * database. So these are totals rather than page lengths, and no tile needs a "more
 * than shown" caveat.
 *
 * ### Who lands here
 *
 * Anybody with `HR_TRAINING` in their matrix. A trainer sees the whole picture; a
 * learner has no reason to be here and the nav points them at My Learning instead.
 *
 * The overview endpoint is scoped server-side, so somebody holding the module through
 * a narrow override sees their own figures rather than a company total they are not
 * entitled to. This page does not decide that and could not — it renders what came
 * back.
 */
export default async function TrainingPage() {
  const access = await requireModule('HR_TRAINING');

  if (!access.allowed) {
    return <NoModuleAccess module="HR_TRAINING" />;
  }

  const canCreate = can(access.user, 'HR_TRAINING', 'CREATE');
  const canAssign = can(access.user, 'HR_TRAINING', 'ASSIGN');

  const result = await fetchTrainingOverview();

  const tiles = result.success
    ? [
        {
          label: 'Open programs',
          value: result.data.overview.activePrograms,
          href: '/hr/training/programs?status=ACTIVE',
        },
        {
          label: 'Live enrollments',
          value: result.data.overview.liveEnrollments,
          href: '/hr/training/assignments',
        },
        {
          label: 'In progress',
          value: result.data.overview.inProgress,
          href: '/hr/training/assignments?status=IN_PROGRESS',
        },
        {
          label: 'Overdue',
          value: result.data.overview.overdue,
          href: '/hr/training/assignments?overdueOnly=true',
          alarming: true,
        },
        {
          label: 'Required and unfinished',
          value: result.data.overview.mandatoryIncomplete,
          href: '/hr/training/assignments?obligation=MANDATORY',
          alarming: true,
        },
        {
          label: 'Practicals to review',
          value: result.data.overview.pendingPracticalReviews,
          href: '/hr/training/reviews',
        },
        {
          label: 'Shadowing to sign off',
          value: result.data.overview.pendingShadowingSignOffs,
          href: '/hr/training/reviews?tab=shadowing',
        },
        {
          label: 'Ready to be cleared',
          value: result.data.overview.awaitingQualification,
          href: '/hr/training/qualification',
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Training"
        description="What people are learning, where they are stuck, and who is ready for live work."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/training/my-learning">My learning</Link>
            </Button>
            {canAssign && (
              <Button asChild size="sm" variant="outline">
                <Link href="/hr/training/assignments">Assignments</Link>
              </Button>
            )}
            <Button asChild size="sm">
              <Link href="/hr/training/programs">Programs</Link>
            </Button>
          </div>
        }
      />

      {!result.success && <ErrorMessage message={result.message} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href}>
            <Card className="flex h-full flex-col gap-1 p-4 transition-colors hover:bg-surface-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                {tile.label}
              </span>
              {/*
                A non-zero overdue or unfinished-mandatory figure is coloured, because
                those two are the ones somebody is accountable for. Zero is not — a red
                nought reads as a problem when it is the opposite.
              */}
              <span
                className={
                  tile.alarming && tile.value > 0
                    ? 'text-2xl font-semibold text-critical'
                    : 'text-2xl font-semibold text-ink'
                }
              >
                {tile.value}
              </span>
            </Card>
          </Link>
        ))}
      </div>

      {result.success && (
        <Card className="flex flex-wrap gap-6 p-4">
          <Figure
            label="Finished this month"
            value={String(result.data.overview.completedThisMonth)}
          />
          <Figure label="Tests passed" value={String(result.data.overview.passedAttempts)} />
          <Figure label="Tests failed" value={String(result.data.overview.failedAttempts)} />
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Where to go
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NavCard
            href="/hr/training/programs"
            title="Programs"
            description="The catalogue, its steps and its question papers."
          />
          <NavCard
            href="/hr/training/assignments"
            title="Assignments"
            description="Who has been given what, and how far they have got."
          />
          <NavCard
            href="/hr/training/reviews"
            title="Reviews"
            description="Practicals waiting on a decision and shadowing on a sign-off."
          />
          <NavCard
            href="/hr/training/qualification"
            title="Qualification"
            description="Who is cleared for live customer work."
          />
        </div>
      </section>

      {canCreate && (
        <div>
          <Button asChild size="sm">
            <Link href="/hr/training/programs/new">Create a program</Link>
          </Button>
        </div>
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
      <span className="text-lg font-medium text-ink">{value}</span>
    </div>
  );
}

function NavCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link href={href}>
      <Card className="flex h-full flex-col gap-1 p-4 transition-colors hover:bg-surface-2">
        <span className="text-sm font-medium text-ink">{title}</span>
        <span className="text-xs text-muted">{description}</span>
      </Card>
    </Link>
  );
}
