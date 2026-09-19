'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Package } from 'lucide-react';
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
import { ErrorMessage } from '@/components/common/error-message';
import { RsProductPicker, type PickedProduct } from '@/components/products/rs-product-picker';
import { mapPurchaseItemAction } from '@/app/(app)/procurement/actions';

/**
 * Saying which RS Product a purchase line is for.
 *
 * The same picker Vendor Invoices and Sales use, and the same rule: what is
 * stored is the `RsProduct.id` of the row the person actually clicked. The
 * picker searches titles and SKUs, but a SKU never decides the answer — RS SKUs
 * are nullable and legitimately repeat across products, so a search for one can
 * return several rows and the person picks among them. Nothing is resolved
 * automatically, and the vendor's wording on the line is not evidence of
 * anything.
 *
 * Product level throughout. No variant is offered, selected or stored: the RS
 * Products API reports stock as a product-level figure, which is what
 * Procurement reads.
 *
 * FIRST MAPPING ONLY. Naming goods nobody has named is ordinary procurement
 * work and applies at once. Moving a line that already names a product is a
 * different act with a different dialog — ChangeRsProductDialog — because by
 * then the mapping has been read by the shortage board and is what allocation
 * compares identity on. The server enforces that split regardless of which
 * dialog the UI opens.
 */
export function MapRsProductDialog({
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
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reopening must not show the last attempt's selection or its error. The
  // current mapping seeds the picker so the dialog opens on what is true now.
  useEffect(() => {
    if (!open) return;
    setProduct(
      item.rsProduct
        ? {
            id: item.rsProduct.id,
            title: item.rsProduct.title,
            sku: item.rsProduct.sku,
            imageUrl: item.rsProduct.imageUrl,
          }
        : null,
    );
    setError(null);
  }, [open, item.rsProduct]);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!product) {
      setError('Choose the RS Product this line is for.');
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await mapPurchaseItemAction(billId, item.id, { rsProductId: product.id });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(`Mapped to ${product.title}.`);
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Map to an RS Product</DialogTitle>
          <DialogDescription>
            The vendor&apos;s bill calls this line “{item.productName}”. Choose the RS Product it
            refers to — that wording stays exactly as recorded.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {error && <ErrorMessage message={error} />}

          <div className="space-y-1.5">
            <Label htmlFor={`rs-product-${item.id}`}>
              RS Product<span className="ml-0.5 text-critical">*</span>
            </Label>
            <RsProductPicker
              id={`rs-product-${item.id}`}
              value={product}
              onChange={setProduct}
              disabled={pending}
            />
            <p className="text-xs text-muted">
              Search by product name or SKU. A SKU can belong to more than one product, so pick the
              row you mean — nothing is matched for you.
            </p>
          </div>

          {product && (
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
              <Package className="size-3.5 shrink-0" />
              <span>
                Stock and identity for this line will come from{' '}
                <span className="text-ink">{product.title}</span> in RS Products.
              </span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {/*
              Always "Map product". This dialog is only ever opened for an
              unmapped line now — changing an existing mapping goes through
              ChangeRsProductDialog and an approval — so the branch that said
              "Change mapping" described a state that can no longer reach here.
            */}
            <Button type="submit" disabled={pending || !product}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Map product
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
