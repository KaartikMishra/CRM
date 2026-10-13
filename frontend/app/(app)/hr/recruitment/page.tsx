import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import {
  fetchApplications,
  fetchInterviews,
  fetchJobs,
  fetchOffers,
  fetchOnboardings,
} from '@/lib/recruitment-api';

export const metadata: Metadata = { title: 'Recruitment' };

/**
 * The recruitment landing page.
 *
 * ### The counts are deliberately lightweight
 *
 * Each tile is the length of one already-scoped page of results, not an aggregate
 * query. That is a real decision rather than laziness: a proper analytics layer for
 * recruitment would need its own endpoints, its own caching and its own answer to
 * "counted over what period", and none of that has been asked for. Seven numbers
 * drawn from the lists they link to cannot disagree with those lists, which is worth
 * more here than precision beyond the page size.
 *
 * Where a count is capped by the page size the tile says so, so nobody reads "25" as
 * a total.
 *
 * ### Gating
 *
 * `requireModule('HR_RECRUITMENT')` is enforced here, unlike the employee directory
 * which is reachable by any manager. The difference is that recruitment has no
 * self-service population: there is no sense in which an ordinary employee has "their
 * own" requisitions, so somebody without the module or an involvement has nothing to
 * see and the honest answer is the access panel.
 *
 * A hiring manager or interviewer *with* an involvement but without the module would
 * also land here — so the page renders for them too, with their scoped counts, and the
 * API decides what each list contains.
 */
export default async function RecruitmentPage() {
  const access = await requireModule('HR_RECRUITMENT');

  /*
    Six requests in parallel. Each is already scoped by the server to what this reader
    may see, so an interviewer sees their own interviews and a hiring manager their own
    vacancies — the tiles narrow with the person rather than showing a company total
    they are not entitled to.
  */
  const [openJobs, applications, screening, shortlisted, interviews, offers, onboardings] =
    await Promise.all([
      fetchJobs({ status: 'PUBLISHED', limit: '50' }),
      fetchApplications({ status: 'ACTIVE', limit: '50' }),
      fetchApplications({ status: 'ACTIVE', stage: 'SCREENING', limit: '50' }),
      fetchApplications({ status: 'ACTIVE', stage: 'SHORTLISTED', limit: '50' }),
      fetchInterviews({ status: 'SCHEDULED', limit: '50' }),
      fetchOffers({ status: 'SENT', limit: '50' }),
      fetchOnboardings({ limit: '50' }),
    ]);

  // Nothing loaded at all means a backend problem rather than an empty pipeline, and
  // those read very differently to somebody trying to work.
  const allFailed =
    !openJobs.success &&
    !applications.success &&
    !interviews.success &&
    !offers.success &&
    !onboardings.success;

  if (!access.allowed && allFailed) {
    return <NoModuleAccess module="HR_RECRUITMENT" />;
  }

  const tiles = [
    {
      label: 'Open roles',
      value: openJobs.success ? openJobs.data.items.length : null,
      capped: openJobs.success && openJobs.data.nextCursor !== null,
      href: '/hr/recruitment/jobs?status=PUBLISHED',
    },
    {
      label: 'Live applications',
      value: applications.success ? applications.data.items.length : null,
      capped: applications.success && applications.data.nextCursor !== null,
      href: '/hr/recruitment/applications?status=ACTIVE',
    },
    {
      label: 'In screening',
      value: screening.success ? screening.data.items.length : null,
      capped: screening.success && screening.data.nextCursor !== null,
      href: '/hr/recruitment/applications?stage=SCREENING',
    },
    {
      label: 'Shortlisted',
      value: shortlisted.success ? shortlisted.data.items.length : null,
      capped: shortlisted.success && shortlisted.data.nextCursor !== null,
      href: '/hr/recruitment/applications?stage=SHORTLISTED',
    },
    {
      label: 'Interviews booked',
      value: interviews.success ? interviews.data.items.length : null,
      capped: interviews.success && interviews.data.nextCursor !== null,
      href: '/hr/recruitment/interviews',
    },
    {
      label: 'Offers awaiting a reply',
      value: offers.success ? offers.data.items.length : null,
      capped: offers.success && offers.data.nextCursor !== null,
      href: '/hr/recruitment/offers?status=SENT',
    },
    {
      label: 'Onboarding',
      value: onboardings.success ? onboardings.data.items.length : null,
      capped: onboardings.success && onboardings.data.nextCursor !== null,
      href: '/hr/onboarding',
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Recruitment"
        description="Roles being filled, people being considered, and where each of them stands."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/recruitment/candidates">Candidates</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/hr/recruitment/jobs">Roles</Link>
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href}>
            <Card className="flex h-full flex-col gap-1 p-4 transition-colors hover:bg-surface-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                {tile.label}
              </span>
              <span className="text-2xl font-semibold text-ink">
                {tile.value === null ? '—' : `${tile.value}${tile.capped ? '+' : ''}`}
              </span>
              {tile.capped && (
                <span className="text-xs text-muted">More than shown — open the list</span>
              )}
            </Card>
          </Link>
        ))}
      </div>

      {/*
        One error line per failed read rather than one for the page. A dashboard where
        six of seven tiles loaded is still useful, and replacing all of it with a single
        error would throw away work that succeeded.
      */}
      <div className="flex flex-col gap-2">
        {!openJobs.success && <ErrorMessage message={openJobs.message} />}
        {!applications.success && <ErrorMessage message={applications.message} />}
        {!interviews.success && <ErrorMessage message={interviews.message} />}
        {!offers.success && <ErrorMessage message={offers.message} />}
        {!onboardings.success && <ErrorMessage message={onboardings.message} />}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Where to go
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NavCard
            href="/hr/recruitment/jobs"
            title="Roles"
            description="Requisitions, their pipelines and their status."
          />
          <NavCard
            href="/hr/recruitment/candidates"
            title="Candidates"
            description="Everybody the business is considering."
          />
          <NavCard
            href="/hr/recruitment/interviews"
            title="Interviews"
            description="The schedule, and feedback you owe."
          />
          <NavCard
            href="/hr/recruitment/offers"
            title="Offers"
            description="What has been offered and who has answered."
          />
        </div>
      </section>
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
