'use client';

import { useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { isValidAmount, lineTotal, type SalesOrderItemView } from '@rs/shared';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { ImageUploadField } from '@/components/product-enquiry/image-upload-field';
import { formatCurrency } from '@/lib/format';
import { createChangeRequestAction } from '@/app/(app)/sales/actions';

/**
 * The three dialogs that file a product change request.
 *
 * None of them changes anything. Each records what was asked for and says so
 * plainly — the submit button reads "Submit for approval" rather than "Save",
 * because nothing is saved until somebody else decides it.
 *
 * `decidesImmediately` only changes the wording: whether a request is applied
 * on submission is the API's decision, taken from the caller's permissions and
 * never from anything sent by this form.
 */

type ProductDraft = {
  productName: string;
  quantity: string;
  price: string;
  imageAssetId: string | null;
};

/** Live preview of the proposed line, using the same exact helpers the server does. */
function useLinePreview(draft: ProductDraft) {
  const qty = Number(draft.quantity);
  const priceable =
    Number.isInteger(qty) && qty >= 1 && isValidAmount(draft.price.trim());
  return {
    ready: draft.productName.trim() !== '' && priceable,
    total: priceable ? lineTotal(draft.price.trim(), qty) : null,
    quantity: qty,
  };
}

function ProductFields({
  idPrefix,
  draft,
  onChange,
  preview,
}: {
  idPrefix: string;
  draft: ProductDraft;
  onChange: (patch: Partial<ProductDraft>) => void;
  preview: ReturnType<typeof useLinePreview>;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-[132px_1fr]">
      <ImageUploadField
        value={draft.imageAssetId}
        onChange={(assetId) => onChange({ imageAssetId: assetId })}
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Product name</Label>
          <Input
            id={`${idPrefix}-name`}
            value={draft.productName}
            onChange={(e) => onChange({ productName: e.target.value })}
            placeholder="Hammered copper bottle"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-qty`}>Quantity</Label>
            <Input
              id={`${idPrefix}-qty`}
              inputMode="numeric"
              value={draft.quantity}
              onChange={(e) => onChange({ quantity: e.target.value })}
              placeholder="12"
              className="tabular"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-price`}>Price per unit</Label>
            <Input
              id={`${idPrefix}-price`}
              inputMode="decimal"
              value={draft.price}
              onChange={(e) => onChange({ price: e.target.value })}
              placeholder="1250.50"
              className="tabular"
            />
          </div>
        </div>

        {/* Derived, never submitted — quantity × price. */}
        <div className="flex items-center justify-between rounded-md border border-line bg-surface-2 px-3 py-2">
          <span className="text-xs uppercase tracking-wider text-muted">Line total</span>
          <span className="font-mono text-sm text-ink tabular">
            {preview.total ? formatCurrency(preview.total) : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}

const blank = (): ProductDraft => ({
  productName: '',
  quantity: '',
  price: '',
  imageAssetId: null,
});

// ---------------------------------------------------------------------------

export function AddProductDialog({
  orderId,
  open,
  onOpenChange,
  decidesImmediately,
}: {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decidesImmediately: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<ProductDraft>(blank);
  const preview = useLinePreview(draft);

  function submit() {
    if (!preview.ready) return;
    startTransition(async () => {
      const result = await createChangeRequestAction(orderId, {
        type: 'ADD',
        productName: draft.productName.trim(),
        quantity: preview.quantity,
        price: draft.price.trim(),
        ...(draft.imageAssetId ? { productImageAssetId: draft.imageAssetId } : {}),
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      onOpenChange(false);
      setDraft(blank());
      toast.success('Product submitted for approval');
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setDraft(blank());
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a product</DialogTitle>
          <DialogDescription>
            {decidesImmediately
              ? 'This is put forward as a request. Approve it afterwards to add it to the order.'
              : 'This is put forward for approval. It will not appear on the order or change the total until an administrator approves it.'}
          </DialogDescription>
        </DialogHeader>

        <ProductFields
          idPrefix="addProduct"
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          preview={preview}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !preview.ready}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

export function EditProductDialog({
  orderId,
  item,
  onClose,
}: {
  orderId: string;
  item: SalesOrderItemView | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<ProductDraft>(blank);
  const preview = useLinePreview(draft);

  // Seeded from the live line the first time it opens, so the dialog shows what
  // is there now and the person edits from reality rather than from blank.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (item && seededFor !== item.id) {
    setSeededFor(item.id);
    setDraft({
      productName: item.productName,
      quantity: String(item.quantity),
      price: item.price,
      imageAssetId: item.image?.id ?? null,
    });
  }

  function submit() {
    if (!item || !preview.ready) return;
    startTransition(async () => {
      const result = await createChangeRequestAction(orderId, {
        type: 'EDIT',
        itemId: item.id,
        productName: draft.productName.trim(),
        quantity: preview.quantity,
        price: draft.price.trim(),
        productImageAssetId: draft.imageAssetId,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      onClose();
      setSeededFor(null);
      toast.success('Change submitted for approval');
    });
  }

  return (
    <Dialog open={item !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit product</DialogTitle>
          <DialogDescription>
            The product on the order stays exactly as it is until this change is approved. The
            order total will not move in the meantime.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <>
            {/* What is on the order right now, so the two are visibly different things. */}
            <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
              <span className="text-[11px] uppercase tracking-wider text-muted">Currently</span>
              <p className="mt-0.5 text-sm text-ink tabular">
                {item.productName} · {item.quantity} × {formatCurrency(item.price)} ={' '}
                {formatCurrency(item.lineTotal)}
              </p>
            </div>

            <ProductFields
              idPrefix="editProduct"
              draft={draft}
              onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
              preview={preview}
            />
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !preview.ready}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

export function RemoveProductDialog({
  orderId,
  item,
  onClose,
}: {
  orderId: string;
  item: SalesOrderItemView | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!item) return;
    startTransition(async () => {
      const result = await createChangeRequestAction(orderId, {
        type: 'REMOVE',
        itemId: item.id,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      onClose();
      toast.success('Removal submitted for approval');
    });
  }

  return (
    <AlertDialog open={item !== null} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Request removal of this product?</AlertDialogTitle>
          <AlertDialogDescription>
            This product stays on the order and keeps counting towards the total until the removal
            is approved. Nothing changes right now.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {item && (
          <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
            <p className="text-sm text-ink tabular">
              {item.productName} · {item.quantity} × {formatCurrency(item.price)} ={' '}
              {formatCurrency(item.lineTotal)}
            </p>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Request removal
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
