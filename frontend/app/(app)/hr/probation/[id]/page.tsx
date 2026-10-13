import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchProbation } from '@/lib/recruitment-api';
import { ProbationDetail } from '@/components/hr/probation-panel';

export const metadata: Metadata = { title: 'Probation' };

/**
 * One probation.
 *
 * `canReview` and `canDecide` are passed permissively — true for anybody who reaches this
 * page — because the reviewing manager is the main user and usually holds no HR grant at
 * all. The service enforces the real rules: only the manager or an HR approver may act,
 * and **nobody decides or reviews their own**, whatever else they hold.
 *
 * That is the same trade the onboarding checklist makes, and for the same reason: hiding
 * the controls from the people the feature exists for would break it, while showing one
 * the API refuses costs an error message.
 */
export default async function ProbationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireModule('HR_EMPLOYEE');
  const { id } = await params;

  const result = await fetchProbation(id);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="HR & Workforce" title="Probation" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/probation">Back to probation</Link>
          </Button>
        </div>
      </div>
    );
  }

  const probation = result.data.probation;

  /*
    Nobody decides or reviews their own probation, so the page does not offer it.

    Compared on the RS-number rather than on an id, because `User` and `Employee` are
    separate records joined by an optional 1:1 and the session carries only the former.
    The two numbers are drawn from one series — Phase 1's `allocateEmployeeId` seeds from
    both tables for exactly this reason — so a match means the same person.

    This is a courtesy, not the boundary: the service refuses a self-decision regardless
    of what this renders, which is what actually prevents it. A button somebody is
    structurally barred from pressing is just noise.
  */
  const ownRecord = access.user.employeeId === probation.employee.employeeId;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title={probation.employee.displayName}
        description={`${probation.employee.employeeId} · probation`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/hr/employees/${probation.employee.id}`}>Employee</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/probation">All probations</Link>
            </Button>
          </div>
        }
      />

      <ProbationDetail
        probation={probation}
        canReview={!ownRecord}
        canDecide={!ownRecord}
      />
    </div>
  );
}
