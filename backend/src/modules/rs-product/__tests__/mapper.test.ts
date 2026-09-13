/**
 * The Shopify → CRM mapping rules.
 *
 * Pure functions, so these need no database and no network. They exist because
 * the rules easiest to get quietly wrong are all here: what counts as absent,
 * how a unit converts, and which status becomes which.
 */

import { describe, expect, it } from 'vitest';
import { mapImage, mapProduct, mapProductStatus, mapVariant, mapWeightUnit } from '../rs-product.mapper.js';
import type {
  ShopifyProductNode,
  ShopifyVariantNode,
} from '../../../integrations/shopify/product-query.js';

const variantNode = (over: Partial<ShopifyVariantNode> = {}): ShopifyVariantNode => ({
  id: 'gid://shopify/ProductVariant/1',
  title: 'Default Title',
  sku: 'RS0001',
  price: '1399.00',
  position: 1,
  inventoryQuantity: 10,
  inventoryItem: {
    id: 'gid://shopify/InventoryItem/1',
    unitCost: null,
    measurement: { weight: { value: 0.6, unit: 'KILOGRAMS' } },
  },
  ...over,
});

const productNode = (over: Partial<ShopifyProductNode> = {}): ShopifyProductNode => ({
  id: 'gid://shopify/Product/1',
  title: 'Copper Bottle',
  descriptionHtml: '<p>Nice</p>',
  status: 'ACTIVE',
  vendor: 'ROYAL STUFFS',
  productType: 'Drinkware',
  updatedAt: '2026-09-01T10:00:00Z',
  variants: { edges: [] },
  images: { edges: [] },
  ...over,
});

describe('product status', () => {
  it('maps every status Shopify actually returns', () => {
    expect(mapProductStatus('ACTIVE')).toBe('ACTIVE');
    expect(mapProductStatus('ARCHIVED')).toBe('ARCHIVED');
    expect(mapProductStatus('DRAFT')).toBe('DRAFT');
  });

  it('keeps UNLISTED as itself, never folded into another status', () => {
    // The store holds 23 of these. UNLISTED means "reachable by link, hidden
    // from listings" — neither ACTIVE nor DRAFT, and collapsing it would throw
    // away a distinction the storefront makes.
    expect(mapProductStatus('UNLISTED')).toBe('UNLISTED');
    expect(mapProductStatus('UNLISTED')).not.toBe('ACTIVE');
    expect(mapProductStatus('UNLISTED')).not.toBe('DRAFT');
  });

  it('treats an unknown future status conservatively, as DRAFT', () => {
    expect(mapProductStatus('SOME_NEW_STATUS')).toBe('DRAFT');
    expect(mapProductStatus(null)).toBe('DRAFT');
  });
});

describe('weight', () => {
  it('maps the units Shopify uses', () => {
    expect(mapWeightUnit('KILOGRAMS')).toBe('KG');
    expect(mapWeightUnit('GRAMS')).toBe('G');
    expect(mapWeightUnit('POUNDS')).toBe('LB');
  });

  it('refuses a unit the CRM cannot express rather than rounding it', () => {
    expect(mapWeightUnit('OUNCES')).toBeNull();
    expect(mapWeightUnit(null)).toBeNull();
  });

  it('normalises to grams so mixed units sort together', () => {
    const kg = mapVariant(
      variantNode({
        inventoryItem: {
          id: 'i1',
          unitCost: null,
          measurement: { weight: { value: 0.6, unit: 'KILOGRAMS' } },
        },
      }),
    );
    expect(kg.weightUnit).toBe('KG');
    expect(Number(kg.weightInGrams)).toBe(600);

    const g = mapVariant(
      variantNode({
        inventoryItem: {
          id: 'i2',
          unitCost: null,
          measurement: { weight: { value: 260, unit: 'GRAMS' } },
        },
      }),
    );
    expect(Number(g.weightInGrams)).toBe(260);

    const lb = mapVariant(
      variantNode({
        inventoryItem: {
          id: 'i3',
          unitCost: null,
          measurement: { weight: { value: 1, unit: 'POUNDS' } },
        },
      }),
    );
    expect(Number(lb.weightInGrams)).toBeCloseTo(453.592, 2);
  });

  it('leaves weight null when Shopify records none', () => {
    const v = mapVariant(
      variantNode({ inventoryItem: { id: 'i', unitCost: null, measurement: { weight: null } } }),
    );
    expect(v.weightValue).toBeNull();
    expect(v.weightUnit).toBeNull();
    expect(v.weightInGrams).toBeNull();
  });
});

describe('cost price', () => {
  it('reads unitCost when Shopify provides it', () => {
    const v = mapVariant(
      variantNode({
        inventoryItem: {
          id: 'i',
          unitCost: { amount: '820.50' },
          measurement: { weight: null },
        },
      }),
    );
    expect(v.costPrice).toBe('820.50');
  });

  it('leaves cost null rather than inferring it from price', () => {
    // 0 of 569 live variants have a cost. Substituting price would invent a
    // margin of zero on the entire catalogue.
    const v = mapVariant(variantNode({ price: '1399.00' }));
    expect(v.costPrice).toBeNull();
    expect(v.price).toBe('1399.00');
  });
});

describe('SKU', () => {
  it('keeps a real SKU', () => {
    expect(mapVariant(variantNode({ sku: 'RS2331' })).sku).toBe('RS2331');
  });

  it('treats blank and missing as null, not as an empty value', () => {
    expect(mapVariant(variantNode({ sku: '' })).sku).toBeNull();
    expect(mapVariant(variantNode({ sku: '   ' })).sku).toBeNull();
    expect(mapVariant(variantNode({ sku: null })).sku).toBeNull();
  });

  it('does not treat SKU as identity — that is the Shopify variant id', () => {
    const a = mapVariant(variantNode({ id: 'gid://shopify/ProductVariant/1', sku: 'RS2525' }));
    const b = mapVariant(variantNode({ id: 'gid://shopify/ProductVariant/2', sku: 'RS2525' }));
    expect(a.shopifyVariantId).not.toBe(b.shopifyVariantId);
    expect(a.sku).toBe(b.sku);
  });
});

describe('dimensions stay unwritten', () => {
  it('maps no dimension field at all', () => {
    // The store's next_cart.length/width/height carry no unit anywhere, so a
    // number here would have no stateable meaning.
    const v = mapVariant(variantNode());
    expect(v).not.toHaveProperty('lengthValue');
    expect(v).not.toHaveProperty('widthValue');
    expect(v).not.toHaveProperty('heightValue');
    expect(v).not.toHaveProperty('dimensionUnit');
  });
});

describe('inventory', () => {
  it('carries the Shopify quantity onto the variant', () => {
    expect(mapVariant(variantNode({ inventoryQuantity: 994 })).inventoryQty).toBe(994);
  });

  it('defaults a missing quantity to zero', () => {
    expect(mapVariant(variantNode({ inventoryQuantity: null })).inventoryQty).toBe(0);
  });

  it('keeps the inventory item id, the only key the inventory webhook carries', () => {
    const v = mapVariant(variantNode());
    expect(v.shopifyInventoryItemId).toBe('gid://shopify/InventoryItem/1');
  });
});

describe('product', () => {
  it('maps the fields the catalogue shows', () => {
    const p = mapProduct(productNode());
    expect(p.shopifyProductId).toBe('gid://shopify/Product/1');
    expect(p.title).toBe('Copper Bottle');
    expect(p.vendor).toBe('ROYAL STUFFS');
    expect(p.productType).toBe('Drinkware');
    expect(p.shopifyUpdatedAt).toBeInstanceOf(Date);
  });

  it('blanks empty text rather than storing an empty string', () => {
    const p = mapProduct(productNode({ vendor: '', productType: '   ', descriptionHtml: '' }));
    expect(p.vendor).toBeNull();
    expect(p.productType).toBeNull();
    expect(p.description).toBeNull();
  });

  it('lets two products share a title — identity is the Shopify id', () => {
    const a = mapProduct(productNode({ id: 'gid://shopify/Product/1', title: 'Same Name' }));
    const b = mapProduct(productNode({ id: 'gid://shopify/Product/2', title: 'Same Name' }));
    expect(a.title).toBe(b.title);
    expect(a.shopifyProductId).not.toBe(b.shopifyProductId);
  });
});

describe('images', () => {
  it('numbers positions from one, in Shopify order', () => {
    const first = mapImage({ id: 'gid://shopify/ProductImage/1', url: 'https://a', altText: 'A' }, 0);
    const second = mapImage({ id: 'gid://shopify/ProductImage/2', url: 'https://b', altText: null }, 1);
    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
    expect(first.altText).toBe('A');
    expect(second.altText).toBeNull();
  });

  it('uses the Shopify image id as identity', () => {
    const img = mapImage({ id: 'gid://shopify/ProductImage/99', url: 'https://x', altText: '' }, 0);
    expect(img.shopifyImageId).toBe('gid://shopify/ProductImage/99');
    expect(img.altText).toBeNull();
  });
});
