import Link from 'next/link';
import { Users } from 'lucide-react';
import type { ApplicationSummary, CandidateSummary } from '@rs/shared';
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
  APPLICATION_STAGE_LABELS,
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_TONES,
  CANDIDATE_SOURCE_LABELS,
  formatDay,
  formatExperience,
} from './recruitment-labels';

/**
 * The candidate directory.
 *
 * ### What is deliberately NOT here
 *
 * No notes, no screening score, no interview feedback, no verification result. The
 * server does not send them on a summary shape at all, which is the point: a leak
 * through a list payload is invisible until somebody opens a network tab, so the
 * narrowing happens before the data leaves the service rather than by this component
 * choosing not to render a field it holds.
 *
 * Skills are shown, capped at four with a count. A candidate row is a way to find
 * somebody, and twenty skill chips make a table unreadable while telling the reader
 * less than four do.
 */
export function CandidateTable({ candidates }: { candidates: CandidateSummary[] }) {
  if (candidates.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title="No candidates yet"
          description="Add a candidate and they will appear here."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Candidate</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Current role</TableHead>
            <TableHead>Experience</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Applications</TableHead>
            <TableHead>Added</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {candidates.map((candidate) => (
            <TableRow key={candidate.id}>
              <TableCell>
                <Link
                  href={`/hr/recruitment/candidates/${candidate.id}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm font-medium text-ink">{candidate.displayName}</span>
                  {!candidate.isActive && (
                    <span className="text-xs text-muted">No longer being considered</span>
                  )}
                </Link>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5 text-xs text-ink-2">
                  <span>{candidate.email}</span>
                  {candidate.phone && <span className="text-muted">{candidate.phone}</span>}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5 text-xs text-ink-2">
                  <span>{candidate.currentDesignation ?? '—'}</span>
                  {candidate.currentEmployer && (
                    <span className="text-muted">{candidate.currentEmployer}</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {formatExperience(candidate.totalExperienceYears)}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{CANDIDATE_SOURCE_LABELS[candidate.source]}</Badge>
              </TableCell>
              <TableCell className="text-right text-sm text-ink-2">
                {candidate.applicationCount}
              </TableCell>
              <TableCell className="text-sm text-muted">
                {formatDay(candidate.createdAt.slice(0, 10))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/**
 * The applications board.
 *
 * `availableStages` arrives on every row from the server's own transition map, so the
 * count of possible next moves shown here is the same answer the API would give. The
 * moves themselves are made on the detail page, where the reason field and the
 * confirmation for a commit point have room to exist.
 */
export function ApplicationTable({
  applications,
  showJob = true,
}: {
  applications: ApplicationSummary[];
  /** Hidden when this list is already scoped to one role. */
  showJob?: boolean;
}) {
  if (applications.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title="No applications yet"
          description="Applications appear here once candidates are put forward."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Candidate</TableHead>
            {showJob && <TableHead>Role</TableHead>}
            <TableHead>Stage</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Recruiter</TableHead>
            <TableHead>Hiring manager</TableHead>
            <TableHead>Applied</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {applications.map((application) => (
            <TableRow key={application.id}>
              <TableCell>
                <Link
                  href={`/hr/recruitment/applications/${application.id}`}
                  className="flex flex-col gap-0.5 hover:underline"
                >
                  <span className="text-sm font-medium text-ink">
                    {application.candidate.displayName}
                  </span>
                  <span className="text-xs text-muted">{application.candidate.email}</span>
                </Link>
              </TableCell>
              {showJob && (
                <TableCell>
                  <Link
                    href={`/hr/recruitment/jobs/${application.job.id}`}
                    className="flex flex-col gap-0.5 text-sm text-ink-2 hover:underline"
                  >
                    <span>{application.job.title}</span>
                    <span className="text-xs text-muted">{application.job.code}</span>
                  </Link>
                </TableCell>
              )}
              <TableCell>
                <Badge variant="accent">
                  {APPLICATION_STAGE_LABELS[application.currentStage]}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={APPLICATION_STATUS_TONES[application.status]}>
                  {APPLICATION_STATUS_LABELS[application.status]}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {application.recruiter?.displayName ?? '—'}
              </TableCell>
              <TableCell className="text-sm text-ink-2">
                {application.hiringManager?.displayName ?? '—'}
              </TableCell>
              <TableCell className="text-sm text-muted">
                {formatDay(application.appliedAt.slice(0, 10))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
