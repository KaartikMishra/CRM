import type {
  DimensionUnit,
  ProductSource,
  ShopifyProductStatus,
  WeightUnit,
} from '../enums.js';

/**
 * What the RS Products API returns.
 *
 * Money and measurements are decimal strings end to end, matching the rest of
 * the CRM: no float touches a price or a weight. Dates are ISO strings.
 *
 * Phase 2 defines the read shapes only. There are no input schemas yet because
 * there is no write endpoint — products arrive from Shopify in a later phase,
 * and the manual-entry form comes after that.
 */

export type RsProductImageView = {
  id: string;
  /** The image's own address. A Shopify CDN URL for synced products. */
  url: string;
  altText: string | null;
  position: number;
};

export type ShopifyVariantView = {
  id: string;
  /** Null on a CRM-only variant, and not unique across Shopify anyway. */
  sku: string | null;
  title: string | null;
  price: string;
  costPrice: string | null;
  /**
   * Stock as the CRM counts it, maintained by hand and never written by a
   * Shopify sync or webhook — unlike `inventoryQty` below, which is Shopify's.
   */
  crmStockQty: number;

  weightValue: string | null;
  weightUnit: WeightUnit | null;

  lengthValue: string | null;
  widthValue: string | null;
  heightValue: string | null;
  dimensionUnit: DimensionUnit | null;

  /**
   * Shopify's sellable quantity — deliberately not Procurement's onHand, which
   * counts what is physically in the warehouse. The two numbers answer
   * different questions and are never summed.
   */
  inventoryQty: number;
  position: number;
};

export type RsProductView = {
  id: string;
  source: ProductSource;
  /** Null for CRM-only products. Identity for synced ones — never the title. */
  shopifyProductId: string | null;
  title: string;
  description: string | null;
  status: ShopifyProductStatus;
  productType: string | null;
  vendor: string | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A product with everything needed to render one row of the catalogue. */
export type RsProductDetail = RsProductView & {
  variants: ShopifyVariantView[];
  images: RsProductImageView[];
  /**
   * Which fields this product's source allows the CRM to change.
   *
   * Computed server-side rather than inferred in the browser, so the form and
   * the API cannot disagree about what is editable — and so a disabled input is
   * a reflection of the rule rather than the rule itself.
   */
  editable: {
    /** False for a Shopify product: the next sync would revert these. */
    productFields: boolean;
    shopifyOwnedVariantFields: boolean;
  };
};

/**
 * One row of the catalogue table.
 *
 * A product, not a variant: 465 of the 501 synced products have exactly one
 * variant, so a variant-per-row table would render 569 rows to show 501
 * products and repeat the title five times for a five-variant product.
 *
 * The variant facts are therefore aggregated here — a price range rather than
 * a price, summed inventory, a representative SKU — with `variantCount` telling
 * the UI when to say so.
 */
export type RsProductListRow = {
  id: string;
  title: string;
  source: ProductSource;
  status: ShopifyProductStatus;
  productType: string | null;
  vendor: string | null;

  /** Shopify's first image, or null for a manual product with none. */
  imageUrl: string | null;
  imageAlt: string | null;

  /** The first variant's SKU; null when it has none. Never unique. */
  sku: string | null;
  variantCount: number;

  /** Equal when every variant costs the same, which is the usual case. */
  priceMin: string | null;
  priceMax: string | null;

  /**
   * Summed across variants. Shopify's sellable quantity, never Procurement's
   * warehouse count — and never clamped: one live variant is legitimately
   * negative, and hiding that would hide a real oversell.
   */
  inventoryQty: number;

  /**
   * Summed CRM stock — the hand-maintained figure, kept apart from Shopify's.
   * Starts at zero for every synced variant and changes only when someone
   * edits it.
   */
  crmStockQty: number;

  /** The first variant's weight, as Shopify recorded it. */
  weightValue: string | null;
  weightUnit: WeightUnit | null;

  /**
   * Null throughout. The store's dimension metafields carry no unit anywhere,
   * so a number here would have no stateable meaning. The column renders an
   * em-dash until that is resolved, and volume with it.
   */
  lengthValue: string | null;
  widthValue: string | null;
  heightValue: string | null;
  dimensionUnit: DimensionUnit | null;

  createdAt: string;
};

/**
 * What the CRM will say about its Shopify connection.
 *
 * Every field here is safe to render. The access token and the client secret
 * are backend-only and are deliberately absent from this contract, so there is
 * no shape in which the frontend could receive one.
 */
export type ShopifyConnectionView = {
  connected: boolean;
  storeDomain: string | null;
  apiVersion: string;
  /** Granted scopes, e.g. "read_products,read_inventory". */
  scope: string | null;
  shopName: string | null;
  /** Stable code when not connected: NOT_CONFIGURED, SHOPIFY_AUTH_FAILED, … */
  reason: string | null;
};
