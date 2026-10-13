import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { fetchEmployee } from '@/lib/hr-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import {
  EMPLOYEE_DOCUMENT_TYPE_LABELS,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_STATUS_TONES,
  EMPLOYMENT_TYPE_LABELS,
  VERIFICATION_STATUS_LABELS,
  WORK_MODE_LABELS,
  describeEmployeeEvent,
  formatHrDate,
  formatTenure,
} from '@/components/hr/hr-labels';

export const metadata: Metadata = { title: 'Employee Profile' };

/**
 * One employee's profile.
 *
 * Sections rather than one long form, because the information divides by who needs
 * it and who may see it: Overview and Organization are directory-level, Account is
 * about authentication, History is the audit-adjacent record, and Documents are
 * confidential.
 *
 * The scope rule is the same as the directory's: a manager reaches their own
 * reports without holding any HR permission, so this page does not demand
 * `access.allowed`. The API decides, and returns 404 rather than 403 for somebody
 * outside scope — telling a caller "this exists but is not yours" would let them
 * enumerate the directory by probing ids.
 *
 * Documents arrive empty unless the viewer holds HR_EMPLOYEE:VIEW — the service
 * withholds them rather than this page hiding them, so the confidential metadata
 * never reaches the browser in the first place.
 */
export default async function EmployeeProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const access = await requireModule('HR_EMPLOYEE');
  const result = await fetchEmployee(id);

  if (!result.success) {
    if (result.code === 'EMPLOYEE_NOT_FOUND') notFound();
    return <ErrorMessage message={result.message} />;
  }

  const employee = result.data.employee;
  const canEdit = access.allowed && can(access.user, 'HR_EMPLOYEE', 'EDIT');
  const canAssign = access.allowed && can(access.user, 'HR_EMPLOYEE', 'ASSIGN');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Button asChild variant="ghost" size="sm" className="w-fit">
            <Link href="/hr/employees">
              <ArrowLeft className="size-4" />
              Directory
            </Link>
          </Button>
          <PageHeader
            eyebrow={employee.employeeId}
            title={employee.displayName}
            description={employee.workEmail}
          />
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={EMPLOYEE_STATUS_TONES[employee.status]}>
            {EMPLOYEE_STATUS_LABELS[employee.status]}
          </Badge>
          {canEdit && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/hr/employees/${employee.id}/edit`}>Edit</Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Employment">
          <Field label="Joining date" value={formatHrDate(employee.joiningDate)} />
          <Field
            label="Tenure"
            value={formatTenure(employee.joiningDate, employee.exitDate)}
          />
          <Field label="Type" value={EMPLOYMENT_TYPE_LABELS[employee.employmentType]} />
          <Field label="Work mode" value={WORK_MODE_LABELS[employee.workMode]} />
          <Field label="Location" value={employee.location ?? '—'} />
          {employee.exitDate && (
            <Field label="Last working day" value={formatHrDate(employee.exitDate)} />
          )}
        </Section>

        <Section title="Organization">
          <Field label="Department" value={employee.department?.name ?? '—'} />
          <Field label="Designation" value={employee.designation?.name ?? '—'} />
          <Field
            label="Reports to"
            value={
              employee.manager ? (
                <Link href={`/hr/employees/${employee.manager.id}`} className="hover:underline">
                  {employee.manager.displayName}
                </Link>
              ) : (
                '—'
              )
            }
          />
          <Field label="Phone" value={employee.phone ?? '—'} />
        </Section>

        <Section title="Direct reports">
          {employee.reports.length === 0 ? (
            <p className="text-sm text-muted">Nobody reports to this employee.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {employee.reports.map((report) => (
                <li key={report.id}>
                  <Link
                    href={`/hr/employees/${report.id}`}
                    className="text-sm text-ink-2 hover:underline"
                  >
                    {report.displayName}
                    <span className="ml-2 text-xs text-muted">{report.employeeId}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="CRM account">
          {employee.account ? (
            <>
              <Field label="Name" value={employee.account.name} />
              <Field label="Email" value={employee.account.email} />
              <Field label="Role" value={employee.account.role} />
              <Field
                label="Sign-in"
                value={employee.account.isActive ? 'Enabled' : 'Disabled'}
              />
            </>
          ) : (
            <p className="text-sm text-muted">
              No CRM account is linked. Most employees do not need one.
              {canAssign && ' An administrator can link an existing account.'}
            </p>
          )}
        </Section>
      </div>

      <Section title="History">
        {employee.history.length === 0 ? (
          <p className="text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {employee.history.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-0.5 border-l-2 border-line pl-3">
                <span className="text-sm text-ink">{describeEmployeeEvent(entry)}</span>
                <span className="text-xs text-muted">
                  {formatHrDate(entry.effectiveAt)}
                  {entry.performedBy ? ` · ${entry.performedBy.name}` : ''}
                </span>
                {entry.note && <span className="text-xs text-ink-2">{entry.note}</span>}
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/*
        Documents arrive empty for a viewer without HR_EMPLOYEE:VIEW — withheld by
        the service, not hidden here — so an absent section means "not permitted"
        or "none", and either way there is nothing to show. No link is rendered:
        a signed URL is minted by its own endpoint, per click, after the server
        re-resolves permission.
      */}
      {employee.documents.length > 0 && (
        <Section title="Documents">
          <ul className="flex flex-col gap-2">
            {employee.documents.map((document) => (
              <li
                key={document.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 last:border-0"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-ink">{document.title}</span>
                  <span className="text-xs text-muted">
                    {EMPLOYEE_DOCUMENT_TYPE_LABELS[document.documentType]}
                    {document.expiresOn ? ` · expires ${formatHrDate(document.expiresOn)}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {document.isExpired && <Badge variant="critical">Expired</Badge>}
                  <Badge
                    variant={
                      document.verificationStatus === 'VERIFIED'
                        ? 'positive'
                        : document.verificationStatus === 'REJECTED'
                          ? 'critical'
                          : 'outline'
                    }
                  >
                    {VERIFICATION_STATUS_LABELS[document.verificationStatus]}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm text-ink-2">{value}</span>
    </div>
  );
}
