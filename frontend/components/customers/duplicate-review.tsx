'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import type { CustomerDuplicateCandidateView, DuplicateSideView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/common/error-message';
import { decideDuplicateAction } from '@/app/(app)/customers/duplicates/actions';

/**
 * One duplicate candidate, side by side, with its two decisions.
 *
 * A Client Component because it holds the pending and error state of a
 * decision. The comparison itself is plain markup; only the two buttons need
 * JavaScript.
 *
 * ### Why both sides show their record counts
 *
 * Deciding whether two rows are one customer means knowing what hangs off each.
 * A row with eleven orders and one with none are not interchangeable, whatever
 * their phone numbers agree about — and since confirming does NOT merge, the
 * counts are also what tells a reviewer which row the business actually uses.
 */

const NONE = '—';
const text = (value: string | null): string => (value?.trim() ? value : NONE);

/** Human wording for the scorer's identifier names. */
const MATCH_LABELS: Record<string, string> = {
  phone: 'Phone number',
  email: 'Email address',
  gstNumber: 'GSTIN',
  companyAndState: 'Company name + state',
};

function Side({
  side,
  label,
  matched,
  other,
}: {
  side: DuplicateSideView;
  label: string;
  matched: string[];
  other: DuplicateSideView;
}) {
  /*
    A field is highlighted when the scorer matched on it AND both sides carry a
    value. Highlighting a blank would suggest two absent values agreed, which is
    exactly the inference the scorer refuses to make.
  */
  const isMatched = (kind: string, a: string | null, b: string | null): boolean =>
    matched.includes(kind) && Boolean(a) && Boolean(b);

  const row = (
    fieldLabel: string,
    value: string | null,
    kind?: string,
    otherValue?: string | null,
  ) => {
    const highlight = kind ? isMatched(kind, value, otherValue ?? null) : false;
    return (
      <div className="flex items-baseline justify-between gap-3 py-1">
        <dt className="text-[11px] uppercase tracking-wide text-muted">{fieldLabel}</dt>
        <dd
          className={
            highlight
              ? 'rounded bg-warning-soft px-1.5 py-0.5 text-sm font-medium text-ink'
              : 'text-sm text-ink'
          }
        >
          {text(value)}
        </dd>
      </div>
    );
  };

  return (
    <div className="flex-1 rounded-md border border-line p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
        <Link
          href={`/customers/${side.id}`}
          className="text-sm font-medium text-accent hover:underline"
        >
          {side.name}
        </Link>
      </div>

      <dl className="mt-2 divide-y divide-line">
        {row('Company', side.companyName, 'companyAndState', other.companyName)}
        {row('Phone', side.phone, 'phone', other.phone)}
        {row('Email', side.email, 'email', other.email)}
        {row('GSTIN', side.gstNumber, 'gstNumber', other.gstNumber)}
        {row('State', side.state)}
      </dl>

      <div className="mt-2 flex flex-wrap gap-1 border-t border-line pt-2">
        <Badge variant="neutral">{side.orderCount} orders</Badge>
        <Badge variant="neutral">{side.enquiryCount} enquiries</Badge>
        <Badge variant="neutral">{side.leadCount} leads</Badge>
      </div>
      <p className="mt-1 text-[11px] text-muted">
        On record since {new Date(side.createdAt).toLocaleDateString('en-IN')}
      </p>
    </div>
  );
}

export function DuplicateCandidateCard({
  candidate,
}: {
  candidate: CustomerDuplicateCandidateView;
}) {
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [pending, start] = useTransition();

  const matched = candidate.matchedOn ? candidate.matchedOn.split(',').filter(Boolean) : [];

  const decide = (status: 'CONFIRMED' | 'DISMISSED') =>
    start(async () => {
      setError(null);
      const result = await decideDuplicateAction(candidate.id, status);
      if (!result.ok) {
        setError({ message: result.message, ...(result.code ? { code: result.code } : {}) });
      }
    });

  const decided = candidate.status !== 'SUGGESTED';

  return (
    <li className="rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              candidate.status === 'CONFIRMED'
                ? 'positive'
                : candidate.status === 'DISMISSED'
                  ? 'neutral'
                  : 'warning'
            }
          >
            {candidate.status}
          </Badge>
          <span className="font-mono text-sm tabular-nums text-ink">
            Score {candidate.score}
          </span>
          {/*
            The reasons, spelled out. A reviewer deciding on a score alone is
            deciding on a number; the identifiers are what make it judgeable.
          */}
          {matched.map((kind) => (
            <Badge key={kind} variant="neutral">
              {MATCH_LABELS[kind] ?? kind}
            </Badge>
          ))}
        </div>

        {decided && candidate.decidedAt && (
          <p className="text-[11px] text-muted">
            {candidate.status === 'CONFIRMED' ? 'Confirmed' : 'Dismissed'} by{' '}
            {candidate.decidedBy?.name ?? 'a former colleague'} on{' '}
            {new Date(candidate.decidedAt).toLocaleDateString('en-IN')}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <Side
          side={candidate.customerA}
          other={candidate.customerB}
          label="Customer A"
          matched={matched}
        />
        <Side
          side={candidate.customerB}
          other={candidate.customerA}
          label="Customer B"
          matched={matched}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button size="sm" disabled={pending} onClick={() => decide('CONFIRMED')}>
          <Check className="size-4" />
          {candidate.status === 'CONFIRMED' ? 'Confirmed' : 'Confirm duplicate'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => decide('DISMISSED')}
        >
          <X className="size-4" />
          {candidate.status === 'DISMISSED' ? 'Dismissed' : 'Not a duplicate'}
        </Button>
        {pending && <span className="text-xs text-muted">Saving…</span>}
      </div>

      {error && (
        <div className="mt-2">
          <ErrorMessage message={error.message} code={error.code} />
        </div>
      )}
    </li>
  );
}

/**
 * The standing explanation of what a decision does.
 *
 * Shown above the queue rather than buried in a tooltip, because the obvious
 * reading of a button labelled "Confirm duplicate" is that it merges the two
 * records — and it does not. Somebody has to be able to click it without
 * wondering whether they have just destroyed a customer's history.
 */
export function DuplicateReviewNotice() {
  return (
    <div className="rounded-md border border-line bg-surface-2 p-3 text-xs text-muted">
      <p className="font-medium text-ink">Confirming does not merge anything.</p>
      <p className="mt-1">
        A decision here is a record of what you judged, and nothing more. No customer, enquiry,
        lead or order is changed, combined or deleted by either button — both rows stay exactly as
        they are, and every link on them keeps working.
      </p>
      <p className="mt-1">
        A dismissed pair stays dismissed. It only comes back if the identifiers that matched it
        change — a corrected phone number, or an email filled in — because at that point the
        decision was about data that no longer exists.
      </p>
    </div>
  );
}
