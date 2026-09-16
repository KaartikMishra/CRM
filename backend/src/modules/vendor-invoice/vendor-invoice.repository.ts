/**
 * Every database read and write for Vendor Invoices.
 *
 * Two sources, deliberately kept apart:
 *
 *   - **Vendor and VendorProductMapping** are this module's own, and it writes
 *     them.
 *   - **PurchaseBill and PurchaseBillItem** are Procurement's, and this module
 *     only ever reads them. Trade history is those records; there is no second
 *     copy, and no write path from here can reach them.
 *
 * Product identity comes from RsProduct, the canonical catalogue. The legacy
 * Product master is never consulted.
 */

import type { Prisma } from '@prisma/client';
import type { MappingListQuery, VendorListQuery, VendorTradeQuery } from '@rs/shared';
import { prisma } from '../../config/database.js';

// ---------------------------------------------------------------------------
//  Vendors
// ---------------------------------------------------------------------------

/**
 * The columns the vendor table needs, plus a count of live mappings.
 *
 * `_count` rather than fetching the mappings: the list shows how many products
 * a vendor supplies, not which, and loading them per row would be an N+1 across
 * the whole page.
 */
const vendorListSelect = {
  id: true,
  name: true,
  companyName: true,
  phone: true,
  altPhone: true,
  email: true,
  address: true,
  city: true,
  contactPerson: true,
  isActive: true,
  createdAt: true,
  _count: { select: { productMappings: { where: { isActive: true } } } },
} satisfies Prisma.VendorSelect;

export type VendorListRecord = Prisma.VendorGetPayload<{ select: typeof vendorListSelect }>;

function vendorWhere(query: VendorListQuery): Prisma.VendorWhereInput {
  const where: Prisma.VendorWhereInput = {};

  if (query.isActive !== undefined) where.isActive = query.isActive;

  if (query.q) {
    // Name, company, phone or email: staff look a supplier up by whichever of
    // those they happen to have in front of them.
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { companyName: { contains: query.q, mode: 'insensitive' } },
      { phone: { contains: query.q } },
      { altPhone: { contains: query.q } },
      { email: { contains: query.q, mode: 'insensitive' } },
    ];
  }

  return where;
}

export async function listVendors(query: VendorListQuery): Promise<{
  rows: VendorListRecord[];
  nextCursor: string | null;
}> {
  const rows = await prisma.vendor.findMany({
    where: vendorWhere(query),
    // `id` as the tiebreaker: two vendors cannot share a name today, but the
    // cursor must stay correct even if that ever changes.
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: vendorListSelect,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return { rows: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
}

export function findVendor(id: string): Promise<VendorListRecord | null> {
  return prisma.vendor.findUnique({ where: { id }, select: vendorListSelect });
}

export function createVendor(data: Prisma.VendorCreateInput): Promise<VendorListRecord> {
  return prisma.vendor.create({ data, select: vendorListSelect });
}

export function updateVendor(
  id: string,
  data: Prisma.VendorUpdateInput,
): Promise<VendorListRecord> {
  return prisma.vendor.update({ where: { id }, data, select: vendorListSelect });
}

/**
 * Archives a vendor.
 *
 * A flag, and nothing else. Purchase bills, bill items and product mappings are
 * all left exactly as they are — the vendor stops being offered for new work
 * while every record naming them stays readable.
 */
export async function archiveVendor(id: string): Promise<{ archived: boolean }> {
  const result = await prisma.vendor.updateMany({
    where: { id, isActive: true },
    data: { isActive: false },
  });
  return { archived: result.count > 0 };
}

// ---------------------------------------------------------------------------
//  Trade history — read-only, from Procurement's records
// ---------------------------------------------------------------------------

/**
 * One page of a vendor's purchase lines.
 *
 * Queried from PurchaseBillItem with its bill and image included, rather than
 * from PurchaseBill with nested items: the page is a list of lines, and paging
 * bills would give pages of wildly different length. One query, no N+1 — the
 * image and the bill arrive with the line.
 */
export async function listVendorTrades(
  vendorId: string,
  query: VendorTradeQuery,
): Promise<{
  rows: Prisma.PurchaseBillItemGetPayload<{
    include: {
      bill: { select: { id: true; billNumber: true; billDate: true; status: true; billType: true } };
      productImage: { select: { secureUrl: true } };
    };
  }>[];
  nextCursor: string | null;
}> {
  const where: Prisma.PurchaseBillItemWhereInput = { bill: { vendorId } };

  if (query.q) {
    // The vendor's own wording, as printed on the bill.
    where.productName = { contains: query.q, mode: 'insensitive' };
  }

  if (query.from || query.to) {
    where.bill = {
      vendorId,
      billDate: {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      },
    };
  }

  const rows = await prisma.purchaseBillItem.findMany({
    where,
    // Newest bill first, which is how a buyer reads a supplier's history.
    orderBy: [{ bill: { billDate: 'desc' } }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: {
      bill: { select: { id: true, billNumber: true, billDate: true, status: true, billType: true } },
      productImage: { select: { secureUrl: true } },
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return { rows: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
}

// ---------------------------------------------------------------------------
//  Vendor ↔ product mappings
// ---------------------------------------------------------------------------

/**
 * A mapping with everything its row needs.
 *
 * The product comes from RsProduct — the canonical catalogue — with its first
 * image included in the same query. ShopifyVariant is deliberately absent: the
 * mapping is product-level, and a variant would be a different identity.
 */
const mappingInclude = {
  vendor: { select: { id: true, name: true } },
  rsProduct: {
    select: {
      id: true,
      title: true,
      status: true,
      source: true,
      images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
    },
  },
} satisfies Prisma.VendorProductMappingInclude;

export type MappingRecord = Prisma.VendorProductMappingGetPayload<{
  include: typeof mappingInclude;
}>;

function mappingWhere(query: MappingListQuery): Prisma.VendorProductMappingWhereInput {
  const where: Prisma.VendorProductMappingWhereInput = {};

  if (query.vendorId) where.vendorId = query.vendorId;
  if (query.rsProductId) where.rsProductId = query.rsProductId;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.q) where.rsProduct = { title: { contains: query.q, mode: 'insensitive' } };

  return where;
}

export async function listMappings(query: MappingListQuery): Promise<{
  rows: MappingRecord[];
  nextCursor: string | null;
}> {
  const rows = await prisma.vendorProductMapping.findMany({
    where: mappingWhere(query),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: mappingInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return { rows: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
}

export function findMapping(id: string): Promise<MappingRecord | null> {
  return prisma.vendorProductMapping.findUnique({ where: { id }, include: mappingInclude });
}

export function findMappingByPair(
  vendorId: string,
  rsProductId: string,
): Promise<MappingRecord | null> {
  return prisma.vendorProductMapping.findUnique({
    where: { vendorId_rsProductId: { vendorId, rsProductId } },
    include: mappingInclude,
  });
}

export function createMapping(
  data: Prisma.VendorProductMappingUncheckedCreateInput,
): Promise<MappingRecord> {
  return prisma.vendorProductMapping.create({ data, include: mappingInclude });
}

export function updateMapping(
  id: string,
  data: Prisma.VendorProductMappingUpdateInput,
): Promise<MappingRecord> {
  return prisma.vendorProductMapping.update({ where: { id }, data, include: mappingInclude });
}

/** Whether a vendor exists, and whether they are still active. */
export function vendorState(id: string): Promise<{ id: string; isActive: boolean } | null> {
  return prisma.vendor.findUnique({ where: { id }, select: { id: true, isActive: true } });
}

/** Whether an RsProduct exists. The canonical catalogue, never legacy Product. */
export function rsProductExists(id: string): Promise<{ id: string } | null> {
  return prisma.rsProduct.findUnique({ where: { id }, select: { id: true } });
}
