import type { Metadata } from 'next';
import Link from 'next/link';
import { UserCheck } from 'lucide-react';
import type { ProbationSummary } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { fetchProbations } from '@/lib/recruitment-api';
import {
  PROBATION_DECISION_LABELS,
  PROBATION_REVIEW_TYPE_LABELS,
  PROBATION_STATUS_LABELS,
  PROBATION_STATUS_TONES,
  formatDay,
} from '@/components/hr/recruitment-labels';

export const metadata: Metadata = { title: 'Probation' };

/**
 * The probation board.
 *
 * Gated on HR_EMPLOYEE rather than HR_RECRUITMENT, which is the whole reason Probation
 * sits where it does in the navigation: a probation is a fact about somebody's employment
 * reviewed by their reporting manager, and that manager already needs HR_EMPLOYEE to see
 * their team. Requiring a recruitment grant would mean handing every line manager access
 * to the hiring pipeline.
 *
 * The server scopes the list further — an HR reader sees everybody, a manager the
 * probations they are reviewing plus their own.
 *
 * "Ending soon" is first because a probation that lapses undecided leaves somebody's
 * employment in an undefined state, which is unfair to them and a liability for the
 * business. It is the one deadline in this module with real consequences.
 */
export default async function ProbationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireModule('HR_EMPLOYEE');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // A month ahead. Wide enough that nothing is a surprise, narrow enough that the list
  // stays a list of things to act on.
  const monthAhead = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  const [endingSoon, all] = await Promise.all([
    fetchProbations({ status: 'ACTIVE', endingBefore: monthAhead, limit: '50' }),
    fetchProbations({ status: single('status'), limit: '100', cursor: single('cursor') }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Probation"
        description="Who is on probation, how their reviews stand, and what was decided."
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Ending within a month
        </h2>
        {!endingSoon.success ? (
          <ErrorMessage message={endingSoon.message} />
        ) : endingSoon.data.items.length === 0 ? (
          <Card className="p-4">
            <p className="text-sm text-muted">No probation ends in the next month.</p>
          </Card>
        ) : (
          <ProbationTable records={endingSoon.data.items} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          All probations
        </h2>
        {!all.success ? (
          <ErrorMessage message={all.message} />
        ) : (
          <ProbationTable records={all.data.items} />
        )}
        {all.success && all.data.nextCursor && (
          <div className="flex justify-end">
            <Button asChild variant="outline" size="sm">
              <Link href={`/hr/probation?cursor=${all.data.nextCursor}`}>Next page</Link>
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function ProbationTable({ records }: { records: ProbationSummary[] }) {
  if (records.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={UserCheck}
          title="No probations recorded"
          description="A probation is started from an employee's record once they join."
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
            <TableHead>Reviewing manager</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Ends</TableHead>
            <TableHead>Reviews</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={record.id}>
              <TableCell>
                <Link
                  href={`/hr/probation/${record.id}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm font-medium text-ink">
                    {record.employee.displayName}
                  </span>
                  <span className="text-xs text-muted">{record.employee.employeeId}</span>
                </Link>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {record.manager?.displayName ?? '—'}
              </TableCell>
              <TableCell className="text-sm text-ink-2">{formatDay(record.startDate)}</TableCell>
              <TableCell className="text-sm text-ink-2">{formatDay(record.endDate)}</TableCell>
              <TableCell className="text-sm text-ink-2">
                {record.completedReviewCount}/{record.reviewCount}
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {record.decision ? PROBATION_DECISION_LABELS[record.decision] : '—'}
              </TableCell>
              <TableCell>
                <Badge variant={PROBATION_STATUS_TONES[record.status]}>
                  {PROBATION_STATUS_LABELS[record.status]}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
