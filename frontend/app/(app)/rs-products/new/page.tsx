import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { NewProductForm } from '@/components/rs-products/new-product-form';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'Add Product' };

/**
 * Adding a CRM-only product.
 *
 * Gated on CREATE rather than VIEW: reading the catalogue and adding to it are
 * different privileges. The API enforces the same rule again on its own
 * authority — this only decides what is worth rendering.
 */
export default async function NewRsProductPage() {
  const access = await requireModule('RS_PRODUCTS');
  if (!access.allowed) return <NoModuleAccess module="RS_PRODUCTS" />;
  if (!can(access.user, 'RS_PRODUCTS', 'CREATE')) return <NoModuleAccess module="RS_PRODUCTS" />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Catalogue"
        title="Add Product"
        description="A CRM-only product. It is never touched by a Shopify sync."
      />

      <Card className="max-w-3xl">
        <CardContent className="pt-6">
          <NewProductForm />
        </CardContent>
      </Card>
    </div>
  );
}
