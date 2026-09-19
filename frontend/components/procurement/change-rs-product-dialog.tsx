'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { PurchaseBillItemView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { RsProductPicker, type PickedProduct } from '@/components/products/rs-product-picker';
import { requestProductChangeAction } from '@/app/(app)/procurement/actions';

/**
 * Asking to move an already-mapped purchase line to a different RS Product.
 *
 * Deliberately not the same dialog as the initial mapping, because it is not the
 * same act. Mapping an unmapped line names goods nobody had named and takes
 * effect at once; changing a mapping moves a line that the shortage board has
 * been read against and that allocation compares identity on, so it is a request
 * an administrator decides. The separate title, the mandatory reason and the
 * before/after pair are all there so nobody presses this thinking it is an edit.
 *
 * The picker never offers the current product as an answer — the server refuses
 * a request that proposes it — and nothing is matched automatically from the
 * vendor's wording or from a SKU.
 */
export function ChangeRsProductDialog({
  billId,
  item,
  open,
  onOpenChange,
}: {
  billId: string;
  item: PurchaseBillItemView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reopening must not show the last attempt's selection, reason or error. The
  // picker starts empty rather than seeded with the current mapping: the answer
  // being asked for is the *new* product, and pre-filling the old one would
  // invite submitting a request that proposes no change at all.
  useEffect(() => {
    if (!open) return;
    setProduct(null);
    setReason('');
    setError(null);
  }, [open]);

  const current = item.rsProduct;

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!product) {
      setError('Choose the RS Product this line should be mapped to instead.');
      return;
    }
    if (product.id === current?.id) {
      setError('That is the product this line is already mapped to.');
      return;
    }
    if (reason.trim().length < 10) {
      setError('Explain why this line should be re-mapped — at least a sentence.');
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await requestProductChangeAction(billId, item.id, {
        rsProductId: product.id,
        reason: reason.trim(),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success('Change requested — an administrator will review it.');
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request a product change</DialogTitle>
          <DialogDescription>
            This line is already mapped, so changing it needs an administrator&apos;s approval. The
            current mapping stays exactly as it is until the request is approved.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {error && <ErrorMessage message={error} />}

          {/*
            Both ends of the move, side by side. An approver and a requester are
            answering the same question — are these the same goods — and neither
            can answer it from one title alone.
          */}
          <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3 text-xs sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wider text-muted">Currently mapped to</p>
              <p className="mt-0.5 truncate text-ink">{current?.title ?? '—'}</p>
              <p className="font-mono text-[11px] text-muted">
                SKU: {current?.sku ?? 'Not available'}
              </p>
            </div>
            <ArrowRight className="size-4 shrink-0 rotate-90 text-muted sm:rotate-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wider text-muted">Requested</p>
              <p className="mt-0.5 truncate text-ink">{product?.title ?? 'Not chosen yet'}</p>
              <p className="font-mono text-[11px] text-muted">
                SKU: {product ? product.sku ?? 'Not available' : '—'}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`change-rs-${item.id}`}>
              New RS Product<span className="ml-0.5 text-critical">*</span>
            </Label>
            <RsProductPicker
              id={`change-rs-${item.id}`}
              value={product}
              onChange={setProduct}
              disabled={pending}
              placeholder="Search the RS Products catalogue"
            />
            <p className="text-xs text-muted">
              Search by product name or SKU. A SKU can belong to more than one product, so pick the
              row you mean — nothing is matched for you.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`change-reason-${item.id}`}>
              Reason<span className="ml-0.5 text-critical">*</span>
            </Label>
            <Textarea
              id={`change-reason-${item.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              rows={3}
              placeholder={`Why does “${item.productName}” refer to a different product?`}
            />
            <p className="text-xs text-muted">
              The approver is deciding whether these goods were misidentified, and cannot do that
              from two product names alone.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Nothing changes when you submit. The line keeps its current RS Product, and its stock
              and requirement arithmetic carry on unchanged, until an administrator approves.
            </span>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !product}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Request change
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
