import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { LEAD_CHANNEL_LABELS, LEAD_SOURCE_LABELS, REQUIREMENT_TYPE_LABELS } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { AllocationBadge, DealStatusBadge, PromptnessBadge } from '@/components/leads/lead-badges';
import { CompleteTheIdeal } from '@/components/leads/complete-the-ideal';
import { ActivityPanel } from '@/components/leads/activity-panel';
import { LeadControls } from '@/components/leads/lead-controls';
import { fetchLead } from '@/lib/lead-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { formatCurrency, formatDateTime } from '@/lib/format';

/**
 * One lead in full, and the home of Complete the Ideal.
 *
 * The page the analytics board rows link to. Everything on it comes from one
 * request: the customer, the derived promptness, the activity timeline and every
 * requirement with its photo and matched product already attached — so a lead
 * with five requirements is one round trip, not eleven.
 *
 * `requireModule` returns a verdict rather than redirecting, because `redirect()`
 * throws NEXT_REDIRECT and a later await can swallow it.
 */

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const result = await fetchLead(id);
  return { title: result.success ? result.data.lead.customer.name : 'Lead' };
}

export default async function LeadDetailPage({ params }: { params: Params }) {
  const { id } = await params;

  const access = await requireModule('LEAD_DEAL');
  if (!access.allowed) return <NoModuleAccess module="LEAD_DEAL" />;

  const result = await fetchLead(id);
  if (!result.success) {
    if (result.code === 'LEAD_NOT_FOUND') notFound();
    return <ErrorMessage message={result.message} code={result.code} />;
  }

  const lead = result.data.lead;

  /*
    Capturing a requirement is EDIT — the capability the requirement routes
    themselves demand. Resolved through the permission matrix rather than the
    role, so a per-user grant or revocation applies here as everywhere else.
  */
  const canEdit = can(access.user, 'LEAD_DEAL', 'EDIT');
  /*
    Allocation is ASSIGN, deliberately a different capability from EDIT: deciding
    who owns work is not the same as doing it, and Phase 4C gave it its own
    endpoint so the route table says which is which. Somebody with EDIT alone
    sees the status control and no allocation control.
  */
  const canAssign = can(access.user, 'LEAD_DEAL', 'ASSIGN');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/leads">
            <ArrowLeft className="size-4" />
            Back to the board
          </Link>
        </Button>

        <PageHeader
          eyebrow="Lead / Deal"
          title={lead.customer.name}
          description={
            lead.customer.phone
              ? `${lead.customer.phone}${lead.customer.email ? ` · ${lead.customer.email}` : ''}`
              : (lead.customer.email ?? undefined)
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <DealStatusBadge status={lead.dealStatus} />
          <PromptnessBadge promptness={lead.promptness} hasAssociate={lead.associate !== null} />
          <AllocationBadge allocation={lead.allocation} />
        </div>
      </div>

      {/*
        Allocating the lead and moving the deal — the two decisions somebody
        makes about a lead in front of them, each behind its own capability.
        ASSIGN for allocation, EDIT for status: Phase 4C separated them on
        purpose and this passes both verdicts through rather than one.
      */}
      <LeadControls lead={lead} canEdit={canEdit} canAssign={canAssign} />

      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Source" value={LEAD_SOURCE_LABELS[lead.leadSource]} note={lead.leadSourceOther} />
        <Field label="Channel" value={LEAD_CHANNEL_LABELS[lead.channel]} note={lead.channelOther} />
        <Field label="Requirement" value={REQUIREMENT_TYPE_LABELS[lead.requirementType]} />
        <Field label="Initiated on" value={formatDateTime(lead.sourceAt)} />
        <Field label="Associate" value={lead.associate?.name ?? 'Unassigned'} />
        <Field label="Allocated by" value={lead.allocatedBy?.name ?? '—'} />
        <Field
          label="First contact"
          value={lead.firstContactAt ? formatDateTime(lead.firstContactAt) : 'Not yet made'}
        />
        <Field
          label="Last follow-up"
          value={lead.lastFollowUpAt ? formatDateTime(lead.lastFollowUpAt) : '—'}
        />
        {/*
          Overdue work is not an upcoming plan — the backend excludes it from
          nextFollowUpAt for exactly that reason — so an empty Next beside
          outstanding actions says so rather than showing a bare dash.
        */}
        <Field
          label="Next follow-up"
          value={
            lead.nextFollowUpAt
              ? formatDateTime(lead.nextFollowUpAt)
              : lead.promptness.overdue > 0
                ? 'None scheduled'
                : '—'
          }
          note={
            !lead.nextFollowUpAt && lead.promptness.overdue > 0
              ? `${lead.promptness.overdue} overdue`
              : null
          }
        />
      </Card>

      {/*
        The two values, side by side and labelled apart.

        Order Value is what a real SalesOrder is worth; Requirement Value is what
        the customer asked for, as the associate priced it. A lead that has not
        become an order has no order value, and saying so plainly is the point —
        reporting the estimate under "Order Value" would claim a sale nobody made.
      */}
      <Card className="grid gap-4 p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">Order Value</span>
          {/* Nullish: a response older than the field carries neither. */}
          {lead.orderValue != null ? (
            <span className="text-lg font-semibold tabular text-ink">
              {formatCurrency(lead.orderValue)}
            </span>
          ) : (
            <>
              <span className="text-sm text-muted">Not converted to an order</span>
              <span className="text-xs text-faint">
                This lead has no linked sales order yet.
              </span>
            </>
          )}
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">Requirement Value</span>
          {lead.requirementValue != null ? (
            <>
              <span className="text-lg font-semibold tabular text-ink">
                {formatCurrency(lead.requirementValue)}
              </span>
              <span className="text-xs text-faint">
                {lead.requirements.length === 1
                  ? 'From 1 requirement · an estimate, not a sale'
                  : `From ${lead.requirements.length} requirements · an estimate, not a sale`}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted">Nothing priced yet</span>
          )}
        </div>
      </Card>

      {/* The workflow behind Last and Next Follow-up, and behind promptness. */}
      <ActivityPanel leadId={lead.id} activities={lead.activities} canEdit={canEdit} />

      {/*
        Complete the Ideal. The rows came down with the lead above, so this
        section costs no further request.
      */}
      <CompleteTheIdeal leadId={lead.id} requirements={lead.requirements} canEdit={canEdit} />
    </div>
  );
}

function Field({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  /** The written-in name for an OTHER source or channel, where there is one. */
  note?: string | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm text-ink">{value}</span>
      {note && <span className="text-xs text-faint">{note}</span>}
    </div>
  );
}
