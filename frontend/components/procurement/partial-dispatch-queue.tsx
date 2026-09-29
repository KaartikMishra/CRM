'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Clock } from 'lucide-react';
import type { PendingPartialDispatchRow } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ContentRegion, ContentScrollArea } from '@/components/common/content-page';
import { DecidePartialDialog } from '@/components/dispatch/decide-partial-dialog';
import { deadlineCountdown } from '@/components/dispatch/dispatch-logic';
import { formatDateTime } from '@/lib/format';

/**
 * Partial-dispatch requests waiting on a procurement decision.
 *
 * Dispatch asks whether the ready part of an order may go before the rest
 * arrives; this is where that question is answered. It sits on Purchase &
 * Procurement rather than on the dispatch board because the decision is a
 * procurement judgement — and because a reviewer should not need access to the
 * Packing & Dispatch module to answer a question addressed to them.
 *
 * Shown only to people who can actually decide one. That is a convenience, not
 * the control: the API refuses the decision without PROCUREMENT ASSIGN, and
 * refuses it again inside the service, so hiding this section changes what
 * somebody sees and nothing about what they can do.
 *
 * Every row carries the quantities the decision turns on. "6 of 12 ready" is
 * the whole question — whether to send half now or hold for one complete
 * parcel — and a reviewer should not have to open another screen to see it.
 */
export function PartialDispatchQueue({ rows }: { rows: PendingPartialDispatchRow[] }) {
  if (rows.length === 0) return null;

  return (
    <ContentRegion>
      <div className="flex shrink-0 items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Partial dispatch awaiting decision
        </h2>
        <span className="text-xs text-muted">
          {rows.length} request{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Its own scroll region, so a long queue cannot push requirement vs
          stock and the purchase bills off the page. */}
      <ContentScrollArea className="flex flex-col gap-3">
        {rows.map((row) => (
          <RequestCard key={row.request.id} row={row} />
        ))}
      </ContentScrollArea>
    </ContentRegion>
  );
}

function RequestCard({ row }: { row: PendingPartialDispatchRow }) {
  const router = useRouter();
  const [decision, setDecision] = useState<'ALLOW' | 'DISALLOW' | null>(null);

  const countdown = deadlineCountdown(row.request.deadline);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium text-ink">{row.orderId}</span>
          <span className="text-sm text-muted">{row.customerName}</span>

          {/*
            The deadline, and how long is left of it. Procurement has 24 hours
            before the request is allowed automatically, so the time remaining
            is the most actionable thing on the row — an expiring one is the
            one to answer first.
          */}
          <Badge variant={countdown.expired ? 'critical' : 'warning'} className="ml-auto">
            <Clock className="size-3" />
            {countdown.expired ? 'Deadline passed' : countdown.label}
          </Badge>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Figure label="Required" value={row.requiredQty} />
          <Figure label="Ready" value={row.readyQty} emphasis />
          <Figure label="Still pending" value={row.pendingQty} />
          <Figure label="Lines complete" value={`${row.readyLines}/${row.totalLines}`} />
        </dl>

        <p className="text-xs text-muted">
          Asked by {row.request.requestedBy.name} · {formatDateTime(row.request.requestedAt)} ·
          due {formatDateTime(row.request.deadline)}
        </p>

        {/*
          No reason or plan of action is shown from the requester, because they
          supply none: the question is stated by the order's own readiness, and
          the explanation belongs to this decision.
        */}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setDecision('ALLOW')}>
            Allow partial
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDecision('DISALLOW')}>
            Disallow
          </Button>
        </div>
      </CardContent>

      <DecidePartialDialog
        open={decision !== null}
        onOpenChange={(open) => !open && setDecision(null)}
        decision={decision ?? 'ALLOW'}
        request={row.request}
        salesOrderId={row.request.salesOrderId}
        // Re-runs the page on the server, so a decided request drops out of the
        // queue rather than lingering as stale client state.
        onDone={() => router.refresh()}
      />
    </Card>
  );
}

function Figure({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string | number;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`tabular ${emphasis ? 'font-medium text-ink' : 'text-ink-2'}`}>{value}</dd>
    </div>
  );
}
