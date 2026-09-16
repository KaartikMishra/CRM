'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { VendorMappingRow } from '@rs/shared';
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
import {
  createMappingAction,
  updateMappingAction,
} from '@/app/(app)/vendor-invoices/actions';
import { RsProductPicker, type PickedProduct } from './rs-product-picker';

/**
 * Creating and editing a vendor↔product mapping.
 *
 * Both dialogs write `currentRate` and nothing else — the price agreed *today*.
 * Neither can touch what a past purchase cost: that lives on Procurement's
 * purchase records, which this module reads and never writes. The rate boxes
 * here say "current" for exactly that reason.
 */

/** A rate as people type it: digits, with up to two decimal places. */
const RATE_PATTERN = /^\d+(\.\d{1,2})?$/;

const rateError = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) return 'Enter the agreed rate';
  if (!RATE_PATTERN.test(value)) return 'Enter an amount, such as 1250 or 1250.50';
  return null;
};

// ---------------------------------------------------------------------------
//  Map a product
// ---------------------------------------------------------------------------

export function MapProductDialog({
  open,
  onOpenChange,
  vendorId,
  vendorName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendorId: string;
  vendorName: string;
}) {
  const router = useRouter();
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [rate, setRate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ product?: string; rate?: string }>({});
  const [pending, startTransition] = useTransition();

  // Reopening must not show the last attempt's values or its error.
  useEffect(() => {
    if (!open) return;
    setProduct(null);
    setRate('');
    setError(null);
    setFieldErrors({});
  }, [open]);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const problems: { product?: string; rate?: string } = {};
    if (!product) problems.product = 'Choose a product from the catalogue';
    const badRate = rateError(rate);
    if (badRate) problems.rate = badRate;

    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;

    startTransition(async () => {
      const result = await createMappingAction({
        vendorId,
        rsProductId: product!.id,
        currentRate: rate.trim(),
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Map a product to {vendorName}</DialogTitle>
          <DialogDescription>
            Records what this vendor supplies and what they charge today. Past purchases keep the
            rate they were billed at.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {error && <ErrorMessage message={error} />}

          <div className="space-y-1.5">
            <Label htmlFor="mapping-product">
              Product<span className="ml-0.5 text-critical">*</span>
            </Label>
            <RsProductPicker value={product} onChange={setProduct} disabled={pending} />
            {fieldErrors.product ? (
              <p className="text-xs text-critical">{fieldErrors.product}</p>
            ) : (
              <p className="text-xs text-muted">
                From the RS Products catalogue — the CRM&apos;s canonical product list.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mapping-rate">
              Current rate<span className="ml-0.5 text-critical">*</span>
            </Label>
            <Input
              id="mapping-rate"
              inputMode="decimal"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
              placeholder="1250.00"
              disabled={pending}
              aria-invalid={fieldErrors.rate ? true : undefined}
            />
            {fieldErrors.rate ? (
              <p className="text-xs text-critical">{fieldErrors.rate}</p>
            ) : (
              <p className="text-xs text-muted">
                Per unit, in rupees. This is the agreed price going forward, not a past bill.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Mapping…' : 'Map product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
//  Edit a mapping's rate
// ---------------------------------------------------------------------------

export function EditMappingRateDialog({
  open,
  onOpenChange,
  mapping,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapping: VendorMappingRow;
}) {
  const router = useRouter();
  const [rate, setRate] = useState(mapping.currentRate);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setRate(mapping.currentRate);
    setError(null);
    setFieldError(null);
  }, [open, mapping.currentRate]);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const problem = rateError(rate);
    setFieldError(problem);
    if (problem) return;

    startTransition(async () => {
      const result = await updateMappingAction(mapping.id, { currentRate: rate.trim() });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit rate for {mapping.productTitle}</DialogTitle>
          <DialogDescription>
            Changes what {mapping.vendorName} charges from now on. Purchases already recorded keep
            the rate they were billed at.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {error && <ErrorMessage message={error} />}

          <div className="space-y-1.5">
            <Label htmlFor="edit-mapping-rate">
              Current rate<span className="ml-0.5 text-critical">*</span>
            </Label>
            <Input
              id="edit-mapping-rate"
              inputMode="decimal"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
              placeholder="1250.00"
              disabled={pending}
              autoFocus
              aria-invalid={fieldError ? true : undefined}
            />
            {fieldError ? (
              <p className="text-xs text-critical">{fieldError}</p>
            ) : (
              <p className="text-xs text-muted">Per unit, in rupees.</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save rate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
