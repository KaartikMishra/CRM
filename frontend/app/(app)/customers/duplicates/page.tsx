import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, CopyCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import {
  ContentPage,
  ContentPageHeader,
  ContentRegion,
  ContentScrollArea,
} from '@/components/common/content-page';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import {
  DuplicateCandidateCard,
  DuplicateReviewNotice,
} from '@/components/customers/duplicate-review';
import { fetchDuplicateCandidates } from '@/lib/customer-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Duplicate review' };

const STATUSES = ['SUGGESTED', 'CONFIRMED', 'DISMISSED'] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABELS: Record<Status, string> = {
  SUGGESTED: 'Awaiting review',
  CONFIRMED: 'Confirmed',
  DISMISSED: 'Not duplicates',
};

type Search = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Duplicate review.
 *
 * VIEW to read the queue. The decision buttons call an API gated on EDIT, so
 * somebody with VIEW alone sees the queue and gets a refusal from the server if
 * they try to decide — the backend is the authority, and a hidden button has
 * never been authorization.
 */
export default async function DuplicateReviewPage({ searchParams }: { searchParams: Search }) {
  const access = await requireModule('CUSTOMERS');
  if (!access.allowed) return <NoModuleAccess module="CUSTOMERS" />;
  if (!can(access.user, 'CUSTOMERS', 'VIEW')) return <NoModuleAccess module="CUSTOMERS" />;

  const canDecide = can(access.user, 'CUSTOMERS', 'EDIT');

  const query = await searchParams;
  const raw = first(query.status);
  const status: Status = STATUSES.includes(raw as Status) ? (raw as Status) : 'SUGGESTED';
  const cursor = first(query.cursor);

  const result = await fetchDuplicateCandidates({
    status,
    ...(cursor ? { cursor } : {}),
  });

  const counts = result.success ? result.data.counts : null;
  const nextCursor =
    result.success && typeof result.meta?.nextCursor === 'string'
      ? result.meta.nextCursor
      : null;

  return (
    <ContentPage>
      <ContentPageHeader>
        <PageHeader
          eyebrow="All Customers"
          title="Duplicate review"
          description="Pairs that share an identifier, for somebody to judge. Nothing here merges records."
          actions={
            <Button asChild variant="outline">
              <Link href="/customers">
                <ArrowLeft className="size-4" />
                Directory
              </Link>
            </Button>
          }
        />
      </ContentPageHeader>

      <ContentRegion>
        <ContentScrollArea>
          <div className="flex flex-col gap-6 pb-2">
            <DuplicateReviewNotice />

            {!canDecide && (
              <p className="rounded-md border border-line bg-surface-2 p-3 text-xs text-muted">
                You can read this queue but not decide on it. Recording a decision needs edit
                access to Customers.
              </p>
            )}

            {/* Status tabs as links, so a filtered queue is a shareable URL. */}
            <nav aria-label="Candidate status" className="flex flex-wrap gap-1 border-b border-line">
              {STATUSES.map((name) => (
                <Link
                  key={name}
                  href={`/customers/duplicates?status=${name}`}
                  aria-current={status === name ? 'page' : undefined}
                  className={
                    status === name
                      ? 'border-b-2 border-accent px-3 py-2 text-sm font-medium text-ink'
                      : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink'
                  }
                >
                  {STATUS_LABELS[name]}
                  {/*
                    The count comes from a grouped query that returns all three
                    statuses even when empty, so a tab reading 0 is a real zero
                    rather than a count that failed to load.
                  */}
                  {counts ? ` (${counts[name]})` : ''}
                </Link>
              ))}
            </nav>

            {!result.success ? (
              <ErrorMessage message={result.message} code={result.code} />
            ) : result.data.candidates.length === 0 ? (
              <Card>
                <EmptyState
                  icon={CopyCheck}
                  title={
                    status === 'SUGGESTED'
                      ? 'Nothing waiting for review'
                      : `No ${STATUS_LABELS[status].toLowerCase()} pairs`
                  }
                  description={
                    status === 'SUGGESTED'
                      ? 'No customer pairs currently share enough identifiers to be worth a look.'
                      : 'Decisions you record will appear here.'
                  }
                />
              </Card>
            ) : (
              <>
                <ul className="flex flex-col gap-4">
                  {result.data.candidates.map((candidate) => (
                    <DuplicateCandidateCard key={candidate.id} candidate={candidate} />
                  ))}
                </ul>

                {nextCursor && (
                  <div className="flex justify-end">
                    <Link
                      href={`/customers/duplicates?status=${status}&cursor=${nextCursor}`}
                      className="text-sm text-accent hover:underline"
                    >
                      Next page →
                    </Link>
                  </div>
                )}
              </>
            )}
          </div>
        </ContentScrollArea>
      </ContentRegion>
    </ContentPage>
  );
}
