import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { EditProductForm } from '@/components/rs-products/edit-product-form';
import { fetchRsProduct } from '@/lib/rs-product-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'Edit Product' };

/**
 * Editing one product.
 *
 * Gated on EDIT rather than VIEW: reading the catalogue and changing it are
 * different privileges. The API enforces the same rule again on its own
 * authority — this only decides what is worth rendering.
 */
export default async function EditRsProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const access = await requireModule('RS_PRODUCTS');
  if (!access.allowed) return <NoModuleAccess module="RS_PRODUCTS" />;
  if (!can(access.user, 'RS_PRODUCTS', 'EDIT')) return <NoModuleAccess module="RS_PRODUCTS" />;

  const result = await fetchRsProduct(id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Catalogue"
        title={result.success ? result.data.product.title : 'Edit Product'}
        description="Changes are saved in the CRM only. Nothing here is written back to Shopify."
      />

      {!result.success ? (
        <ErrorMessage message={result.message} code={result.code} />
      ) : (
        <Card className="max-w-4xl">
          <CardContent className="pt-6">
            <EditProductForm product={result.data.product} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
