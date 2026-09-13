'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import {
  DIMENSION_UNITS,
  SHOPIFY_PRODUCT_STATUSES,
  WEIGHT_UNITS,
  type RsProductDetail,
  type UpdateRsProductInput,
  type UpdateVariantInput,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { updateRsProductAction } from '@/app/(app)/rs-products/actions';

/**
 * Editing a product, CRM-side.
 *
 * The form's central idea is that a field's owner decides whether it can be
 * changed. On a Shopify-synced product the title, price, weight, status and SKU
 * belong to Shopify: the next sync rewrites them from the payload, so offering
 * them as editable would be offering an edit that quietly disappears. Those are
 * shown, locked, with the reason stated — not hidden, because seeing the value
 * still matters.
 *
 * Cost price, CRM stock and dimensions are CRM-owned on every product. Shopify
 * populates cost on none of the 569 synced variants, and its dimension
 * metafields carry no unit, so nothing upstream competes for them.
 */
export function EditProductForm({ product }: { product: RsProductDetail }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const crmOwned = product.editable.productFields;
  const isShopify = product.source === 'SHOPIFY';

  function onSubmit(formData: FormData) {
    setError(null);
    setSaved(false);

    const text = (key: string): string => String(formData.get(key) ?? '').trim();
    const optionalNumber = (key: string): number | null | undefined => {
      const raw = text(key);
      if (raw === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };

    const input: UpdateRsProductInput = {};

    // Product-level fields, only where the CRM owns them.
    if (crmOwned) {
      input.title = text('title');
      input.status = text('status') as (typeof SHOPIFY_PRODUCT_STATUSES)[number];
      input.productType = text('productType') || null;
      input.vendor = text('vendor') || null;
    }
    input.description = text('description') || null;

    const variants: UpdateVariantInput[] = product.variants.map((variant) => {
      const key = (field: string): string => `${field}__${variant.id}`;

      const edit: UpdateVariantInput = {
        id: variant.id,
        // CRM-owned on every product.
        costPrice: text(key('costPrice')) === '' ? null : text(key('costPrice')),
        crmStockQty: Number(text(key('crmStockQty')) || '0'),
        lengthValue: optionalNumber(key('lengthValue')),
        widthValue: optionalNumber(key('widthValue')),
        heightValue: optionalNumber(key('heightValue')),
        dimensionUnit:
          (text(key('dimensionUnit')) as (typeof DIMENSION_UNITS)[number]) || null,
      };

      // Shopify-owned fields are sent only when the CRM owns them; sending them
      // for a synced product would be refused by the API anyway.
      if (crmOwned) {
        edit.sku = text(key('sku')) || null;
        edit.price = text(key('price'));
        edit.weightValue = optionalNumber(key('weightValue'));
        edit.weightUnit = (text(key('weightUnit')) as (typeof WEIGHT_UNITS)[number]) || null;
      }

      return edit;
    });

    input.variants = variants;

    startTransition(async () => {
      const result = await updateRsProductAction(product.id, input);
      if (!result.ok) {
        setError({ message: result.message, ...(result.code ? { code: result.code } : {}) });
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-8">
      {error && <ErrorMessage message={error.message} code={error.code} />}
      {saved && (
        <p className="rounded-md border border-positive/30 bg-positive-soft px-3 py-2 text-sm text-positive">
          Saved.
        </p>
      )}

      {isShopify && (
        <p className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-muted">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <span>
            This product is synced from Shopify. Fields Shopify maintains are shown read-only,
            because the next sync would overwrite anything changed here. Cost price, CRM stock and
            dimensions are the CRM&rsquo;s own and can be edited.
          </span>
        </p>
      )}

      <Section title="Product information">
        <Field label="Title" locked={!crmOwned}>
          <Input name="title" defaultValue={product.title} maxLength={500} disabled={!crmOwned} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Product type" locked={!crmOwned}>
            <Input
              name="productType"
              defaultValue={product.productType ?? ''}
              maxLength={200}
              disabled={!crmOwned}
            />
          </Field>
          <Field label="Vendor" locked={!crmOwned}>
            <Input
              name="vendor"
              defaultValue={product.vendor ?? ''}
              maxLength={200}
              disabled={!crmOwned}
            />
          </Field>
        </div>

        <Field label="Description">
          <Textarea name="description" defaultValue={product.description ?? ''} rows={3} />
        </Field>
      </Section>

      {product.variants.map((variant, index) => (
        <Section
          key={variant.id}
          title={
            product.variants.length > 1
              ? `Variant ${index + 1}${variant.title ? ` — ${variant.title}` : ''}`
              : 'Pricing, stock and physical details'
          }
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="SKU" locked={!crmOwned}>
              <Input
                name={`sku__${variant.id}`}
                defaultValue={variant.sku ?? ''}
                maxLength={100}
                disabled={!crmOwned}
              />
            </Field>
            <Field label="Selling price" locked={!crmOwned}>
              <Input
                name={`price__${variant.id}`}
                defaultValue={variant.price}
                inputMode="decimal"
                disabled={!crmOwned}
              />
            </Field>
            {/* CRM-owned everywhere: Shopify records a cost on none of the
                synced variants, so nothing upstream competes for this. */}
            <Field label="Cost price">
              <Input
                name={`costPrice__${variant.id}`}
                defaultValue={variant.costPrice ?? ''}
                inputMode="decimal"
                placeholder="Not recorded"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="CRM stock" hint="Maintained here. Shopify never changes it.">
              <Input
                name={`crmStockQty__${variant.id}`}
                type="number"
                min={0}
                step={1}
                defaultValue={variant.crmStockQty}
              />
            </Field>
            <Field label="Shopify inventory" locked hint="Shopify's own figure.">
              <Input value={variant.inventoryQty} disabled readOnly />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Weight" locked={!crmOwned}>
              <Input
                name={`weightValue__${variant.id}`}
                defaultValue={variant.weightValue ?? ''}
                inputMode="decimal"
                disabled={!crmOwned}
              />
            </Field>
            <Field label="Weight unit" locked={!crmOwned}>
              <Select
                name={`weightUnit__${variant.id}`}
                defaultValue={variant.weightUnit ?? ''}
                options={WEIGHT_UNITS}
                disabled={!crmOwned}
              />
            </Field>
          </div>

          {/* Dimensions are CRM-owned on every product: Shopify's metafields
              record three numbers with no unit, so they were never imported. */}
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Length">
              <Input
                name={`lengthValue__${variant.id}`}
                defaultValue={variant.lengthValue ?? ''}
                inputMode="decimal"
              />
            </Field>
            <Field label="Width">
              <Input
                name={`widthValue__${variant.id}`}
                defaultValue={variant.widthValue ?? ''}
                inputMode="decimal"
              />
            </Field>
            <Field label="Height">
              <Input
                name={`heightValue__${variant.id}`}
                defaultValue={variant.heightValue ?? ''}
                inputMode="decimal"
              />
            </Field>
            <Field label="Unit">
              <Select
                name={`dimensionUnit__${variant.id}`}
                defaultValue={variant.dimensionUnit ?? ''}
                options={DIMENSION_UNITS}
              />
            </Field>
          </div>
        </Section>
      ))}

      <Section title="Status and source">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status" locked={!crmOwned}>
            <Select
              name="status"
              defaultValue={product.status}
              options={SHOPIFY_PRODUCT_STATUSES}
              disabled={!crmOwned}
              allowEmpty={false}
            />
          </Field>
          <Field label="Source" locked>
            <Input value={product.source === 'SHOPIFY' ? 'Shopify' : 'Manual'} disabled readOnly />
          </Field>
        </div>

        {product.shopifyProductId && (
          <Field label="Shopify product ID" locked>
            <Input value={product.shopifyProductId} disabled readOnly className="font-mono text-xs" />
          </Field>
        )}
      </Section>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push('/rs-products')}>
          Back to catalogue
        </Button>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
  locked,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  locked?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label className="flex items-center gap-1.5">
        {label}
        {locked && <Lock className="size-3 text-muted" aria-label="Read-only" />}
      </Label>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  );
}

function Select({
  name,
  defaultValue,
  options,
  disabled,
  allowEmpty = true,
}: {
  name: string;
  defaultValue: string;
  options: readonly string[];
  disabled?: boolean;
  allowEmpty?: boolean;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      disabled={disabled}
      className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-60"
    >
      {allowEmpty && <option value="">—</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {option.charAt(0) + option.slice(1).toLowerCase()}
        </option>
      ))}
    </select>
  );
}
