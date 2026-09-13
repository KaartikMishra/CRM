/**
 * The one GraphQL query the catalogue sync runs, and the shape it returns.
 *
 * Kept apart from the sync service so the query text and its types sit
 * together: a field added here has to be added to the type beside it, which is
 * what stops the two drifting.
 *
 * Deliberately fetches `images` rather than `media`. The store's media
 * connection also carries video and 3D items — 154 of them — which are not
 * product images and have no place in RsProductImage.
 *
 * Dimensions are deliberately absent. They live in `next_cart.length/width/
 * height` metafields whose unit is recorded nowhere in the store, so fetching
 * them would only invite writing a number whose meaning nobody can state.
 */

/** Shopify's weight units, as the Admin API spells them. */
export type ShopifyWeightUnit = 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES';

export type ShopifyVariantNode = {
  id: string;
  title: string | null;
  sku: string | null;
  price: string | null;
  position: number | null;
  inventoryQuantity: number | null;
  inventoryItem: {
    id: string;
    unitCost: { amount: string | null } | null;
    measurement: { weight: { value: number; unit: ShopifyWeightUnit } | null } | null;
  } | null;
};

export type ShopifyImageNode = {
  id: string;
  url: string;
  altText: string | null;
};

export type ShopifyProductNode = {
  id: string;
  title: string;
  descriptionHtml: string | null;
  status: string;
  vendor: string | null;
  productType: string | null;
  updatedAt: string | null;
  variants: { edges: { node: ShopifyVariantNode }[] };
  images: { edges: { node: ShopifyImageNode }[] };
};

export type ProductPage = {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: ShopifyProductNode }[];
  };
};

/**
 * One page of products with everything the sync writes.
 *
 * `variants(first: 100)` and `images(first: 100)` cover this catalogue's real
 * maximums (5 variants, ~10 images) with room to spare. A product exceeding
 * either would be silently truncated, so the sync checks and reports it rather
 * than trusting the limit.
 */
export const PRODUCT_PAGE_QUERY = `query CataloguePage($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        descriptionHtml
        status
        vendor
        productType
        updatedAt
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
              price
              position
              inventoryQuantity
              inventoryItem {
                id
                unitCost { amount }
                measurement { weight { value unit } }
              }
            }
          }
        }
        images(first: 100) {
          edges { node { id url altText } }
        }
      }
    }
  }
}`;
