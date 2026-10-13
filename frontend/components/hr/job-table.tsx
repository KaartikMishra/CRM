import Link from 'next/link';
import { Search } from 'lucide-react';
import type { JobRequisitionSummary } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
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
import {
  JOB_PRIORITY_LABELS,
  JOB_PRIORITY_TONES,
  JOB_STATUS_LABELS,
  JOB_STATUS_TONES,
  formatDay,
} from './recruitment-labels';

/**
 * The job requisition board.
 *
 * Nine columns, wider than a laptop viewport — wrapped in an `overflow-x-auto`
 * container so they scroll sideways, exactly as the attendance, Sales and Post Sales
 * boards do.
 *
 * ### The two application counts
 *
 * "Applications" shows `activeApplicationCount` of `applicationCount`, both derived
 * server-side. They are different numbers a recruiter needs at once — "12 applied, 3
 * still in play" — and showing only the total would make a closed pipeline look busy.
 *
 * ### What is deliberately absent
 *
 * The salary range. A requisition row is a list of roles being filled, and what each
 * pays is not what somebody scans a list for — it belongs on the detail page where
 * the reader has gone looking for it. The server also strips it for anybody without
 * the module, so this column could not be trusted to be present anyway.
 */
export function JobTable({ jobs }: { jobs: JobRequisitionSummary[] }) {
  if (jobs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Search}
          title="No roles yet"
          description="Raise a requisition and it will appear here."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Role</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>Designation</TableHead>
            <TableHead className="text-right">Openings</TableHead>
            <TableHead className="text-right">Applications</TableHead>
            <TableHead>Hiring manager</TableHead>
            <TableHead>Recruiter</TableHead>
            <TableHead>Target join</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id}>
              <TableCell>
                <Link
                  href={`/hr/recruitment/jobs/${job.id}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm font-medium text-ink">{job.title}</span>
                  <span className="text-xs text-muted">{job.code}</span>
                </Link>
              </TableCell>
              <TableCell className="text-sm text-ink-2">{job.department?.name ?? '—'}</TableCell>
              <TableCell className="text-sm text-ink-2">{job.designation?.name ?? '—'}</TableCell>
              <TableCell className="text-right text-sm text-ink-2">{job.openings}</TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {job.activeApplicationCount}
                <span className="text-muted"> / {job.applicationCount}</span>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {job.hiringManager?.displayName ?? '—'}
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {job.recruiter?.displayName ?? '—'}
              </TableCell>
              <TableCell className="text-sm text-ink-2">{formatDay(job.targetJoinDate)}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={JOB_STATUS_TONES[job.status]}>
                    {JOB_STATUS_LABELS[job.status]}
                  </Badge>
                  {/*
                    Priority is shown only when it is not NORMAL. A badge on every row
                    saying "Normal" is noise that makes the URGENT ones harder to spot,
                    which is the opposite of what a priority is for.
                  */}
                  {job.priority !== 'NORMAL' && (
                    <Badge variant={JOB_PRIORITY_TONES[job.priority]}>
                      {JOB_PRIORITY_LABELS[job.priority]}
                    </Badge>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
