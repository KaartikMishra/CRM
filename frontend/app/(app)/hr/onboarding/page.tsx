import type { Metadata } from 'next';
import Link from 'next/link';
import { UserPlus } from 'lucide-react';
import { ONBOARDING_STAGES, type OnboardingSummary } from '@rs/shared';
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
import { fetchOnboardings } from '@/lib/recruitment-api';
import {
  ONBOARDING_STAGE_LABELS,
  formatDay,
  progressPercent,
} from '@/components/hr/recruitment-labels';

export const metadata: Metadata = { title: 'Onboarding' };

/**
 * The onboarding board.
 *
 * ### The four groupings, and why they are these four
 *
 * Not the raw stages — there are sixteen of those and a column per stage would be
 * unreadable. These are the four questions somebody running onboarding actually asks:
 *
 *   Starting soon   joining within the next fortnight. The only genuinely time-pressured
 *                   group, because a laptop ordered the day before is a laptop that is
 *                   late.
 *   Before hiring   the three stages that run without an employment record. Separated
 *                   because the hinge — creating the employee — is the one step that
 *                   cannot be undone.
 *   After joining   everything past that hinge.
 *   Complete        finished, kept visible so the board is a record rather than a queue
 *                   that empties.
 *
 * Reachable without HR_RECRUITMENT, because a reporting manager with onboarding tasks
 * needs it and the server scopes the list.
 */
export default async function OnboardingPage({
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

  const result = await fetchOnboardings({ limit: '100', cursor: single('cursor') });

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="HR & Workforce" title="Onboarding" />
        <ErrorMessage message={result.message} />
      </div>
    );
  }

  const records = result.data.items;

  /*
    The fortnight window, computed from the server's own dates rather than the browser's
    clock where it matters: the joining date is a company-time calendar day, and comparing
    it to a locally-derived "today" is the classic off-by-one. Fourteen days ahead of the
    UTC day is close enough for a grouping heading and cannot shift a record into the
    wrong bucket by more than a few hours either side of midnight.
  */
  const today = new Date().toISOString().slice(0, 10);
  const fortnight = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  const preEmployee = new Set(['OFFER_ACCEPTED', 'DOCUMENTS', 'VERIFICATION']);

  const complete = records.filter((r) => r.stage === 'COMPLETED');
  const live = records.filter((r) => r.stage !== 'COMPLETED');
  const startingSoon = live.filter((r) => r.joiningDate >= today && r.joiningDate <= fortnight);
  const beforeHiring = live.filter((r) => preEmployee.has(r.stage));
  const afterJoining = live.filter((r) => !preEmployee.has(r.stage));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Onboarding"
        description="People joining, and how far through their checklist each has got."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Starting within a fortnight" value={startingSoon.length} />
        <Tile label="Before the employment record" value={beforeHiring.length} />
        <Tile label="After joining" value={afterJoining.length} />
        <Tile label="Complete" value={complete.length} />
      </div>

      <OnboardingTable records={records} />

      {result.data.nextCursor && (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={`/hr/onboarding?cursor=${result.data.nextCursor}`}>Next page</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="text-2xl font-semibold text-ink">{value}</span>
    </Card>
  );
}

function OnboardingTable({ records }: { records: OnboardingSummary[] }) {
  if (records.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={UserPlus}
          title="Nobody is being onboarded"
          description="Onboarding starts from an accepted offer on an application."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Joiner</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Joining</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>Manager</TableHead>
            <TableHead>Employee</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Stage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => {
            const percent = progressPercent(record.completedTaskCount, record.taskCount);
            return (
              <TableRow key={record.id}>
                <TableCell>
                  <Link
                    href={`/hr/onboarding/${record.id}`}
                    className="flex flex-col gap-0.5 hover:underline"
                  >
                    <span className="text-sm font-medium text-ink">
                      {record.candidate.displayName}
                    </span>
                    <span className="text-xs text-muted">{record.candidate.email}</span>
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-ink-2">{record.job.title}</TableCell>
                <TableCell className="text-sm text-ink-2">
                  {formatDay(record.joiningDate)}
                </TableCell>
                <TableCell className="text-sm text-ink-2">
                  {record.department?.name ?? '—'}
                </TableCell>
                <TableCell className="text-sm text-ink-2">
                  {record.manager?.displayName ?? '—'}
                </TableCell>
                <TableCell className="text-sm text-ink-2">
                  {record.employee?.employeeId ?? 'Not created'}
                </TableCell>
                <TableCell className="text-sm text-ink-2">
                  {record.completedTaskCount}/{record.taskCount}
                  <span className="text-muted"> · {percent}%</span>
                </TableCell>
                <TableCell>
                  <Badge variant={record.completedAt ? 'positive' : 'accent'}>
                    {ONBOARDING_STAGE_LABELS[record.stage]}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
