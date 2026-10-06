import Link from 'next/link';
import { Users } from 'lucide-react';
import type { LeadAnalyticsRow } from '@rs/shared';
import { LEAD_CHANNEL_LABELS } from '@rs/shared';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ContentScrollArea, contentCard } from '@/components/common/content-page';
import { EmptyState } from '@/components/common/empty-state';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { AllocationBadge, DealStatusBadge, PromptnessBadge } from './lead-badges';

/**
 * The Lead/Deal analytics table.
 *
 * Every figure comes from the API, which derived it from rows the same request
 * fetched. There is no arithmetic in this file — promptness, allocation and
 * order value each have one definition, and it is not here.
 *
 * `Table` brings its own `.scroll-x` container, so the nine columns scroll
 * sideways on a narrow screen without anything added. (A `ContentScrollArea`
 * around it would claim height and cut the page off — the defect that made the
 * dispatch detail page unscrollable.)
 */
export function LeadTable({
  leads,
  filtered,
}: {
  leads: LeadAnalyticsRow[];
  /** True when a search or filter is in use, so "empty" can say which. */
  filtered: boolean;
}) {
  if (leads.length === 0) {
    return (
      <Card className={contentCard}>
        <CardContent className="p-0">
          <EmptyState
            icon={Users}
            title={filtered ? 'No leads match those filters' : 'No leads yet'}
            description={
              filtered
                ? 'Try a different search, or clear the filters to see everything.'
                : 'Leads appear here once somebody records one.'
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={contentCard}>
      <CardContent className="p-0">
        <ContentScrollArea>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>CX Name</TableHead>
                <TableHead>Deal Status</TableHead>
                <TableHead>Associate Promptness</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Allocation</TableHead>
                <TableHead className="text-right">Order Value</TableHead>
                <TableHead className="text-right">Requirement Value</TableHead>
                <TableHead>Initiated On</TableHead>
                <TableHead>Last Follow-up</TableHead>
                <TableHead>Next Follow-up</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell>
                    {/*
                      The customer, with their contact beneath, linking to the
                      lead detail where the activity timeline and Complete the
                      Ideal live. The whole name is the target rather than a
                      separate "view" column, which is how every other board in
                      the CRM opens a record.
                    */}
                    <Link
                      href={`/leads/${lead.id}`}
                      className="block font-medium text-ink hover:text-accent hover:underline"
                    >
                      {lead.customer.name}
                    </Link>
                    {lead.customer.phone && (
                      <span className="block text-xs text-muted tabular">
                        {lead.customer.phone}
                      </span>
                    )}
                    {lead.customer.email && (
                      <span className="block text-xs text-muted">{lead.customer.email}</span>
                    )}
                  </TableCell>

                  <TableCell>
                    <DealStatusBadge status={lead.dealStatus} />
                  </TableCell>

                  <TableCell>
                    <PromptnessBadge
                      promptness={lead.promptness}
                      hasAssociate={lead.associate !== null}
                    />
                  </TableCell>

                  <TableCell>
                    <span className="block text-sm">
                      {lead.channel === 'OTHER'
                        ? (lead.channelOther ?? 'Other')
                        : LEAD_CHANNEL_LABELS[lead.channel]}
                    </span>
                  </TableCell>

                  <TableCell>
                    <AllocationBadge allocation={lead.allocation} />
                    {lead.associate && (
                      <span className="mt-0.5 block text-xs text-muted">
                        {lead.associate.name}
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="tabular text-right">
                    {/*
                      Null means no linked order. An order worth nothing is a
                      real fact and shows as 0.00 — showing an em dash for both
                      would hide it, which is why this is a nullish check and
                      never a truthiness one ('0.00' is truthy, 0 is not).

                      `== null` rather than `=== null` deliberately: it catches
                      undefined too. The contract says `string | null`, but a
                      response served by a backend older than the field carries
                      neither — and a missing key reaching `formatCurrency`
                      crashed the whole table on `undefined.split('.')`.
                    */}
                    {lead.orderValue == null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      formatCurrency(lead.orderValue)
                    )}
                  </TableCell>

                  <TableCell className="tabular text-right">
                    {/*
                      What the customer asked for, summed across this lead's
                      requirements. A separate column from Order Value and never
                      a stand-in for it: this is an estimate against a
                      requirement, and the lead may never become an order at all.
                    */}
                    {/* Nullish, for the same reason as Order Value above. */}
                    {lead.requirementValue == null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      formatCurrency(lead.requirementValue)
                    )}
                  </TableCell>

                  <TableCell className="tabular text-xs text-muted">
                    {formatDateTime(lead.initiatedAt)}
                  </TableCell>

                  <TableCell className="tabular text-xs text-muted">
                    {lead.lastFollowUpAt ? formatDateTime(lead.lastFollowUpAt) : '—'}
                  </TableCell>

                  <TableCell className="tabular text-xs">
                    {lead.nextFollowUpAt ? (
                      <span className="text-muted">{formatDateTime(lead.nextFollowUpAt)}</span>
                    ) : lead.promptness.overdue > 0 ? (
                      /*
                        Nothing scheduled, and something already missed. The
                        overdue state has to be visible somewhere, and this is
                        the column somebody looks at to decide what to do next —
                        but it is NOT presented as a next follow-up, because it
                        is not one.
                      */
                      <span className="font-medium text-critical">Overdue</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ContentScrollArea>
      </CardContent>
    </Card>
  );
}
