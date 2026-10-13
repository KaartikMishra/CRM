'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { OfferSummary, OfferView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  respondToOfferAction,
  sendOfferAction,
} from '@/app/(app)/hr/recruitment-actions';
import {
  OFFER_STATUS_LABELS,
  OFFER_STATUS_TONES,
  formatDay,
  formatMoment,
  formatPackage,
} from './recruitment-labels';

/**
 * An offer, and the controls for moving it along.
 *
 * ### No payroll, and no bank or tax field anywhere
 *
 * `annualPackage` is what was *communicated* to the candidate — informational, so a
 * later Payroll phase has a documented starting point. Nothing is computed from it
 * here or on the server, and there is no account number, tax identifier or deduction
 * anywhere in this phase. A figure arrives as `null` for any reader without the
 * recruitment module, so this component cannot show it even by accident.
 *
 * ### Why HR records the candidate's answer
 *
 * There is no candidate-facing route in this CRM, so an acceptance arrives by email or
 * phone and somebody types it in. That makes the audit entry name the person who
 * recorded it, which is the honest attribution — rather than implying the candidate
 * clicked something.
 *
 * ### The states are the server's
 *
 * A draft may be sent; a sent offer may be answered; an answered one is finished. The
 * buttons follow `offer.status` rather than a local state machine, and the API refuses
 * anything else — a double-click cannot accept an offer twice, because the write is
 * predicated on the status it expected.
 */
export function OfferDetail({
  offer,
  canDecide,
}: {
  offer: OfferView;
  /** Whether the viewer holds HR_RECRUITMENT:APPROVE. The API decides again. */
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [responding, setResponding] = useState<'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | null>(null);
  const [note, setNote] = useState('');

  function send(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await sendOfferAction(offer.id);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      router.refresh();
    });
  }

  function respond(status: 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN'): void {
    // A refusal from either side says why. Required here, by Zod and by a CHECK.
    if (status !== 'ACCEPTED' && note.trim().length < 5) {
      setMessage('Say why the offer was declined or withdrawn.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await respondToOfferAction(offer.id, status, note.trim() || undefined);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setResponding(null);
      setNote('');
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">{offer.position}</span>
          <span className="text-xs text-muted">{offer.code}</span>
        </div>
        <Badge variant={OFFER_STATUS_TONES[offer.status]}>
          {OFFER_STATUS_LABELS[offer.status]}
        </Badge>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <Field label="Candidate" value={offer.candidate.displayName} />
        <Field label="Role" value={`${offer.job.title} (${offer.job.code})`} />
        <Field label="Department" value={offer.department?.name ?? '—'} />
        <Field label="Designation" value={offer.designation?.name ?? '—'} />
        <Field label="Proposed joining" value={formatDay(offer.proposedJoiningDate)} />
        <Field label="Expires" value={formatDay(offer.expiresOn)} />
        <Field label="Location" value={offer.location ?? '—'} />
        {/*
          Shown only when the server sent it. A reader without the module gets null,
          and rendering "—" for them is correct: it reads the same as "no figure
          recorded", which is exactly what they are entitled to know.
        */}
        <Field
          label="Annual package"
          value={formatPackage(offer.annualPackage, offer.packageCurrency)}
        />
      </div>

      {offer.benefitsSummary && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Benefits
          </span>
          <p className="text-sm text-ink-2">{offer.benefitsSummary}</p>
        </div>
      )}

      <div className="flex flex-col gap-0.5 text-xs text-muted">
        {offer.sentAt && <span>Sent {formatMoment(offer.sentAt)}</span>}
        {offer.respondedAt && <span>Answered {formatMoment(offer.respondedAt)}</span>}
        {offer.responseNote && <span className="text-ink-2">{offer.responseNote}</span>}
        <span>Raised by {offer.createdBy.name}</span>
      </div>

      {/*
        The offer letter, where one was stored. An id, never a URL: links are minted
        per request, signed and short-lived, because a stored link outlives every
        access check and cannot be revoked.
      */}
      {offer.secureDocumentId && (
        <p className="text-xs text-muted">
          An offer letter is attached to this record.
        </p>
      )}

      {canDecide && (offer.status === 'DRAFT' || offer.status === 'SENT') && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {offer.status === 'DRAFT' && responding === null && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={send}>
                {pending ? 'Sending…' : 'Mark as sent'}
              </Button>
            </div>
          )}

          {offer.status === 'SENT' && responding === null && (
            <>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Record the candidate’s answer
              </span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={pending} onClick={() => setResponding('ACCEPTED')}>
                  Accepted
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setResponding('REJECTED')}
                >
                  Declined
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setResponding('WITHDRAWN')}
                >
                  We withdrew it
                </Button>
              </div>
            </>
          )}

          {responding !== null && (
            <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3">
              <p className="text-sm text-ink">
                {responding === 'ACCEPTED'
                  ? 'Record that the candidate accepted this offer?'
                  : responding === 'REJECTED'
                    ? 'Record that the candidate declined?'
                    : 'Record that the business withdrew this offer?'}
              </p>
              {responding === 'ACCEPTED' && (
                <p className="text-xs text-muted">
                  This moves the application to offer accepted, which onboarding starts
                  from. There is no route back from it.
                </p>
              )}
              <Textarea
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={
                  responding === 'ACCEPTED' ? 'Note (optional)' : 'Say why'
                }
                aria-label="Response note"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={pending} onClick={() => respond(responding)}>
                  {pending ? 'Saving…' : 'Confirm'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setResponding(null);
                    setNote('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </Card>
  );
}

/** The offer list, for a board or one application. */
export function OfferList({ offers }: { offers: OfferSummary[] }) {
  if (offers.length === 0) {
    return <p className="text-sm text-muted">No offer has been made.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {offers.map((offer) => (
        <li key={offer.id} className="flex flex-col gap-1 rounded-md border border-line p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-ink">
                {offer.candidate.displayName}
              </span>
              <span className="text-xs text-ink-2">{offer.position}</span>
              <span className="text-xs text-muted">{offer.code}</span>
            </div>
            <Badge variant={OFFER_STATUS_TONES[offer.status]}>
              {OFFER_STATUS_LABELS[offer.status]}
            </Badge>
          </div>
          <span className="text-xs text-muted">
            Joining {formatDay(offer.proposedJoiningDate)}
            {offer.expiresOn ? ` · expires ${formatDay(offer.expiresOn)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className="text-ink-2">{value}</span>
    </div>
  );
}
