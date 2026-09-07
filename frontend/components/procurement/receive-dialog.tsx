'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Loader2, PackageCheck } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorMessage } from '@/components/common/error-message';
import { receiveItemAction } from '@/app/(app)/procurement/actions';

/**
 * Recording what actually arrived.
 *
 * Raising this is what creates allocatable stock, so it is a deliberate action
 * rather than an inline edit. Lowering it below what has already been allocated
 * is refused by the API — that stock is promised to an order.
 */
export function ReceiveDialog({
  billId,
  item,
}: {
  billId: string;
  item: PurchaseBillItemView;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(String(item.receivedQty));
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    const receivedQty = Number(value);
    if (!Number.isInteger(receivedQty) || receivedQty < 0) {
      setError('Enter a whole number of units.');
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await receiveItemAction(billId, item.id, { receivedQty });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(`Recorded ${receivedQty} received.`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <PackageCheck className="size-4" />
        Receive
      </Button>

      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Receive {item.productName}</DialogTitle>
            <DialogDescription>
              {item.orderedQty} ordered. {item.allocatedQty > 0
                ? `${item.allocatedQty} already allocated to orders.`
                : 'Nothing allocated yet.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="received-qty">Received quantity</Label>
            <Input
              id="received-qty"
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="text-xs text-muted">Cannot exceed the {item.orderedQty} ordered.</p>
          </div>

          {error && <ErrorMessage message={error} />}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
