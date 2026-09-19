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
import { RsProductPicker, type PickedProduct } from '@/components/products/rs-product-picker';
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
  /**
   * The RS Product this line is for. The line's product selection, full stop.
   *
   * There used to be a free-text "Product name — as written on the bill" field
   * beside this, and it is gone. A typed name is not an identity: it matched
   * nothing, it let two spellings of one product sit on the shortage board as
   * two rows, and it invited recording a line whose goods the CRM could never
   * reconcile. What is stored as the line's description is now the title of the
   * product somebody deliberately picked here.
   *
   * Nothing is ever derived the other way. A SKU does not resolve to a product
   * — RS SKUs are nullable and legitimately repeat — and no wording is matched
   * against the catalogue, because a purchase attached to the wrong product
   * cannot be untangled once its stock is allocated.
   *
   * If the right product is not in the catalogue, it is created in RS Products
   * first and mapped afterwards. This form never creates one.
   */
  rsProduct: PickedProduct | null;
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
  rsProduct: null,
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
      if (!item.rsProduct) {
        missing[`items.${index}.rsProductId`] = 'Choose the RS Product this line is for';
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
        /*
          Only the id. `productName` is deliberately not sent: the server takes
          the chosen product's title, so the line's description is the catalogue
          entry a person actually selected rather than something typed beside
          it that could say anything at all.
        */
        ...(i.rsProduct ? { rsProductId: i.rsProduct.id } : {}),
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
            A grid rather than a <table>: the same column alignment on a wide
            screen, but each row can stack on a narrow one instead of forcing
            the page to scroll sideways.

            The numeric columns are fixed widths and the product column is
            `minmax(240px, 1fr)`. That combination is what stops the row
            overflowing: a grid item defaults to `min-width: auto`, so an `fr`
            column refuses to shrink below its content — and a formatted total
            like ₹1,50,006.00 is wider than the share an `fr` track was giving
            it, which pushed the whole row past the card. Fixed tracks cannot be
            squeezed at all, and the product column absorbs the remainder and is
            free to shrink because its cell carries `min-w-0`.

            `lg` rather than `sm`, because the five fixed tracks plus their gaps
            need roughly 800px before the product name has usable room left.
          */}
          <div className="hidden gap-3 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted lg:grid lg:grid-cols-[minmax(240px,1fr)_96px_120px_150px_120px_auto]">
            <span>RS Product</span>
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
                <div className="grid items-start gap-3 lg:grid-cols-[minmax(240px,1fr)_96px_120px_150px_120px_auto]">
                  {/*
                    The product selection, in the column the free-text name used
                    to occupy. It is the first field on the row because it is the
                    line's identity — everything to the right of it is a quantity
                    about goods this has already named.

                    `min-w-0` is load-bearing. Without it this cell's automatic
                    minimum is its content's width, so a long catalogue title
                    would widen the track and push the row off the card instead
                    of letting the picker's own `truncate` take effect.
                  */}
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${formId}-rs-${item.key}`} className="lg:hidden">
                      RS Product
                    </Label>
                    <RsProductPicker
                      id={`${formId}-rs-${item.key}`}
                      value={item.rsProduct}
                      onChange={(product) => patch(item.key, { rsProduct: product })}
                      disabled={pending}
                      placeholder="Select RS Product"
                    />
                    {/*
                      The chosen product's SKU, directly beneath the product it
                      belongs to rather than under the whole row. Confirmation
                      rather than input: it is how a person checks that the row
                      they clicked is the product on the paper in front of them,
                      and it identifies nothing.

                      `break-all` because a SKU is an unbroken token with no
                      space to wrap at, and a long one would otherwise widen this
                      cell past the track it sits in.
                    */}
                    {item.rsProduct && (
                      <p className="break-all font-mono text-[11px] text-muted">
                        SKU: {item.rsProduct.sku ?? 'Not available'}
                      </p>
                    )}
                  </div>

                  {/*
                    The four figures.

                    Wrapped in their own two-column grid below `lg` so they sit
                    2×2 instead of each taking a full-width line, and dissolved
                    with `lg:contents` at `lg` so they become direct children of
                    the row grid and line up under the headers above. One
                    arrangement, no duplicated markup.
                  */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:contents">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label className="lg:hidden">Qty</Label>
                      <Input
                        inputMode="numeric"
                        className="text-right"
                        value={item.orderedQty}
                        onChange={(e) => patch(item.key, { orderedQty: e.target.value })}
                        placeholder="0"
                      />
                    </div>

                    {/*
                      Rate is typed, always. It is deliberately not filled in
                      from the selected product: RS Products carries a selling
                      price, and what belongs on a purchase bill is what this
                      vendor actually charged — negotiated, discounted or marked
                      up. Choosing a product says what the goods are and nothing
                      about what they cost.
                    */}
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label className="lg:hidden">Rate</Label>
                      <Input
                        inputMode="decimal"
                        className="text-right"
                        value={item.rate}
                        onChange={(e) => patch(item.key, { rate: e.target.value })}
                        placeholder="0.00"
                      />
                    </div>

                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label className="lg:hidden">Total bill</Label>
                      {/*
                        Quantity × Rate, read-only. An <output>, not a disabled
                        input: there is no value to submit here, and the server
                        recomputes the line total from the ledger regardless.
                      */}
                      <output className="flex h-10 items-center justify-end truncate rounded-md border border-line bg-surface-2 px-3 text-sm text-ink tabular">
                        {total ? formatCurrency(total) : '—'}
                      </output>
                    </div>

                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label className="lg:hidden">Standing out</Label>
                      <output className="flex h-10 items-center justify-end truncate rounded-md border border-line bg-surface-2 px-3 text-sm tabular">
                        {standing === null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span className="font-medium text-positive">{standing}</span>
                        )}
                      </output>
                    </div>
                  </div>

                  {/*
                    Kept reachable at every width: it sits in the row's last
                    track on a wide screen and on its own line, right-aligned,
                    once the row stacks.
                  */}
                  <div className="flex items-start justify-end lg:justify-start">
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

                {fieldErrors[`items.${index}.rsProductId`] && (
                  <p className="text-xs text-critical">{fieldErrors[`items.${index}.rsProductId`]}</p>
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

          <p className="text-xs text-muted">
            Every line names a product from the RS Products catalogue. If the product on the bill is
            not there yet, add it in RS Products first and then record this bill — recording a bill
            never creates a product, and no line is mapped to an approximate match.
          </p>
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
