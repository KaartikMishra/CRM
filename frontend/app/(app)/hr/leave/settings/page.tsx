import type { Metadata } from 'next';
import { CalendarDays } from 'lucide-react';
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
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { EmptyState } from '@/components/common/empty-state';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { fetchLeavePolicies, fetchLeaveTypes } from '@/lib/attendance-api';
import { requireModule } from '@/lib/require-module';
import { formatLeaveDays } from '@/components/hr/attendance-labels';

export const metadata: Metadata = { title: 'Leave Settings' };

/**
 * Leave types and policies.
 *
 * Gated on HR_ADMIN, like the attendance settings: entitlements by department are
 * configuration, and an employee's own entitlement reaches them through their
 * balance rather than through this page.
 *
 * Read-only in Phase 2 for the same reason as the attendance settings — the
 * write endpoints exist and are tested, and a form that can change everybody's
 * entitlement deserves its own pass. Noted as a limitation rather than hidden.
 */
export default async function LeaveSettingsPage() {
  const access = await requireModule('HR_ADMIN');
  if (!access.allowed) return <NoModuleAccess module="HR_ADMIN" />;

  const [types, policies] = await Promise.all([fetchLeaveTypes({}), fetchLeavePolicies()]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Leave settings"
        description="The kinds of leave the business offers, and the rules for each."
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Leave types
        </h2>

        {!types.success ? (
          <ErrorMessage message={types.message} />
        ) : types.data.leaveTypes.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No leave types configured"
            description="Leave types are defined by the business — none is assumed."
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Paid</TableHead>
                    <TableHead>Half day</TableHead>
                    <TableHead>Carry forward</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {types.data.leaveTypes.map((type) => (
                    <TableRow key={type.id}>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-ink">{type.name}</span>
                          <span className="font-mono text-xs text-muted">{type.code}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-ink-2">{type.isPaid ? 'Paid' : 'Unpaid'}</TableCell>
                      <TableCell className="text-ink-2">
                        {type.halfDayAllowed ? 'Allowed' : 'Full days only'}
                      </TableCell>
                      <TableCell className="text-ink-2">
                        {type.carryForwardEnabled
                          ? type.carryForwardLimit === null
                            ? 'Unlimited'
                            : `Up to ${formatLeaveDays(type.carryForwardLimit)}`
                          : 'No'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={type.isActive ? 'positive' : 'outline'}>
                          {type.isActive ? 'Active' : 'Retired'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Leave policies
        </h2>

        {!policies.success ? (
          <ErrorMessage message={policies.message} />
        ) : policies.data.policies.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No policies configured"
            description="A leave type needs a policy before an entitlement can be allocated."
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Leave type</TableHead>
                    <TableHead>Entitlement</TableHead>
                    <TableHead>Notice</TableHead>
                    <TableHead>Max consecutive</TableHead>
                    <TableHead>Scope</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policies.data.policies.map((policy) => (
                    <TableRow key={policy.id}>
                      <TableCell className="font-medium text-ink">
                        {policy.leaveType.name}
                      </TableCell>
                      <TableCell className="text-ink-2">
                        {formatLeaveDays(policy.annualEntitlement)} a year
                      </TableCell>
                      <TableCell className="text-ink-2">
                        {policy.minNoticeDays > 0 ? `${policy.minNoticeDays} days` : 'None'}
                      </TableCell>
                      <TableCell className="text-ink-2">
                        {policy.maxConsecutiveDays === null
                          ? 'No limit'
                          : `${policy.maxConsecutiveDays} days`}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {policy.department ? policy.department.name : 'Whole company'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
