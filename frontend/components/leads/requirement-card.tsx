'use client';

import { useState, useTransition } from 'react';
import Image from 'next/image';
import { ImageOff, Loader2, Trash2 } from 'lucide-react';
import {
  DIMENSION_UNITS,
  WEIGHT_UNITS,
  formatVolume,
  type LeadRequirementView,
  type ProductMatchKind,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ImageUploadField } from '@/components/product-enquiry/image-upload-field';
import { RsProductPicker } from '@/components/products/rs-product-picker';
import { formatCurrency } from '@/lib/format';
import {
  createPayload,
  draftErrors,
  draftOf,
  emptyDraft,
  hasChanges,
  isValid,
  previewVolume,
  updatePayload,
  type RequirementDraft,
} from './requirement-logic';
import {
  createRequirementAction,
  deleteRequirementAction,
  updateRequirementAction,
} from '@/app/(app)/leads/actions';

/**
 * One requirement line — what the customer actually asked for.
 *
 * The same card both adds and edits: `requirement` absent means this is the new
 * line, present means it is an existing one. One component rather than two, so
 * the validation, the volume preview and the match rule cannot diverge between
 * creating and correcting.
 *
 * Nothing here decides a business outcome. Volume comes from the shared
 * calculation, and every rule the form enforces is enforced again by the API —
 * which is the authority. A field the form lets through still comes back 422 and
 * the message is shown as the backend phrased it.
 */
export function RequirementCard({
  leadId,
  requirement,
  canEdit,
  onDone,
  onCancel,
}: {
  leadId: string;
  /** Absent for the new-requirement form. */
  requirement?: LeadRequirementView;
  canEdit: boolean;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<RequirementDraft>(
    requirement ? draftOf(requirement) : emptyDraft(),
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startSaving] = useTransition();
  const [deleting, startDeleting] = useTransition();

  const set = <K extends keyof RequirementDraft>(key: K, value: RequirementDraft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };

  const preview = previewVolume(draft);
  const busy = saving || deleting;
  const errors = { ...draftErrors(draft), ...fieldErrors };

  /** The only Save path. Refuses what it already knows the API will refuse. */
  function save(): void {
    const found = draftErrors(draft);
    if (Object.keys(found).length > 0) {
      setFieldErrors(found);
      setError('Fix the highlighted fields and try again.');
      return;
    }

    setFieldErrors({});
    setError(null);

    startSaving(async () => {
      const result = requirement
        ? await updateRequirementAction(leadId, requirement.id, updatePayload(requirement, draft))
        : await createRequirementAction(leadId, createPayload(draft));

      if (!result.ok) {
        setError(result.message);
        // The API reports which field it refused; show it where it belongs.
        if (result.details) {
          setFieldErrors(
            Object.fromEntries(result.details.map((d) => [d.path.split('.').pop() ?? d.path, d.message])),
          );
        }
        return;
      }

      if (!requirement) setDraft(emptyDraft());
      onDone?.();
    });
  }

  function remove(): void {
    if (!requirement) return;
    startDeleting(async () => {
      const result = await deleteRequirementAction(leadId, requirement.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone?.();
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-line-2 bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">
          {requirement ? `Requirement ${requirement.lineNo}` : 'New requirement'}
        </h3>

        {requirement && canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={remove}
            disabled={busy}
            aria-label={`Delete requirement ${requirement.lineNo}`}
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Delete
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[160px_1fr]">
        {/*
          The customer's own photo of the requirement. Reuses the enquiry
          module's upload field, which already handles upload, preview, replace,
          remove and retry against the one Cloudinary path — there is no second
          upload system here.
        */}
        <ImageUploadField
          label="Requirement photo"
          value={draft.imageId}
          onChange={(assetId) => set('imageId', assetId)}
        />

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`name-${requirement?.id ?? 'new'}`}>Product name</Label>
            <Input
              id={`name-${requirement?.id ?? 'new'}`}
              value={draft.productName}
              onChange={(e) => set('productName', e.target.value)}
              placeholder="What the customer asked for, in their words"
              disabled={!canEdit || busy}
              aria-invalid={Boolean(errors.productName)}
            />
            {errors.productName && (
              <p className="text-xs text-critical">{errors.productName}</p>
            )}
          </div>

          {/* The catalogue match, through the picker Sales and Procurement share. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`product-${requirement?.id ?? 'new'}`}>RS Product</Label>
            <RsProductPicker
              id={`product-${requirement?.id ?? 'new'}`}
              value={draft.product}
              disabled={!canEdit || busy}
              onChange={(product) =>
                setDraft((d) => ({
                  ...d,
                  product,
                  // Clearing the product clears its kind: a match kind with
                  // nothing to describe is the one shape the table forbids.
                  matchKind: product === null ? null : d.matchKind,
                }))
              }
            />
            {errors.product && <p className="text-xs text-critical">{errors.product}</p>}
          </div>

          {/* Exact vs Similar — meaningful only once a product is chosen. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-2">Match</span>
            <div className="flex flex-wrap gap-2">
              {(['EXACT', 'SIMILAR'] as ProductMatchKind[]).map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={draft.matchKind === kind ? 'default' : 'outline'}
                  aria-pressed={draft.matchKind === kind}
                  disabled={!canEdit || busy || draft.product === null}
                  onClick={() => set('matchKind', draft.matchKind === kind ? null : kind)}
                >
                  {kind === 'EXACT' ? 'Exact Product' : 'Similar Product'}
                </Button>
              ))}
            </div>
            {draft.product === null && (
              <p className="text-xs text-muted">
                Choose a catalogue product to say whether it is the exact item or a similar one.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`qty-${requirement?.id ?? 'new'}`}>Quantity</Label>
          <Input
            id={`qty-${requirement?.id ?? 'new'}`}
            type="number"
            min={1}
            step={1}
            value={draft.quantity}
            onChange={(e) => set('quantity', e.target.value)}
            disabled={!canEdit || busy}
            aria-invalid={Boolean(errors.quantity)}
          />
          {errors.quantity && <p className="text-xs text-critical">{errors.quantity}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`weight-${requirement?.id ?? 'new'}`}>Weight</Label>
          <div className="flex gap-2">
            <Input
              id={`weight-${requirement?.id ?? 'new'}`}
              type="number"
              min={0}
              step="any"
              value={draft.weightValue}
              onChange={(e) => set('weightValue', e.target.value)}
              disabled={!canEdit || busy}
              aria-invalid={Boolean(errors.weightValue)}
            />
            <Select
              value={draft.weightUnit}
              onValueChange={(v) => set('weightUnit', v as RequirementDraft['weightUnit'])}
              disabled={!canEdit || busy}
            >
              <SelectTrigger className="w-24" aria-label="Weight unit">
                <SelectValue placeholder="unit" />
              </SelectTrigger>
              <SelectContent>
                {WEIGHT_UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {unit.toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(errors.weightValue || errors.weightUnit) && (
            <p className="text-xs text-critical">{errors.weightValue ?? errors.weightUnit}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium text-ink-2">Dimensions</span>
          <div className="flex gap-2">
            {(
              [
                ['lengthValue', 'L'],
                ['widthValue', 'W'],
                ['heightValue', 'H'],
              ] as const
            ).map(([field, label]) => (
              <Input
                key={field}
                type="number"
                min={0}
                step="any"
                value={draft[field]}
                onChange={(e) => set(field, e.target.value)}
                placeholder={label}
                aria-label={`${label} dimension`}
                disabled={!canEdit || busy}
                aria-invalid={Boolean(errors[field])}
              />
            ))}
            <Select
              value={draft.dimensionUnit}
              onValueChange={(v) => set('dimensionUnit', v as RequirementDraft['dimensionUnit'])}
              disabled={!canEdit || busy}
            >
              <SelectTrigger className="w-24" aria-label="Dimension unit">
                <SelectValue placeholder="unit" />
              </SelectTrigger>
              <SelectContent>
                {DIMENSION_UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {unit.toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(errors.lengthValue || errors.widthValue || errors.heightValue || errors.dimensionUnit) && (
            <p className="text-xs text-critical">
              {errors.lengthValue ??
                errors.widthValue ??
                errors.heightValue ??
                errors.dimensionUnit}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/*
          Volume, derived. Computed by the shared `volume()` — the same function
          the API derives its own figure with — so this preview and the saved
          value cannot disagree. Nothing stores it.
        */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-2">Volume</span>
          {preview ? (
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-ink">{formatVolume(preview)}</span>
              <Badge variant="neutral">derived</Badge>
            </div>
          ) : (
            <p className="text-sm text-muted">
              Enter length, width, height and a unit to see the volume.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`value-${requirement?.id ?? 'new'}`}>Product value</Label>
          <Input
            id={`value-${requirement?.id ?? 'new'}`}
            type="number"
            min={0}
            step="any"
            value={draft.productValue}
            onChange={(e) => set('productValue', e.target.value)}
            placeholder="What this requirement is worth"
            disabled={!canEdit || busy}
            aria-invalid={Boolean(errors.productValue)}
          />
          {errors.productValue ? (
            <p className="text-xs text-critical">{errors.productValue}</p>
          ) : (
            <p className="text-xs text-muted">
              The customer&apos;s requirement value, not the catalogue price.
            </p>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={
              busy || !isValid(draft) || (requirement ? !hasChanges(requirement, draft) : false)
            }
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {requirement ? 'Save changes' : 'Add requirement'}
          </Button>

          {onCancel && (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A matched product, shown read-only beside the requirement it describes. */
export function MatchedProduct({ requirement }: { requirement: LeadRequirementView }) {
  const product = requirement.rsProduct;
  if (!product) return null;

  return (
    <div className="flex items-center gap-3 rounded-md border border-line-2 bg-surface-2 p-2">
      {/*
        The catalogue's own image, which is a different picture from the
        requirement photo above and must never overwrite it.
      */}
      <div className="relative size-10 shrink-0 overflow-hidden rounded-sm bg-surface-3">
        {product.imageUrl ? (
          <Image src={product.imageUrl} alt="" fill sizes="40px" unoptimized className="object-cover" />
        ) : (
          <ImageOff className="absolute inset-0 m-auto size-4 text-faint" aria-hidden />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">{product.title}</p>
        {product.sku && <p className="truncate text-xs text-muted">SKU {product.sku}</p>}
      </div>

      {requirement.matchKind && (
        <Badge variant={requirement.matchKind === 'EXACT' ? 'positive' : 'neutral'}>
          {requirement.matchKind === 'EXACT' ? 'Exact' : 'Similar'}
        </Badge>
      )}

      {requirement.productValue != null && (
        <span className="shrink-0 text-sm text-ink">
          {formatCurrency(requirement.productValue)}
        </span>
      )}
    </div>
  );
}
