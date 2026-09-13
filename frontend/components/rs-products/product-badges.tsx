import type { ProductSource, ShopifyProductStatus } from '@rs/shared';
import { Badge } from '@/components/ui/badge';

/**
 * Status and source answer different questions, so they never share a colour.
 *
 * Status is about whether the storefront is selling the product; source is
 * about who owns its fields. A reader needs to tell them apart at a glance.
 */

const STATUS_LABEL: Record<ShopifyProductStatus, string> = {
  ACTIVE: 'Active',
  ARCHIVED: 'Archived',
  DRAFT: 'Draft',
  UNLISTED: 'Unlisted',
};

export function ProductStatusBadge({ status }: { status: ShopifyProductStatus }) {
  // UNLISTED gets its own tone rather than borrowing Active's or Draft's: it
  // means "reachable by link, hidden from listings", which is neither.
  const variant =
    status === 'ACTIVE'
      ? 'positive'
      : status === 'UNLISTED'
        ? 'warning'
        : status === 'DRAFT'
          ? 'outline'
          : 'neutral';

  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

export function ProductSourceBadge({ source }: { source: ProductSource }) {
  return (
    <Badge variant={source === 'SHOPIFY' ? 'accent' : 'outline'}>
      {source === 'SHOPIFY' ? 'Shopify' : 'Manual'}
    </Badge>
  );
}
