'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { SHOPIFY_PRODUCT_STATUSES } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { createRsProductAction } from '@/app/(app)/rs-products/actions';

/**
 * Adding a CRM-only product.
 *
 * The form collects a product and its one variant together: a product with no
 * variant has nowhere to carry a price, and would render as a blank row beside
 * the Shopify ones.
 *
 * There is deliberately no "source" control. The backend fixes MANUAL, which is
 * what guarantees a Shopify sync can never claim this row.
 */
export function NewProductForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  function onSubmit(formData: FormData) {
    setError(null);

    const title = String(formData.get('title') ?? '').trim();
    const price = String(formData.get('price') ?? '').trim();

    if (!title) {
      setError({ message: 'Product name is required.' });
      return;
    }
    if (!price) {
      setError({ message: 'A price is required — the product needs one to be sellable.' });
      return;
    }

    const sku = String(formData.get('sku') ?? '').trim();
    const description = String(formData.get('description') ?? '').trim();
    const productType = String(formData.get('productType') ?? '').trim();
    const vendor = String(formData.get('vendor') ?? '').trim();
    const qty = Number(formData.get('inventoryQty') ?? 0);

    startTransition(async () => {
      const result = await createRsProductAction({
        title,
        price,
        status: (formData.get('status') as (typeof SHOPIFY_PRODUCT_STATUSES)[number]) ?? 'ACTIVE',
        inventoryQty: Number.isFinite(qty) && qty > 0 ? Math.trunc(qty) : 0,
        ...(sku ? { sku } : {}),
        ...(description ? { description } : {}),
        ...(productType ? { productType } : {}),
        ...(vendor ? { vendor } : {}),
      });

      if (!result.ok) {
        setError({ message: result.message, ...(result.code ? { code: result.code } : {}) });
        return;
      }

      router.push('/rs-products');
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-5">
      {error && <ErrorMessage message={error.message} code={error.code} />}

      <div className="flex flex-col gap-2">
        <Label htmlFor="title">Product name</Label>
        <Input id="title" name="title" maxLength={500} required placeholder="Brass Kadhai with Tin Coating" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="price">Selling price</Label>
          <Input id="price" name="price" inputMode="decimal" required placeholder="1399.00" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="sku">SKU (optional)</Label>
          {/* Not unique, and not identity: the live catalogue repeats 13 SKUs
              and leaves 2 blank. */}
          <Input id="sku" name="sku" maxLength={100} placeholder="RS0000" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="inventoryQty">Opening stock</Label>
          <Input id="inventoryQty" name="inventoryQty" type="number" min={0} defaultValue={0} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="productType">Type (optional)</Label>
          <Input id="productType" name="productType" maxLength={200} placeholder="Utensils" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            name="status"
            defaultValue="ACTIVE"
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {SHOPIFY_PRODUCT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.charAt(0) + status.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="vendor">Vendor (optional)</Label>
        <Input id="vendor" name="vendor" maxLength={200} placeholder="ROYAL STUFFS" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">Description (optional)</Label>
        <Textarea id="description" name="description" rows={4} maxLength={10_000} />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add Product'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push('/rs-products')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
