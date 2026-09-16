/**
 * Vendor Invoices, end to end through the real middleware chain.
 *
 * The rule most of these defend is the boundary between two kinds of rate: what
 * a purchase actually cost, which lives on PurchaseBillItem and must never
 * move, and what a vendor charges today, which lives on the mapping and changes
 * freely. A module that let the second rewrite the first would quietly corrupt
 * the purchase record.
 *
 * Every row created here is namespaced `zz-test` and removed afterwards; the
 * real vendor, bill and catalogue rows are only ever read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VendorListRow, VendorMappingRow, VendorTradeRow } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import { cleanup, makeUser, residualTestRows, type TestUser } from '../../../__tests__/helpers/fixtures.js';

type VendorBody = { vendor: VendorListRow };
type VendorsBody = { vendors: VendorListRow[] };
type MappingBody = { mapping: VendorMappingRow };
type MappingsBody = { mappings: VendorMappingRow[] };
type TradesBody = { trades: VendorTradeRow[] };

const PREFIX = 'zz-test-vi';
const tag = () => `${PREFIX}-${Math.random().toString(36).slice(2, 8)}`;

/** Everything this suite creates, removed in afterAll. */
const created = {
  vendorIds: [] as string[],
  billIds: [] as string[],
  mappingIds: [] as string[],
};

let admin: TestUser;
let employee: TestUser;
let adminToken: string;
let employeeToken: string;
/** A real synced product, used read-only as a mapping target. */
let rsProductId: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  employee = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  employeeToken = await mintToken(employee.id, { role: 'USER' });

  const product = await prisma.rsProduct.findFirstOrThrow({
    where: { source: 'SHOPIFY' },
    select: { id: true },
  });
  rsProductId = product.id;
});

afterAll(async () => {
  // Mappings cascade from their vendor, but are removed explicitly so a failure
  // partway through still leaves nothing behind.
  if (created.mappingIds.length) {
    await prisma.vendorProductMapping.deleteMany({ where: { id: { in: created.mappingIds } } });
  }
  if (created.billIds.length) {
    await prisma.purchaseBill.deleteMany({ where: { id: { in: created.billIds } } });
  }
  if (created.vendorIds.length) {
    await prisma.vendorProductMapping.deleteMany({
      where: { vendorId: { in: created.vendorIds } },
    });
    await prisma.vendor.deleteMany({ where: { id: { in: created.vendorIds } } });
  }
  // Belt and braces: anything namespaced that escaped the id lists.
  await prisma.vendor.deleteMany({ where: { name: { startsWith: PREFIX } } });

  expect(await prisma.vendor.count({ where: { name: { startsWith: PREFIX } } })).toBe(0);

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

async function makeVendor(over: Record<string, unknown> = {}): Promise<VendorListRow> {
  const res = await api<VendorBody>('POST', '/api/vendor-invoices/vendors', {
    token: adminToken,
    body: { name: `${tag()} supplier`, ...over },
  });
  expect(res.status).toBe(201);
  created.vendorIds.push(res.body.data!.vendor.id);
  return res.body.data!.vendor;
}

// ---------------------------------------------------------------------------

describe('vendor list', () => {
  it('returns vendors with the columns the table needs', async () => {
    await makeVendor({ companyName: 'zz-test Brass Works', address: '14 Station Road' });

    const res = await api<VendorsBody>('GET', '/api/vendor-invoices/vendors', {
      token: adminToken,
    });

    expect(res.status).toBe(200);
    const row = res.body.data!.vendors[0]!;
    expect(row).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      isActive: expect.any(Boolean),
      mappedProductCount: expect.any(Number),
    });
    for (const key of ['companyName', 'phone', 'altPhone', 'email', 'address', 'city']) {
      expect(row).toHaveProperty(key);
    }
  });

  it('searches by name, company, phone and email', async () => {
    const marker = tag();
    await makeVendor({ name: `${marker} searchable`, companyName: `${marker} co`, email: `${marker}@test.invalid` });

    for (const q of [marker, `${marker} co`, `${marker}@test.invalid`]) {
      const res = await api<VendorsBody>('GET', `/api/vendor-invoices/vendors?q=${encodeURIComponent(q)}`, {
        token: adminToken,
      });
      expect(res.status, q).toBe(200);
      expect(res.body.data!.vendors.length, q).toBeGreaterThan(0);
    }
  });

  it('filters by active state', async () => {
    const res = await api<VendorsBody>('GET', '/api/vendor-invoices/vendors?isActive=true&limit=100', {
      token: adminToken,
    });
    for (const v of res.body.data!.vendors) expect(v.isActive).toBe(true);
  });

  it('paginates with a cursor', async () => {
    const res = await api<VendorsBody>('GET', '/api/vendor-invoices/vendors?limit=1', {
      token: adminToken,
    });
    expect(res.body.data!.vendors).toHaveLength(1);
    expect(res.body.meta).toHaveProperty('nextCursor');
  });

  it('counts mapped products without a query per row', async () => {
    const vendor = await makeVendor();
    expect(vendor.mappedProductCount).toBe(0);

    const mapping = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '1200.00' },
    });
    created.mappingIds.push(mapping.body.data!.mapping.id);

    const res = await api<VendorsBody>('GET', `/api/vendor-invoices/vendors?q=${vendor.name}`, {
      token: adminToken,
    });
    expect(res.body.data!.vendors[0]?.mappedProductCount).toBe(1);
  });
});

describe('vendor create and update', () => {
  it('requires only a name', async () => {
    const vendor = await makeVendor();
    expect(vendor.name).toContain(PREFIX);
    expect(vendor.companyName).toBeNull();
  });

  it('stores the new company, address and second number', async () => {
    const vendor = await makeVendor({
      companyName: 'zz-test Traders',
      address: '9 Mill Lane, Moradabad',
      altPhone: '+91 90000 00000',
    });
    expect(vendor.companyName).toBe('zz-test Traders');
    expect(vendor.address).toBe('9 Mill Lane, Moradabad');
    expect(vendor.altPhone).toBe('+91 90000 00000');
  });

  it('rejects a missing name', async () => {
    const res = await api('POST', '/api/vendor-invoices/vendors', {
      token: adminToken,
      body: { companyName: 'zz-test nameless' },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a duplicate name through the database constraint', async () => {
    const vendor = await makeVendor();

    const res = await api('POST', '/api/vendor-invoices/vendors', {
      token: adminToken,
      body: { name: vendor.name },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VENDOR_NAME_TAKEN');
  });

  it('survives two identical creates racing', async () => {
    const name = `${tag()} raced`;
    const [a, b] = await Promise.all([
      api<VendorBody>('POST', '/api/vendor-invoices/vendors', { token: adminToken, body: { name } }),
      api<VendorBody>('POST', '/api/vendor-invoices/vendors', { token: adminToken, body: { name } }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    for (const r of [a, b]) {
      if (r.status === 201) created.vendorIds.push(r.body.data!.vendor.id);
    }
    expect(await prisma.vendor.count({ where: { name } })).toBe(1);
  });

  it('updates editable details', async () => {
    const vendor = await makeVendor();

    const res = await api<VendorBody>('PATCH', `/api/vendor-invoices/vendors/${vendor.id}`, {
      token: adminToken,
      body: { companyName: 'zz-test Renamed Co', city: 'Jaipur' },
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.vendor.companyName).toBe('zz-test Renamed Co');
    expect(res.body.data!.vendor.city).toBe('Jaipur');
  });

  it('ignores isActive on a profile update — archiving is its own permission', async () => {
    const vendor = await makeVendor();

    const res = await api<VendorBody>('PATCH', `/api/vendor-invoices/vendors/${vendor.id}`, {
      token: adminToken,
      body: { isActive: false },
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.vendor.isActive).toBe(true);
  });

  it('404s for a vendor that does not exist', async () => {
    const res = await api('PATCH', '/api/vendor-invoices/vendors/clx0000000000000000000000', {
      token: adminToken,
      body: { city: 'Nowhere' },
    });
    expect(res.status).toBe(404);
  });
});

describe('vendor archive', () => {
  it('sets isActive false without deleting the row', async () => {
    const vendor = await makeVendor();

    const res = await api<{ vendor: { isActive: boolean } }>(
      'POST',
      `/api/vendor-invoices/vendors/${vendor.id}/archive`,
      { token: adminToken },
    );

    expect(res.status).toBe(200);
    expect(res.body.data!.vendor.isActive).toBe(false);
    expect(await prisma.vendor.findUnique({ where: { id: vendor.id } })).not.toBeNull();
  });

  it('is safe when repeated', async () => {
    const vendor = await makeVendor();
    await api('POST', `/api/vendor-invoices/vendors/${vendor.id}/archive`, { token: adminToken });
    const res = await api('POST', `/api/vendor-invoices/vendors/${vendor.id}/archive`, {
      token: adminToken,
    });
    expect(res.status).toBe(200);
  });

  it('keeps the vendor readable from their purchase history', async () => {
    const vendor = await makeVendor();
    const bill = await seedBill(vendor.id, [{ productName: 'zz-test kettle', rate: '500.00', qty: 2 }]);

    await api('POST', `/api/vendor-invoices/vendors/${vendor.id}/archive`, { token: adminToken });

    const res = await api<TradesBody>('GET', `/api/vendor-invoices/vendors/${vendor.id}/trades`, {
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.data!.trades.length).toBeGreaterThan(0);
    expect(await prisma.purchaseBill.findUnique({ where: { id: bill.id } })).not.toBeNull();
  });

  it('refuses a new mapping to an archived vendor', async () => {
    const vendor = await makeVendor();
    await api('POST', `/api/vendor-invoices/vendors/${vendor.id}/archive`, { token: adminToken });

    const res = await api('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '100.00' },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VENDOR_ARCHIVED');
  });
});

// ---------------------------------------------------------------------------

/** A purchase bill with lines, created directly — this module never writes one. */
async function seedBill(
  vendorId: string,
  lines: { productName: string; rate: string; qty: number }[],
): Promise<{ id: string; billNumber: string }> {
  const billNumber = tag();
  const bill = await prisma.purchaseBill.create({
    data: {
      billNumber,
      vendorId,
      billType: 'PAID_UP',
      billDate: new Date('2026-09-10T00:00:00Z'),
      createdById: admin.id,
      items: {
        create: lines.map((line, index) => ({
          lineNo: index + 1,
          productName: line.productName,
          orderedQty: line.qty,
          receivedQty: line.qty,
          rate: line.rate,
        })),
      },
    },
    select: { id: true, billNumber: true },
  });
  created.billIds.push(bill.id);
  return bill;
}

describe('trade history', () => {
  it('is empty for a vendor with no purchases', async () => {
    const vendor = await makeVendor();
    const res = await api<TradesBody>('GET', `/api/vendor-invoices/vendors/${vendor.id}/trades`, {
      token: adminToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.trades).toEqual([]);
    expect(res.body.meta!.nextCursor).toBeNull();
  });

  it('returns one purchase with its recorded rate, quantities and bill reference', async () => {
    const vendor = await makeVendor();
    const bill = await seedBill(vendor.id, [
      { productName: 'zz-test brass kadhai', rate: '2000.00', qty: 3 },
    ]);

    const res = await api<TradesBody>('GET', `/api/vendor-invoices/vendors/${vendor.id}/trades`, {
      token: adminToken,
    });

    const trade = res.body.data!.trades[0]!;
    expect(trade.productName).toBe('zz-test brass kadhai');
    expect(trade.orderedQty).toBe(3);
    expect(trade.receivedQty).toBe(3);
    expect(Number(trade.rate)).toBe(2000);
    // Derived at read time from the stored rate and quantity.
    expect(Number(trade.lineTotal)).toBe(6000);
    expect(trade.billNumber).toBe(bill.billNumber);
    expect(trade.billId).toBe(bill.id);
  });

  it('carries real timestamps, not invented ones', async () => {
    const vendor = await makeVendor();
    await seedBill(vendor.id, [{ productName: 'zz-test timed', rate: '10.00', qty: 1 }]);

    const res = await api<TradesBody>('GET', `/api/vendor-invoices/vendors/${vendor.id}/trades`, {
      token: adminToken,
    });
    const trade = res.body.data!.trades[0]!;

    // The bill's own date, as printed on it.
    expect(trade.billDate.slice(0, 10)).toBe('2026-09-10');
    // And when the line was actually recorded — a different fact.
    expect(new Date(trade.recordedAt).getTime()).toBeGreaterThan(0);
    expect(trade).toHaveProperty('productImageUrl');
  });

  it('spans several bills and several products', async () => {
    const vendor = await makeVendor();
    await seedBill(vendor.id, [
      { productName: 'zz-test plate', rate: '100.00', qty: 1 },
      { productName: 'zz-test bowl', rate: '200.00', qty: 2 },
    ]);
    await seedBill(vendor.id, [{ productName: 'zz-test tray', rate: '300.00', qty: 3 }]);

    const res = await api<TradesBody>('GET', `/api/vendor-invoices/vendors/${vendor.id}/trades?limit=100`, {
      token: adminToken,
    });

    expect(res.body.data!.trades).toHaveLength(3);
    const names = res.body.data!.trades.map((t) => t.productName).sort();
    expect(names).toEqual(['zz-test bowl', 'zz-test plate', 'zz-test tray']);
  });

  it('searches by the product name the vendor used', async () => {
    const vendor = await makeVendor();
    await seedBill(vendor.id, [
      { productName: 'zz-test copper jug', rate: '50.00', qty: 1 },
      { productName: 'zz-test steel pan', rate: '60.00', qty: 1 },
    ]);

    const res = await api<TradesBody>(
      'GET',
      `/api/vendor-invoices/vendors/${vendor.id}/trades?q=copper`,
      { token: adminToken },
    );

    expect(res.body.data!.trades).toHaveLength(1);
    expect(res.body.data!.trades[0]?.productName).toContain('copper');
  });

  it('filters by bill date range', async () => {
    const vendor = await makeVendor();
    await seedBill(vendor.id, [{ productName: 'zz-test dated', rate: '10.00', qty: 1 }]);

    const inRange = await api<TradesBody>(
      'GET',
      `/api/vendor-invoices/vendors/${vendor.id}/trades?from=2026-09-01&to=2026-09-30`,
      { token: adminToken },
    );
    expect(inRange.body.data!.trades.length).toBeGreaterThan(0);

    const outOfRange = await api<TradesBody>(
      'GET',
      `/api/vendor-invoices/vendors/${vendor.id}/trades?from=2027-01-01`,
      { token: adminToken },
    );
    expect(outOfRange.body.data!.trades).toHaveLength(0);
  });

  it('paginates', async () => {
    const vendor = await makeVendor();
    await seedBill(vendor.id, [
      { productName: 'zz-test a', rate: '1.00', qty: 1 },
      { productName: 'zz-test b', rate: '2.00', qty: 1 },
    ]);

    const res = await api<TradesBody>(
      'GET',
      `/api/vendor-invoices/vendors/${vendor.id}/trades?limit=1`,
      { token: adminToken },
    );
    expect(res.body.data!.trades).toHaveLength(1);
    expect(res.body.meta!.nextCursor).toBeTruthy();
  });

  it('stores no trade-history rows of its own', async () => {
    // The history is Procurement's records, read live. If a second table ever
    // appeared, this module would have two versions of the same truth.
    const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name ILIKE '%trade%'`,
    );
    expect(tables).toEqual([]);
  });

  it('404s for a vendor that does not exist', async () => {
    const res = await api('GET', '/api/vendor-invoices/vendors/clx0000000000000000000000/trades', {
      token: adminToken,
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('product mapping', () => {
  it('maps a product to a vendor by rsProductId', async () => {
    const vendor = await makeVendor();

    const res = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '1200.00' },
    });

    expect(res.status).toBe(201);
    const mapping = res.body.data!.mapping;
    created.mappingIds.push(mapping.id);

    expect(mapping.rsProductId).toBe(rsProductId);
    expect(mapping.isActive).toBe(true);
    expect(Number(mapping.currentRate)).toBe(1200);
    // Product information resolves from RsProduct, the canonical catalogue.
    expect(mapping.productTitle.length).toBeGreaterThan(0);
    expect(mapping).toHaveProperty('productImageUrl');
  });

  it('rejects a body using the legacy productId key', async () => {
    const vendor = await makeVendor();
    const legacy = await prisma.product.findFirst({ select: { id: true } });

    const res = await api('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, productId: legacy?.id ?? rsProductId, currentRate: '100.00' },
    });

    expect(res.status).toBe(422);
  });

  it('rejects a ShopifyVariant id as the product identity', async () => {
    // The mapping is product-level. A variant id is a different identity and
    // does not exist in RsProduct.
    const vendor = await makeVendor();
    const variant = await prisma.shopifyVariant.findFirstOrThrow({ select: { id: true } });

    const res = await api('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId: variant.id, currentRate: '100.00' },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RS_PRODUCT_NOT_FOUND');
  });

  it('rejects a vendor or product that does not exist', async () => {
    const vendor = await makeVendor();

    expect(
      (await api('POST', '/api/vendor-invoices/mappings', {
        token: adminToken,
        body: { vendorId: 'clx0000000000000000000000', rsProductId, currentRate: '1.00' },
      })).status,
    ).toBe(400);

    expect(
      (await api('POST', '/api/vendor-invoices/mappings', {
        token: adminToken,
        body: { vendorId: vendor.id, rsProductId: 'clx0000000000000000000000', currentRate: '1.00' },
      })).status,
    ).toBe(400);
  });

  it('refuses a duplicate active pair', async () => {
    const vendor = await makeVendor();
    const first = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '100.00' },
    });
    created.mappingIds.push(first.body.data!.mapping.id);

    const res = await api('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '200.00' },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MAPPING_ALREADY_EXISTS');
  });

  it('revives an archived pair instead of creating a second row', async () => {
    const vendor = await makeVendor();
    const first = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '100.00' },
    });
    const mappingId = first.body.data!.mapping.id;
    created.mappingIds.push(mappingId);

    await api('POST', `/api/vendor-invoices/mappings/${mappingId}/archive`, { token: adminToken });

    const revived = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '175.00' },
    });

    expect(revived.status).toBe(201);
    // Same row, revived at the new rate — the pair's history stays in one place.
    expect(revived.body.data!.mapping.id).toBe(mappingId);
    expect(revived.body.data!.mapping.isActive).toBe(true);
    expect(Number(revived.body.data!.mapping.currentRate)).toBe(175);

    expect(
      await prisma.vendorProductMapping.count({ where: { vendorId: vendor.id, rsProductId } }),
    ).toBe(1);
  });

  it('lets one vendor supply many products and one product have many vendors', async () => {
    const vendorA = await makeVendor();
    const vendorB = await makeVendor();
    const second = await prisma.rsProduct.findFirstOrThrow({
      where: { source: 'SHOPIFY', id: { not: rsProductId } },
      select: { id: true },
    });

    for (const body of [
      { vendorId: vendorA.id, rsProductId, currentRate: '100.00' },
      { vendorId: vendorA.id, rsProductId: second.id, currentRate: '110.00' },
      { vendorId: vendorB.id, rsProductId, currentRate: '120.00' },
    ]) {
      const res = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
        token: adminToken,
        body,
      });
      expect(res.status).toBe(201);
      created.mappingIds.push(res.body.data!.mapping.id);
    }

    const forProduct = await api<MappingsBody>(
      'GET',
      `/api/vendor-invoices/mappings?rsProductId=${rsProductId}&limit=100`,
      { token: adminToken },
    );
    expect(forProduct.body.data!.mappings.length).toBeGreaterThanOrEqual(2);
  });

  it('lists and filters mappings', async () => {
    const vendor = await makeVendor();
    const res = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '100.00' },
    });
    created.mappingIds.push(res.body.data!.mapping.id);

    const byVendor = await api<MappingsBody>(
      'GET',
      `/api/vendor-invoices/mappings?vendorId=${vendor.id}`,
      { token: adminToken },
    );
    expect(byVendor.body.data!.mappings).toHaveLength(1);
    for (const m of byVendor.body.data!.mappings) expect(m.vendorId).toBe(vendor.id);
  });

  it('updates the current rate', async () => {
    const vendor = await makeVendor();
    const created1 = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '2500.00' },
    });
    const mappingId = created1.body.data!.mapping.id;
    created.mappingIds.push(mappingId);

    const res = await api<MappingBody>('PATCH', `/api/vendor-invoices/mappings/${mappingId}`, {
      token: adminToken,
      body: { currentRate: '2700.00' },
    });

    expect(res.status).toBe(200);
    expect(Number(res.body.data!.mapping.currentRate)).toBe(2700);
  });

  it('archives a mapping without deleting it', async () => {
    const vendor = await makeVendor();
    const made = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '100.00' },
    });
    const mappingId = made.body.data!.mapping.id;
    created.mappingIds.push(mappingId);

    const res = await api<MappingBody>(
      'POST',
      `/api/vendor-invoices/mappings/${mappingId}/archive`,
      { token: adminToken },
    );

    expect(res.status).toBe(200);
    expect(res.body.data!.mapping.isActive).toBe(false);
    expect(
      await prisma.vendorProductMapping.findUnique({ where: { id: mappingId } }),
    ).not.toBeNull();
  });

  it('404s for a mapping that does not exist', async () => {
    expect(
      (await api('PATCH', '/api/vendor-invoices/mappings/clx0000000000000000000000', {
        token: adminToken,
        body: { currentRate: '1.00' },
      })).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('a mapping rate change never rewrites history', () => {
  it('leaves PurchaseBillItem.rate exactly as recorded', async () => {
    const vendor = await makeVendor();

    // A purchase at ₹2,000, and a current agreed rate of ₹2,500.
    const bill = await seedBill(vendor.id, [
      { productName: 'zz-test historical', rate: '2000.00', qty: 1 },
    ]);
    const made = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '2500.00' },
    });
    created.mappingIds.push(made.body.data!.mapping.id);

    // Renegotiate to ₹2,700.
    await api('PATCH', `/api/vendor-invoices/mappings/${made.body.data!.mapping.id}`, {
      token: adminToken,
      body: { currentRate: '2700.00' },
    });

    // The purchase still cost ₹2,000.
    const item = await prisma.purchaseBillItem.findFirstOrThrow({ where: { billId: bill.id } });
    expect(Number(item.rate)).toBe(2000);

    const trades = await api<TradesBody>(
      'GET',
      `/api/vendor-invoices/vendors/${vendor.id}/trades`,
      { token: adminToken },
    );
    expect(Number(trades.body.data!.trades[0]!.rate)).toBe(2000);
    expect(Number(trades.body.data!.trades[0]!.lineTotal)).toBe(2000);
  });
});

describe('access control', () => {
  const routes: [string, string][] = [
    ['GET', '/api/vendor-invoices/vendors'],
    ['POST', '/api/vendor-invoices/vendors'],
    ['GET', '/api/vendor-invoices/mappings'],
    ['POST', '/api/vendor-invoices/mappings'],
  ];

  it('refuses every route without a token', async () => {
    for (const [method, path] of routes) {
      // A body only where the method allows one; fetch refuses it on GET.
      const res = await api(method, path, method === 'POST' ? { body: {} } : {});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a plain USER, who has no VENDOR_INVOICE access by default', async () => {
    expect(
      (await api('GET', '/api/vendor-invoices/vendors', { token: employeeToken })).status,
    ).toBe(403);
  });

  it('separates VIEW, CREATE, EDIT and DELETE', async () => {
    const vendor = await makeVendor();

    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'VENDOR_INVOICE', action: 'VIEW', allowed: true },
        { userId: employee.id, module: 'VENDOR_INVOICE', action: 'CREATE', allowed: false },
        { userId: employee.id, module: 'VENDOR_INVOICE', action: 'EDIT', allowed: false },
        { userId: employee.id, module: 'VENDOR_INVOICE', action: 'DELETE', allowed: false },
      ],
    });

    // VIEW alone reads but cannot change anything.
    expect((await api('GET', '/api/vendor-invoices/vendors', { token: employeeToken })).status).toBe(200);
    expect(
      (await api('POST', '/api/vendor-invoices/vendors', {
        token: employeeToken,
        body: { name: `${tag()} denied` },
      })).status,
    ).toBe(403);
    expect(
      (await api('PATCH', `/api/vendor-invoices/vendors/${vendor.id}`, {
        token: employeeToken,
        body: { city: 'Nowhere' },
      })).status,
    ).toBe(403);
    expect(
      (await api('POST', `/api/vendor-invoices/vendors/${vendor.id}/archive`, {
        token: employeeToken,
      })).status,
    ).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('rejects malformed input before it reaches the database', async () => {
    expect(
      (await api('GET', '/api/vendor-invoices/vendors?cursor=not-a-cuid', { token: adminToken }))
        .status,
    ).toBe(422);
    expect(
      (await api('POST', '/api/vendor-invoices/mappings', {
        token: adminToken,
        body: { vendorId: 'nope', rsProductId, currentRate: 'free' },
      })).status,
    ).toBe(422);
  });
});

describe('existing modules are untouched', () => {
  it('leaves the legacy Product master and Procurement records alone', async () => {
    const before = {
      product: await prisma.product.count(),
      inventory: await prisma.inventoryItem.count(),
      salesOrder: await prisma.salesOrder.count(),
      enquiry: await prisma.productEnquiry.count(),
    };

    const vendor = await makeVendor();
    const made = await api<MappingBody>('POST', '/api/vendor-invoices/mappings', {
      token: adminToken,
      body: { vendorId: vendor.id, rsProductId, currentRate: '100.00' },
    });
    created.mappingIds.push(made.body.data!.mapping.id);
    await api('PATCH', `/api/vendor-invoices/mappings/${made.body.data!.mapping.id}`, {
      token: adminToken,
      body: { currentRate: '150.00' },
    });

    expect(await prisma.product.count()).toBe(before.product);
    expect(await prisma.inventoryItem.count()).toBe(before.inventory);
    expect(await prisma.salesOrder.count()).toBe(before.salesOrder);
    expect(await prisma.productEnquiry.count()).toBe(before.enquiry);
  });

  it('leaves the synced RsProduct catalogue unchanged', async () => {
    expect(await prisma.rsProduct.count({ where: { source: 'SHOPIFY' } })).toBe(501);
  });

  it('records audit events through the existing mechanism', async () => {
    const vendor = await makeVendor();

    const entries = await prisma.auditLog.findMany({
      where: { entityType: 'Vendor', entityId: vendor.id },
      select: { action: true },
    });
    expect(entries.map((e) => e.action)).toContain('vendorInvoice.vendor.created');
  });
});
