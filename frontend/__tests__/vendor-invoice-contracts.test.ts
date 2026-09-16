/**
 * Vendor Invoices — the shared contracts.
 *
 * Pure validation, no database and no network. These exist because the module's
 * central rule is a boundary between two kinds of rate, and the schemas are
 * where that boundary is first enforced: a mapping carries a *current* price,
 * and nothing in this module accepts a historical one.
 */

import { describe, expect, it } from 'vitest';
import {
  createMappingSchema,
  createVendorSchema,
  mappingListQuerySchema,
  updateMappingSchema,
  updateVendorSchema,
  vendorListQuerySchema,
  vendorTradeQuerySchema,
} from '@rs/shared';

const CUID = 'clx0000000000000000000000';

describe('vendor fields', () => {
  it('requires only a name', () => {
    const parsed = createVendorSchema.safeParse({ name: 'Devansh' });
    expect(parsed.success).toBe(true);
  });

  it('accepts the new company, address and second number', () => {
    const parsed = createVendorSchema.safeParse({
      name: 'Devansh',
      companyName: 'Devansh Brass Works',
      address: '14 Station Road, Moradabad',
      altPhone: '+91 98765 43210',
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts the fields Product Enquiry and Procurement already send', () => {
    // Both modules post to this same schema; narrowing it would break them.
    const parsed = createVendorSchema.safeParse({
      name: 'Existing Vendor',
      contactPerson: 'Rakesh',
      phone: '9876543210',
      email: 'RAKESH@Example.com',
      city: 'Moradabad',
    });
    expect(parsed.success).toBe(true);
    // Email is lower-cased, as it was before.
    expect(parsed.success && parsed.data.email).toBe('rakesh@example.com');
  });

  it('rejects a missing or too-short name', () => {
    expect(createVendorSchema.safeParse({}).success).toBe(false);
    expect(createVendorSchema.safeParse({ name: 'D' }).success).toBe(false);
  });

  it('rejects a malformed second number the same way as the first', () => {
    expect(createVendorSchema.safeParse({ name: 'X', altPhone: 'not a phone' }).success).toBe(false);
    expect(createVendorSchema.safeParse({ name: 'X', phone: 'not a phone' }).success).toBe(false);
  });

  it('lets an update change only what was sent', () => {
    const parsed = updateVendorSchema.safeParse({ companyName: 'New Name Ltd' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data)).toEqual(['companyName']);
  });
});

describe('mapping input', () => {
  it('accepts a vendor, a product and a current rate', () => {
    const parsed = createMappingSchema.safeParse({
      vendorId: CUID,
      rsProductId: CUID,
      currentRate: '1200.00',
    });
    expect(parsed.success).toBe(true);
  });

  it('takes rsProductId — the canonical catalogue — not a legacy productId', () => {
    const wrongKey = createMappingSchema.safeParse({
      vendorId: CUID,
      productId: CUID,
      currentRate: '1200.00',
    });
    expect(wrongKey.success).toBe(false);
  });

  it('rejects a malformed id rather than passing it to the database', () => {
    expect(
      createMappingSchema.safeParse({ vendorId: 'nope', rsProductId: CUID, currentRate: '1.00' })
        .success,
    ).toBe(false);
  });

  it('rejects a missing or malformed rate', () => {
    expect(createMappingSchema.safeParse({ vendorId: CUID, rsProductId: CUID }).success).toBe(false);
    expect(
      createMappingSchema.safeParse({ vendorId: CUID, rsProductId: CUID, currentRate: 'free' })
        .success,
    ).toBe(false);
  });

  it('normalises a numeric rate to a decimal string, so no float reaches money', () => {
    const parsed = createMappingSchema.safeParse({
      vendorId: CUID,
      rsProductId: CUID,
      currentRate: 1200,
    });
    expect(parsed.success).toBe(true);
    expect(typeof (parsed.success && parsed.data.currentRate)).toBe('string');
  });

  it('lets an update change the rate, the state, or both', () => {
    expect(updateMappingSchema.safeParse({ currentRate: '1350.00' }).success).toBe(true);
    expect(updateMappingSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateMappingSchema.safeParse({}).success).toBe(true);
  });

  it('offers no way to write a historical purchase rate', () => {
    // The boundary this module rests on: past purchases live on
    // PurchaseBillItem.rate and have no write path here.
    const parsed = updateMappingSchema.safeParse({ rate: '999.00', billId: CUID });
    expect(parsed.success && Object.keys(parsed.data)).toEqual([]);
  });
});

describe('list and history queries', () => {
  it('defaults the vendor list to 50 per page', () => {
    const parsed = vendorListQuerySchema.safeParse({});
    expect(parsed.success && parsed.data.limit).toBe(50);
  });

  it('coerces the isActive filter from its query-string form', () => {
    expect(vendorListQuerySchema.safeParse({ isActive: 'true' }).success).toBe(true);
    const parsed = vendorListQuerySchema.safeParse({ isActive: 'false' });
    expect(parsed.success && parsed.data.isActive).toBe(false);
  });

  it('accepts a date range on trade history', () => {
    const parsed = vendorTradeQuerySchema.safeParse({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.from).toBeInstanceOf(Date);
  });

  it('filters mappings by vendor and by product', () => {
    expect(mappingListQuerySchema.safeParse({ vendorId: CUID }).success).toBe(true);
    expect(mappingListQuerySchema.safeParse({ rsProductId: CUID }).success).toBe(true);
  });

  it('refuses a page size beyond the maximum', () => {
    expect(vendorListQuerySchema.safeParse({ limit: 9999 }).success).toBe(false);
    expect(mappingListQuerySchema.safeParse({ limit: 9999 }).success).toBe(false);
  });

  it('refuses a malformed cursor', () => {
    expect(vendorListQuerySchema.safeParse({ cursor: 'not-a-cuid' }).success).toBe(false);
  });
});
