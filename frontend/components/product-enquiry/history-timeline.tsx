import type { DelayRecordView, EnquiryEventView } from '@rs/shared';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';

/**
 * §33 — the enquiry timeline, straight from the backend's event log.
 *
 * Nothing here is inferred or synthesised: every entry is a row the API
 * recorded, so the timeline and the audit trail cannot disagree.
 */

const EVENT_COPY: Record<EnquiryEventView['type'], string> = {
  CREATED: 'Enquiry created',
  ASSIGNED: 'Assigned',
  REASSIGNED: 'Reassigned',
  PRODUCT_ADDED: 'Product added',
  PRODUCT_UPDATED: 'Product updated',
  PRODUCT_REMOVED: 'Product removed',
  VENDOR_RESPONSE_ADDED: 'Vendor response added',
  VENDOR_RESPONSE_UPDATED: 'Vendor response updated',
  DEADLINE_BREACHED: 'Deadline breached',
  DELAY_REASON_SUBMITTED: 'Delay reason submitted',
  PARTIAL_SUBMITTED: 'Partial submit',
  FULL_SUBMITTED: 'Full submit',
  CLOSED: 'Enquiry closed',
  REOPENED: 'Enquiry reopened',
};

/** Only breaches and delays get colour; everything else stays quiet. */
const TONE: Partial<Record<EnquiryEventView['type'], string>> = {
  DEADLINE_BREACHED: 'bg-critical',
  DELAY_REASON_SUBMITTED: 'bg-warning',
  CLOSED: 'bg-positive',
  FULL_SUBMITTED: 'bg-positive',
  REOPENED: 'bg-warning',
};

export function HistoryTimeline({
  events,
  delays,
}: {
  events: EnquiryEventView[];
  delays: DelayRecordView[];
}) {
  const reasonFor = new Map(delays.map((d) => [d.submittedAt.slice(0, 16), d.reason]));

  return (
    <ol className="flex flex-col">
      {events.map((event, index) => {
        const last = index === events.length - 1;
        const reason =
          event.type === 'DELAY_REASON_SUBMITTED'
            ? (event.newValue ?? reasonFor.get(event.occurredAt.slice(0, 16)))
            : null;

        return (
          <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
            {!last && <span aria-hidden className="absolute left-[5px] top-3 h-full w-px bg-line" />}
            <span
              aria-hidden
              className={cn(
                'relative mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-surface',
                TONE[event.type] ?? 'bg-line-2',
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{EVENT_COPY[event.type]}</p>
              <p className="mt-0.5 text-xs text-muted tabular">
                {formatDateTime(event.occurredAt)}
                {event.actor && <span> · {event.actor.name}</span>}
              </p>
              {reason && (
                <p className="mt-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">
                  {reason}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
