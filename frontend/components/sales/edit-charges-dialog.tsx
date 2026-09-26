'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Loader2, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import { computeSalesTotals } from '@rs/shared';
import type { SalesChargeView, SalesMoneyView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorMessage } from '@/components/common/error-message';
import { formatCurrency } from '@/lib/format';
import { setSalesChargesAction } from '@/app/(app)/sales/actions';
import { ChargesEditor, usableCharges, type ChargeDraft } from './charges-editor';

/**
 * Editing an existing order's charges and adjustments.
 *
 * The whole set is sent, which is what the endpoint takes: these rows carry no
 * identity anybody refers to, so replacing them wholesale is both simpler and
 * impossible to half-apply.
 *
 * The preview underneath recomputes the payable with the same shared function
 * the server uses, so somebody can see what a discount does before saving it.
 * It is only a preview — the API decides, and refuses a set that would take the
 * order below what the customer has already paid.
 */
export function EditChargesDialog({
  orderId,
  charges,
  money,
  disabled = false,
  needsApproval = false,
  pending = false,
}: {
  orderId: string;
  charges: SalesChargeView[];
  money: SalesMoneyView;
  disabled?: boolean;
  /**
   * True once the order already has charges, when saving files a request for
   * approval rather than applying the change.
   *
   * Presentation only — the API decides, and refuses to apply a change to an
   * existing set whatever this says. It is passed in so the dialog can tell
   * somebody what pressing the button will actually do.
   */
  needsApproval?: boolean;
  /** A change is already waiting; the API refuses a second. */
  pending?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pendingSave, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<ChargeDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Reload from the record every time the dialog opens, so a cancelled edit
  // leaves nothing behind and a change made elsewhere is picked up.
  useEffect(() => {
    if (!open) return;
    setDrafts(
      charges.map((charge, index) => ({
        key: `${charge.id}-${index}`,
        type: charge.type,
        label: charge.label ?? '',
        amount: charge.amount,
      })),
    );
    setError(null);
  }, [open, charges]);

  /*
    The goods and their tax do not change here, so the preview reuses the
    figures the API already derived and only re-applies the charges on top.
    Recomputing the tax in the browser would be a second statement of it.
  */
  const usable = usableCharges(drafts);
  const preview = computeSalesTotals({
    split: money.taxSplit,
    items: [],
    charges: usable,
  });
  const goodsAndTax = Number(money.taxableSubtotal) + Number(money.taxTotal);
  const nextPayable = (
    goodsAndTax +
    Number(preview.chargesTotal) -
    Number(preview.discountTotal)
  ).toFixed(2);

  const belowPaid = Number(nextPayable) < Number(money.paid);

  function save(): void {
    setError(null);
    startTransition(async () => {
      const result = await setSalesChargesAction(orderId, usable);

      if (!result.ok) {
        setError(result.message);
        return;
      }

      toast.success(
        needsApproval
          ? 'Sent for approval. The order charges what it did until someone decides.'
          : 'Charges updated.',
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={disabled}>
        <Receipt className="size-4" />
        {charges.length > 0 ? 'Edit charges' : 'Add charges'}
      </Button>

      <Dialog open={open} onOpenChange={(next) => !pendingSave && setOpen(next)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Charges &amp; adjustments</DialogTitle>
            <DialogDescription>
              Duty, packing, shipping, customization and discounts. Everything here applies to the
              order as a whole, after GST.
              {needsApproval &&
                ' These charges already exist, so a change is sent for approval rather than applied.'}
            </DialogDescription>
          </DialogHeader>

          <ChargesEditor charges={drafts} onChange={setDrafts} disabled={pendingSave} />

          <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-3">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm text-muted">Goods and GST</span>
              <span className="font-mono text-sm text-ink tabular">
                {formatCurrency(goodsAndTax.toFixed(2), money.currency)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-t border-line pt-1.5">
              <span className="text-sm font-semibold text-ink">Total payable</span>
              <span className="font-mono text-sm font-semibold text-ink tabular">
                {formatCurrency(nextPayable, money.currency)}
              </span>
            </div>
            {belowPaid && (
              <p className="text-xs text-critical">
                This is below the {formatCurrency(money.paid, money.currency)} already paid, and
                will be refused.
              </p>
            )}
          </div>

          {error && <ErrorMessage message={error} />}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pendingSave}
            >
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={pendingSave || belowPaid || pending}>
              {pendingSave && <Loader2 className="size-4 animate-spin" />}
              Save charges
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
