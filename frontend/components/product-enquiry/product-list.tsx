'use client';

import { useState, useTransition } from 'react';
import { ImageIcon, Loader2, Plus, Store } from 'lucide-react';
import { toast } from 'sonner';
import {
  DIMENSION_UNITS,
  PRODUCT_MATCH_TYPES,
  WEIGHT_UNITS,
  createVendorResponseSchema,
  type EnquiryProductView,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ProductStatusBadge } from '@/components/common/status-badge';
import { formatDimension, formatWeight, label } from '@/lib/format';
import {
  addVendorResponseAction,
  createVendorAction,
  markNoVendorAction,
} from '@/app/(app)/product-enquiry/actions';
import { EntityPicker, type PickerOption } from './entity-picker';
import { VendorResponseCard } from './vendor-response-card';
import { ImageUploadField } from './image-upload-field';

type Props = {
  enquiryId: string;
  products: EnquiryProductView[];
  /** Resolved server-side from the backend permission + ownership model. */
  canRespond: boolean;
};

export function ProductList({ enquiryId, products, canRespond }: Props) {
  const [pending, startTransition] = useTransition();
  const [responseFor, setResponseFor] = useState<EnquiryProductView | null>(null);
  const [noVendorFor, setNoVendorFor] = useState<EnquiryProductView | null>(null);

  // vendor response draft
  const [vendor, setVendor] = useState<PickerOption | null>(null);
  const [rate, setRate] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');
  const [weightValue, setWeightValue] = useState('');
  const [weightUnit, setWeightUnit] = useState<(typeof WEIGHT_UNITS)[number]>('KG');
  // §20 — structured length/width/height, never free text. Held as strings so a
  // half-typed value is not coerced to NaN mid-keystroke; converted once on
  // submit, exactly as the enquiry create form does it.
  const [dimLength, setDimLength] = useState('');
  const [dimWidth, setDimWidth] = useState('');
  const [dimHeight, setDimHeight] = useState('');
  const [dimensionUnit, setDimensionUnit] =
    useState<(typeof DIMENSION_UNITS)[number]>('CM');
  const [notes, setNotes] = useState('');
  const [sameDay, setSameDay] = useState(false);
  // SIMILAR_PRODUCT first, matching the enum order and the historical default.
  const [matchType, setMatchType] =
    useState<(typeof PRODUCT_MATCH_TYPES)[number]>('SIMILAR_PRODUCT');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [imageAssetId, setImageAssetId] = useState<string | null>(null);

  // no-vendor draft
  const [noVendorReason, setNoVendorReason] = useState('');

  // inline vendor creation
  const [vendorDialogOpen, setVendorDialogOpen] = useState(false);
  const [newVendorName, setNewVendorName] = useState('');

  function resetResponse() {
    setVendor(null);
    setRate('');
    setDeliveryDays('');
    setWeightValue('');
    setDimLength('');
    setDimWidth('');
    setDimHeight('');
    setDimensionUnit('CM');
    setNotes('');
    setSameDay(false);
    setMatchType('SIMILAR_PRODUCT');
    setImageAssetId(null);
    setErrors({});
  }

  function submitResponse() {
    if (!responseFor) return;

    const weight = weightValue.trim() === '' ? undefined : Number(weightValue);

    // A dimension is only meaningful as a complete set, so it is sent when all
    // three sides are present and omitted otherwise — dimensions stay optional,
    // and a partly-filled set never reaches the API as a malformed object. Zod
    // then rejects zero or negative values on each side.
    const num = (v: string): number | undefined => {
      if (v.trim() === '') return undefined;
      const parsed = Number(v);
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    };
    const length = num(dimLength);
    const width = num(dimWidth);
    const height = num(dimHeight);
    const anyDimension = [length, width, height].some((v) => v !== undefined);
    const allDimensions = [length, width, height].every((v) => v !== undefined);

    const candidate = {
      vendorId: vendor?.id ?? '',
      matchType,
      ratePerUnit: rate.trim(),
      deliveryWithinDays: Number(deliveryDays),
      // Only sent when the vendor actually offers it, so an untouched control
      // records "not stated" rather than an explicit refusal.
      ...(sameDay ? { sameDay: true } : {}),
      ...(weight !== undefined && Number.isFinite(weight)
        ? { weight: { value: weight, unit: weightUnit } }
        : {}),
      ...(allDimensions
        ? {
            dimension: {
              length: length as number,
              width: width as number,
              height: height as number,
              unit: dimensionUnit,
            },
          }
        : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      // §32 — kept separate from the customer's own product image.
      ...(imageAssetId ? { imageAssetId } : {}),
    };

    // Caught before Zod, which never sees a partial set and so could not
    // explain this one. Silently dropping two typed sides would be worse.
    if (anyDimension && !allDimensions) {
      setErrors({ dimension: 'Enter length, width and height, or leave all three blank' });
      return;
    }

    const parsed = createVendorResponseSchema.safeParse(candidate);
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])),
      );
      return;
    }
    setErrors({});

    startTransition(async () => {
      const result = await addVendorResponseAction(enquiryId, responseFor.id, parsed.data);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Response recorded for line ${responseFor.lineNo}`);
      setResponseFor(null);
      resetResponse();
    });
  }

  function submitNoVendor() {
    if (!noVendorFor || noVendorReason.trim().length < 3) return;

    startTransition(async () => {
      const result = await markNoVendorAction(enquiryId, noVendorFor.id, noVendorReason.trim());
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Line ${noVendorFor.lineNo} marked as having no vendor`);
      setNoVendorFor(null);
      setNoVendorReason('');
    });
  }

  function createVendor() {
    if (newVendorName.trim().length < 2) return;

    startTransition(async () => {
      const result = await createVendorAction({ name: newVendorName.trim() });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setVendor({ id: result.data.vendor.id, label: result.data.vendor.name });
      setVendorDialogOpen(false);
      setNewVendorName('');
      toast.success('Vendor added');
    });
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {products.map((product) => (
          <Card key={product.id} className="overflow-hidden">
            <div className="flex flex-col gap-4 p-4 sm:flex-row">
              {product.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={product.image.secureUrl}
                  alt=""
                  className="size-20 shrink-0 rounded-md border border-line object-cover"
                />
              ) : (
                <span className="grid size-20 shrink-0 place-items-center rounded-md border border-dashed border-line-2 bg-surface-2 text-faint">
                  <ImageIcon className="size-5" />
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-muted tabular">
                      Line {String(product.lineNo).padStart(2, '0')}
                    </span>
                    <h3 className="mt-0.5 truncate text-[15px] font-medium text-ink">
                      {product.name}
                    </h3>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {product.similarOptionNeeded && (
                      <Badge variant="outline">Similar options welcome</Badge>
                    )}
                    <ProductStatusBadge status={product.status} />
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Quantity</dt>
                    <dd className="mt-0.5 text-sm text-ink tabular">{product.quantity}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Weight</dt>
                    <dd className="mt-0.5 text-sm text-ink tabular">
                      {formatWeight(product.weight)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-muted">Dimensions</dt>
                    <dd className="mt-0.5 text-sm text-ink tabular">
                      {formatDimension(product.dimension)}
                    </dd>
                  </div>
                </dl>

                {product.status === 'NO_VENDOR' && product.noVendorReason && (
                  <p className="mt-3 rounded-sm border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
                    No vendor — {product.noVendorReason}
                  </p>
                )}
              </div>
            </div>

            {(product.vendorResponses.length > 0 || canRespond) && (
              <div className="border-t border-line bg-surface-2/40 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Vendor responses ({product.vendorResponses.length})
                  </span>
                  {canRespond && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          resetResponse();
                          setResponseFor(product);
                        }}
                      >
                        <Plus className="size-4" />
                        Add vendor response
                      </Button>
                      {product.status === 'PENDING' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setNoVendorReason('');
                            setNoVendorFor(product);
                          }}
                        >
                          No vendor
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {product.vendorResponses.length === 0 ? (
                  <p className="flex items-center gap-2 py-2 text-sm text-muted">
                    <Store className="size-4 text-faint" />
                    No vendor has responded to this line yet.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {product.vendorResponses.map((response) => (
                      <VendorResponseCard key={response.id} response={response} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* ---------------- Add vendor response ---------------- */}
      <Dialog open={responseFor !== null} onOpenChange={(o) => !o && setResponseFor(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add vendor response</DialogTitle>
            <DialogDescription>
              {responseFor && `Line ${responseFor.lineNo} · ${responseFor.name}`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
            <ImageUploadField
              label="Vendor image"
              value={imageAssetId}
              onChange={setImageAssetId}
            />

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Vendor</Label>
                <EntityPicker
                  value={vendor}
                  onChange={setVendor}
                  endpoint="vendors"
                  placeholder="Search vendors"
                  emptyLabel="No vendor found"
                  onCreate={(q) => {
                    setNewVendorName(q);
                    setVendorDialogOpen(true);
                  }}
                />
                {errors.vendorId && <p className="text-xs text-critical">{errors.vendorId}</p>}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rate">Rate per unit (₹)</Label>
                  <Input
                    id="rate"
                    inputMode="decimal"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    placeholder="850.00"
                    className="tabular"
                  />
                  {errors.ratePerUnit && (
                    <p className="text-xs text-critical">{errors.ratePerUnit}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="delivery">Delivery within (days)</Label>
                  <Input
                    id="delivery"
                    inputMode="numeric"
                    value={deliveryDays}
                    onChange={(e) => setDeliveryDays(e.target.value)}
                    placeholder="7"
                    className="tabular"
                  />
                  {errors.deliveryWithinDays && (
                    <p className="text-xs text-critical">{errors.deliveryWithinDays}</p>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vendorWeight">Weight</Label>
                <div className="flex gap-2">
                  <Input
                    id="vendorWeight"
                    inputMode="decimal"
                    value={weightValue}
                    onChange={(e) => setWeightValue(e.target.value)}
                    placeholder="Optional"
                    className="tabular"
                  />
                  <Select
                    value={weightUnit}
                    onValueChange={(v) => setWeightUnit(v as typeof weightUnit)}
                  >
                    <SelectTrigger className="w-24" aria-label="Weight unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEIGHT_UNITS.map((u) => (
                        <SelectItem key={u} value={u}>
                          {u.toLowerCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/*
                §20 — three sides plus a unit, matching the enquiry create form
                so the two read the same way. Optional: all three or none.
              */}
              <div className="flex flex-col gap-1.5">
                <Label>Dimensions</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    inputMode="decimal"
                    value={dimLength}
                    onChange={(e) => setDimLength(e.target.value)}
                    placeholder="Length"
                    aria-label="Length"
                    className="w-24 tabular"
                  />
                  <Input
                    inputMode="decimal"
                    value={dimWidth}
                    onChange={(e) => setDimWidth(e.target.value)}
                    placeholder="Width"
                    aria-label="Width"
                    className="w-24 tabular"
                  />
                  <Input
                    inputMode="decimal"
                    value={dimHeight}
                    onChange={(e) => setDimHeight(e.target.value)}
                    placeholder="Height"
                    aria-label="Height"
                    className="w-24 tabular"
                  />
                  <Select
                    value={dimensionUnit}
                    onValueChange={(v) => setDimensionUnit(v as typeof dimensionUnit)}
                  >
                    <SelectTrigger className="w-24" aria-label="Dimension unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DIMENSION_UNITS.map((u) => (
                        <SelectItem key={u} value={u}>
                          {u.toLowerCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {errors.dimension ||
                errors['dimension.length'] ||
                errors['dimension.width'] ||
                errors['dimension.height'] ? (
                  <p className="text-xs text-critical">
                    {errors.dimension ??
                      errors['dimension.length'] ??
                      errors['dimension.width'] ??
                      errors['dimension.height']}
                  </p>
                ) : (
                  <p className="text-xs text-muted">Optional — fill all three or leave blank.</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="matchType">Product match</Label>
                <Select
                  value={matchType}
                  onValueChange={(v) => setMatchType(v as typeof matchType)}
                >
                  <SelectTrigger id="matchType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRODUCT_MATCH_TYPES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {label(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.matchType && (
                  <p className="text-xs text-critical">{errors.matchType}</p>
                )}
              </div>

              <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-ink-2">
                <Checkbox
                  checked={sameDay}
                  onCheckedChange={(checked) => setSameDay(checked === true)}
                />
                Same Day
              </label>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Anything the vendor mentioned"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setResponseFor(null)}>
              Cancel
            </Button>
            <Button onClick={submitResponse} disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save response
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- No vendor ---------------- */}
      <Dialog open={noVendorFor !== null} onOpenChange={(o) => !o && setNoVendorFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as having no vendor</DialogTitle>
            <DialogDescription>
              {noVendorFor && `Line ${noVendorFor.lineNo} · ${noVendorFor.name}`}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="noVendorReason">Reason</Label>
            <Textarea
              id="noVendorReason"
              value={noVendorReason}
              onChange={(e) => setNoVendorReason(e.target.value)}
              placeholder="Required quantity unavailable"
            />
            <p className="text-xs text-muted">
              A reason is required — the record is kept for review.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setNoVendorFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitNoVendor}
              disabled={pending || noVendorReason.trim().length < 3}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Inline vendor creation ---------------- */}
      <Dialog open={vendorDialogOpen} onOpenChange={setVendorDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add vendor</DialogTitle>
            <DialogDescription>
              Vendors are reused across enquiries, so add one only if they are genuinely new.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="newVendorName">Vendor name</Label>
            <Input
              id="newVendorName"
              value={newVendorName}
              onChange={(e) => setNewVendorName(e.target.value)}
              placeholder="ABC Handicrafts"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setVendorDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createVendor} disabled={pending || newVendorName.trim().length < 2}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Add vendor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
