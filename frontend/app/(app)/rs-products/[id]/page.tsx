import type { Metadata } from 'next';
import Link from 'next/link';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import {
  ContentPage,
  ContentPageHeader,
  ContentRegion,
  ContentScrollArea,
} from '@/components/common/content-page';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { ProductSourceBadge, ProductStatusBadge } from '@/components/rs-products/product-badges';
import { ProductStockValue, VariantTable } from '@/components/rs-products/variant-table';
import { EMPTY } from '@/components/rs-products/product-format';
import { fetchRsProduct } from '@/lib/rs-product-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Product' };

/**
 * One product, read-only, with every variant listed.
 *
 * The reason this page exists: the catalogue table shows one row per product
 * and folds its variants into a price range and a summed quantity. That is the
 * right shape for 501 rows, but it leaves the 36 multi-variant products unable
 * to state their individual SKUs, prices or stock anywhere in the application.
 * The data has been in the database since the first sync — 571 variants — and
 * the detail API has always returned it; only a place to read it was missing.
 *
 * Gated on VIEW, not EDIT: reading the catalogue is the lesser privilege, and
 * the edit form remains the only way to change anything. The API enforces the
 * same rule on its own authority; this only decides what is worth rendering.
 */
export default async function RsProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const access = await requireModule('RS_PRODUCTS');
  if (!access.allowed) return <NoModuleAccess module="RS_PRODUCTS" />;
  if (!can(access.user, 'RS_PRODUCTS', 'VIEW')) return <NoModuleAccess module="RS_PRODUCTS" />;

  const canEdit = can(access.user, 'RS_PRODUCTS', 'EDIT');
  const result = await fetchRsProduct(id);

  /*
    A failed fetch is rendered rather than thrown: a missing product answers 404
    from the API and `ErrorMessage` states that plainly, which is more useful
    than Next's generic not-found page. Archived and unlisted products are
    ordinary reads here — their status is shown, never a reason to hide them.
  */
  if (!result.success) {
    return (
      <ContentPage>
        <ContentPageHeader>
          <PageHeader eyebrow="Catalogue" title="Product" />
        </ContentPageHeader>
        <ContentRegion fill={false}>
          <ErrorMessage message={result.message} code={result.code} />
        </ContentRegion>
      </ContentPage>
    );
  }

  const product = result.data.product;

  return (
    <ContentPage>
      <ContentPageHeader>
        <PageHeader
          eyebrow="Catalogue"
          title={product.title}
          description="Read-only. Shopify-sourced fields are rewritten by the next sync; CRM stock and cost price are maintained in the CRM."
          actions={
            canEdit && (
              <Button asChild variant="outline">
                <Link href={`/rs-products/${product.id}/edit`}>
                  <Pencil className="size-4" />
                  Edit product
                </Link>
              </Button>
            )
          }
        />
      </ContentPageHeader>

      {/*
        One region holding one scroll area: the page is a stack of cards of
        their own height, not a pane that fills the viewport, so the cards are
        plain `Card`s and the scrolling is the region's rather than each card's.
      */}
      <ContentRegion>
        <ContentScrollArea>
          <div className="flex flex-col gap-6 pb-2">
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <ProductStatusBadge status={product.status} />
                <ProductSourceBadge source={product.source} />
              </div>

              <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Detail label="Product type" value={product.productType} />
                <Detail label="Vendor" value={product.vendor} />
                <Detail label="Variants" value={String(product.variants.length)} />
                {/* Shopify's identity for the product, shown for the same
                    reason the variant id is: it is what a reconciliation
                    against Shopify admin is done by. */}
                <Detail label="Shopify product ID" value={product.shopifyProductId} mono />
                {/* Null for a CRM-only product, which has never been synced. */}
                <Detail
                  label="Last synced"
                  value={
                    product.syncedAt ? new Date(product.syncedAt).toLocaleString('en-IN') : null
                  }
                />
                <Detail
                  label="Added"
                  value={new Date(product.createdAt).toLocaleDateString('en-IN')}
                />
              </dl>

              {product.description && (
                <div className="mt-4">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted">
                    Description
                  </dt>
                  {/* Shopify sends description HTML; rendered as text rather
                      than markup, so nothing from the store can inject into
                      this page. */}
                  <dd className="mt-1 whitespace-pre-line text-sm text-ink-2">
                    {product.description}
                  </dd>
                </div>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold text-ink">
                {product.variants.length > 1 ? 'Variants' : 'Pricing and stock'}
              </h2>
              <p className="mt-1 text-xs text-muted">
                Cost price and CRM stock are maintained here and are never written back to Shopify.
                Shopify&rsquo;s selling price and quantity are shown beside them and are rewritten by
                each sync.
              </p>

              {/* The product's own valuation, by the same shared rules the
                  dashboard total uses. */}
              <div className="mt-4 border-b border-line pb-4">
                <ProductStockValue variants={product.variants} />
              </div>

              <div className="mt-4">
                <VariantTable variants={product.variants} />
              </div>
            </Card>

            {product.images.length > 0 && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold text-ink">Images</h2>
                <p className="mt-1 text-xs text-muted">
                  Referenced from Shopify&rsquo;s CDN, never copied. The detail API returns the
                  storefront&rsquo;s primary image only.
                </p>
                <ul className="mt-4 flex flex-col gap-2">
                  {product.images.map((image) => (
                    <li key={image.id} className="break-all text-xs text-muted">
                      {image.altText ? `${image.altText} — ` : ''}
                      {image.url}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </ContentScrollArea>
      </ContentRegion>
    </ContentPage>
  );
}

/** One label-and-value pair, with the catalogue's placeholder for an absence. */
function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className={mono ? 'mt-1 break-all font-mono text-xs text-ink-2' : 'mt-1 text-sm text-ink'}>
        {value ?? EMPTY}
      </dd>
    </div>
  );
}
