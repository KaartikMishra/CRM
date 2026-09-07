'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { createPurchaseBillSchema, isValidAmount, lineTotal } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ErrorMessage } from '@/components/common/error-message';
import { ImageUploadField } from '@/components/product-enquiry/image-upload-field';
import { formatCurrency } from '@/lib/format';
import { createPurchaseBillAction, createVendorAction } from '@/app/(app)/procurement/actions';

/**
 * Recording a vendor's bill.
 *
 * A bill belongs to one vendor because that is how the paperwork arrives;
 * buying the same shortage from three suppliers is three bills. Received
 * quantity is captured here rather than assumed equal to ordered, since goods
 * routinely arrive short and only what actually turned up can be allocated.
 */

type ItemDraft = {
  key: string;
  /** As written on the vendor's bill. Free text — this is a record of a document. */
  productName: string;
  orderedQty: string;
  receivedQty: string;
  rate: string;
};

/**
 * Row keys must match between the server and client renders, so the first row
 * has a fixed key and later ones come from a ref that only advances on a click
 * — the same hydration trap the enquiry and sales forms document.
 */
const emptyItem = (key: string): ItemDraft => ({
  key,
  productName: '',
  orderedQty: '',
  receivedQty: '',
  rate: '',
});

export function CreateBillForm({
  vendors,
}: {
  vendors: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const formId = useId();
  const nextKey = useRef(1);

  const [billNumber, setBillNumber] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [billType, setBillType] = useState<'CREDIT' | 'PAID_UP'>('CREDIT');
  const [billDate, setBillDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedBy, setExpectedBy] = useState('');
  const [billImageAssetId, setBillImageAssetId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<ItemDraft[]>([emptyItem('i0')]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Inline vendor creation. A bill often arrives from a supplier nobody has
  // recorded yet, and sending the user away to a vendor screen loses the bill
  // they were halfway through typing.
  const [vendorList, setVendorList] = useState(vendors);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [newVendorName, setNewVendorName] = useState('');
  const [vendorError, setVendorError] = useState<string | null>(null);

  function addVendor(): void {
    const name = newVendorName.trim();
    if (name.length < 2) {
      setVendorError('Enter the vendor name.');
      return;
    }
    setVendorError(null);
    startTransition(async () => {
      const result = await createVendorAction({ name });
      if (!result.ok) {
        setVendorError(result.message);
        return;
      }
      const created = result.data.vendor;
      // Added to the list and selected, so the bill can carry straight on.
      setVendorList((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
      setVendorId(created.id);
      setNewVendorName('');
      setVendorOpen(false);
      toast.success(`${created.name} added.`);
    });
  }

  const patch = (key: string, changes: Partial<ItemDraft>) =>
    setItems((rows) => rows.map((r) => (r.key === key ? { ...r, ...changes } : r)));

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    // The shared cuid schema rejects "" with "Not a valid identifier", which is
    // accurate and useless: the field is not malformed, it is empty. Naming the
    // omission directly is the difference between a user knowing what to do and
    // wondering what an identifier is.
    const missing: Record<string, string> = {};
    if (!vendorId) missing.vendorId = 'Choose a vendor';
    items.forEach((item, index) => {
      if (!item.productName.trim()) {
        missing[`items.${index}.productName`] = 'Enter the product name from the bill';
      }
    });
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      setError('Check the highlighted fields.');
      return;
    }

    const parsed = createPurchaseBillSchema.safeParse({
      billNumber,
      vendorId,
      billType,
      billDate,
      ...(expectedBy ? { expectedBy } : {}),
      ...(billImageAssetId ? { billImageAssetId } : {}),
      ...(notes.trim() ? { notes } : {}),
      items: items.map((i) => ({
        productName: i.productName.trim(),
        orderedQty: Number(i.orderedQty),
        // Recording a bill is recording what arrived, so received defaults to
        // the quantity billed rather than to zero.
        receivedQty: i.receivedQty === '' ? Number(i.orderedQty) : Number(i.receivedQty),
        rate: i.rate,
      })),
    });

    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) errors[issue.path.join('.')] ??= issue.message;
      setFieldErrors(errors);
      setError('Check the highlighted fields.');
      return;
    }

    startTransition(async () => {
      const result = await createPurchaseBillAction(parsed.data);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(`Bill ${result.data.bill.billNumber} recorded.`);
      router.push(`/procurement/${result.data.bill.id}`);
    });
  }

  return (
    <form id={formId} onSubmit={submit} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bill details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-number`}>Bill number</Label>
            <Input
              id={`${formId}-number`}
              value={billNumber}
              onChange={(e) => setBillNumber(e.target.value)}
              placeholder="e.g. INV-4471"
            />
            {fieldErrors.billNumber && <p className="text-xs text-critical">{fieldErrors.billNumber}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-vendor`}>Vendor</Label>
            <div className="flex items-center gap-2">
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger id={`${formId}-vendor`} className="flex-1">
                  <SelectValue placeholder="Choose a vendor" />
                </SelectTrigger>
                <SelectContent>
                  {vendorList.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setVendorOpen(true)}
              >
                <Plus className="size-4" />
                Add Vendor
              </Button>
            </div>
            {fieldErrors.vendorId && <p className="text-xs text-critical">{fieldErrors.vendorId}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-type`}>Bill type</Label>
            <Select value={billType} onValueChange={(v) => setBillType(v as 'CREDIT' | 'PAID_UP')}>
              <SelectTrigger id={`${formId}-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CREDIT">Credit</SelectItem>
                <SelectItem value="PAID_UP">Paid Up</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-date`}>Bill date</Label>
            <Input
              id={`${formId}-date`}
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-expected`}>Expected by (optional)</Label>
            <Input
              id={`${formId}-expected`}
              type="date"
              value={expectedBy}
              onChange={(e) => setExpectedBy(e.target.value)}
            />
            {fieldErrors.expectedBy && <p className="text-xs text-critical">{fieldErrors.expectedBy}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Bill image</Label>
            <ImageUploadField value={billImageAssetId} onChange={setBillImageAssetId} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Products</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setItems((rows) => [...rows, emptyItem(`i${nextKey.current++}`)])}
          >
            <Plus className="size-4" />
            Add product
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/*
            A grid rather than a <table>: the same column alignment on desktop,
            but each row can stack on a narrow screen instead of forcing the
            page to scroll sideways. Header hidden below sm for that reason.
          */}
          <div className="hidden gap-3 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted sm:grid sm:grid-cols-[2fr_0.7fr_0.9fr_1fr_0.8fr_auto]">
            <span>Product name</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Rate</span>
            <span className="text-right">Total bill</span>
            <span className="text-right">Standing out</span>
            <span className="w-9" aria-hidden />
          </div>

          {items.map((item, index) => {
            const qty = Number(item.orderedQty);
            const validQty = Number.isFinite(qty) && qty > 0;
            // Total and standing are previews computed with the same exact
            // decimal helper the server uses — never a float, and never a value
            // that gets submitted. The server recomputes both from the ledger.
            const total = validQty && isValidAmount(item.rate) ? lineTotal(item.rate, qty) : null;
            // Nothing on a bill being typed has been allocated yet, so standing
            // out starts as the whole received quantity. It falls as the stock
            // is mapped to orders, which happens after the bill is saved.
            const received = item.receivedQty === '' ? qty : Number(item.receivedQty);
            const standing = validQty && Number.isFinite(received) ? Math.max(0, received) : null;

            return (
              <div key={item.key} className="flex flex-col gap-2">
                {index > 0 && <Separator className="sm:hidden" />}
                <div className="grid items-start gap-3 sm:grid-cols-[2fr_0.7fr_0.9fr_1fr_0.8fr_auto]">
                  <div className="flex flex-col gap-1.5">
                    <Label className="sm:hidden">Product name</Label>
                    <Input
                      value={item.productName}
                      onChange={(e) => patch(item.key, { productName: e.target.value })}
                      placeholder="As written on the bill"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label className="sm:hidden">Qty</Label>
                    <Input
                      inputMode="numeric"
                      className="text-right"
                      value={item.orderedQty}
                      onChange={(e) => patch(item.key, { orderedQty: e.target.value })}
                      placeholder="0"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label className="sm:hidden">Rate</Label>
                    <Input
                      inputMode="decimal"
                      className="text-right"
                      value={item.rate}
                      onChange={(e) => patch(item.key, { rate: e.target.value })}
                      placeholder="0.00"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label className="sm:hidden">Total bill</Label>
                    <output className="flex h-10 items-center justify-end rounded-md border border-line bg-surface-2 px-3 text-sm text-ink tabular">
                      {total ? formatCurrency(total) : '—'}
                    </output>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label className="sm:hidden">Standing out</Label>
                    <output className="flex h-10 items-center justify-end rounded-md border border-line bg-surface-2 px-3 text-sm tabular">
                      {standing === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className="font-medium text-positive">{standing}</span>
                      )}
                    </output>
                  </div>

                  <div className="flex items-start">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-0"
                      disabled={items.length === 1}
                      onClick={() => setItems((rows) => rows.filter((r) => r.key !== item.key))}
                      aria-label="Remove line"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {fieldErrors[`items.${index}.productName`] && (
                  <p className="text-xs text-critical">{fieldErrors[`items.${index}.productName`]}</p>
                )}
                {fieldErrors[`items.${index}.orderedQty`] && (
                  <p className="text-xs text-critical">{fieldErrors[`items.${index}.orderedQty`]}</p>
                )}
                {fieldErrors[`items.${index}.rate`] && (
                  <p className="text-xs text-critical">{fieldErrors[`items.${index}.rate`]}</p>
                )}
              </div>
            );
          })}

          {fieldErrors.items && <p className="text-xs text-critical">{fieldErrors.items}</p>}
        </CardContent>
      </Card>

      {error && <ErrorMessage message={error} />}

      <Dialog open={vendorOpen} onOpenChange={(next) => !pending && setVendorOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add vendor</DialogTitle>
            <DialogDescription>
              Added to the shared vendor master — the same list Product Enquiry uses.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-new-vendor`}>Vendor name</Label>
            <Input
              id={`${formId}-new-vendor`}
              value={newVendorName}
              onChange={(e) => setNewVendorName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addVendor();
                }
              }}
              placeholder="e.g. Shree Brass Works"
            />
          </div>

          {vendorError && <ErrorMessage message={vendorError} />}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setVendorOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={addVendor} disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Add vendor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/procurement')}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          Record bill
        </Button>
      </div>
    </form>
  );
}
