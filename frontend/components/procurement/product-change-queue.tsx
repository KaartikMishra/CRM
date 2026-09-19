'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Check, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ProductChangeView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ErrorMessage } from '@/components/common/error-message';
import { formatDateTime } from '@/lib/format';
import { reviewProductChangeAction } from '@/app/(app)/procurement/actions';

/**
 * Purchase lines waiting to be re-mapped, and the decision on each.
 *
 * Shown only to people who can actually decide one. That is a convenience, not
 * the control: the API refuses approve and reject without PROCUREMENT ASSIGN,
 * and refuses them again inside the service, so hiding this section changes what
 * somebody sees and nothing about what they can do.
 *
 * Every request states both products in full, with the CRM and RS stock of each.
 * An approver is deciding whether goods on a bill were misidentified, and two
 * cuids — or two titles with no numbers beside them — are not enough to decide
 * that on.
 */
export function ProductChangeQueue({ changes }: { changes: ProductChangeView[] }) {
  if (changes.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Product changes awaiting approval
        </h2>
        <span className="text-xs text-muted">
          {changes.length} request{changes.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {changes.map((change) => (
          <ChangeCard key={change.id} change={change} />
        ))}
      </div>
    </section>
  );
}

function ChangeCard({ change }: { change: ProductChangeView }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /*
    Approving would be refused while stock is allocated through the line — the
    service re-checks at the moment of the write, not merely when the request
    was raised. Saying so here means an approver is not told "no" only after
    pressing the button.
  */
  const blocked = change.allocatedQty > 0;

  function decide(decision: 'approve' | 'reject'): void {
    setError(null);
    startTransition(async () => {
      const result = await reviewProductChangeAction(
        change.id,
        decision,
        note.trim() ? { note: note.trim() } : {},
        change.billId,
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(decision === 'approve' ? 'Change approved.' : 'Change rejected.');
      setNote('');
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              <Link href={`/procurement/${change.billId}`} className="hover:underline">
                Bill {change.billNumber}
              </Link>
              <span className="text-muted"> · line “{change.productName}”</span>
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Requested by {change.requestedBy.name} · {formatDateTime(change.requestedAt)}
            </p>
          </div>
          <Badge variant="warning">Pending</Badge>
        </div>

        {/*
          Before and after, with both stock figures on each side. CRM stock and
          RS stock are separate numbers about the same goods and are labelled
          separately here for the same reason they are everywhere else: an
          approver comparing two products needs to see both, and one standing in
          for the other would misinform the decision.
        */}
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-3 sm:flex-row sm:items-center">
          <ProductSide label="Currently mapped to" product={change.fromRsProduct} />
          <ArrowRight className="size-4 shrink-0 rotate-90 text-muted sm:rotate-0" />
          <ProductSide label="Requested" product={change.toRsProduct} />
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted">Reason given</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{change.reason}</p>
        </div>

        {blocked && (
          <ErrorMessage
            message={`${change.allocatedQty} unit(s) of this line are allocated to orders. Release them before this change can be approved.`}
          />
        )}
        {error && <ErrorMessage message={error} />}

        <Separator />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            placeholder="Note (optional on approval, expected on rejection)"
            className="flex-1"
          />
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => decide('reject')}
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
              Reject
            </Button>
            {/*
              Rejection stays available even when approval is blocked: a request
              that cannot be granted should still be closeable with a reason,
              rather than sitting in the queue forever.
            */}
            <Button
              type="button"
              size="sm"
              disabled={pending || blocked}
              onClick={() => decide('approve')}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              Approve
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProductSide({
  label,
  product,
}: {
  label: string;
  product: ProductChangeView['fromRsProduct'];
}) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-0.5 truncate text-sm text-ink">{product.title}</p>
      <p className="font-mono text-[11px] text-muted">SKU: {product.sku ?? 'Not available'}</p>
      <p className="mt-0.5 text-[11px] text-muted tabular">
        CRM stock {product.crmStockQty} · RS stock {product.rsStockQty}
      </p>
    </div>
  );
}
