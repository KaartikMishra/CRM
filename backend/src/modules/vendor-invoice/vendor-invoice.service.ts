/**
 * Vendor Invoices business logic.
 *
 * The module answers three questions about a supplier: who they are, what the
 * CRM has actually bought from them, and what they charge today.
 *
 * The second and third are deliberately different things, and keeping them
 * apart is the module's central rule:
 *
 *   - **What a purchase cost** is a fact about a document somebody was handed.
 *     It lives on PurchaseBillItem.rate, and nothing here can write it.
 *   - **What a vendor charges now** is a current agreement. It lives on
 *     VendorProductMapping.currentRate and changes whenever a price is
 *     renegotiated.
 *
 * Changing the second must never touch the first. A module that let a price
 * renegotiation rewrite last month's bills would make the purchase history
 * unusable as a record.
 *
 * Nothing here reads or writes the legacy Product master: product identity is
 * RsProduct throughout.
 */

import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import type {
  CreateMappingInput,
  CreateVendorInput,
  MappingListQuery,
  UpdateMappingInput,
  UpdateVendorInput,
  VendorListQuery,
  VendorListRow,
  VendorMappingRow,
  VendorSummary,
  VendorTradeQuery,
  VendorTradeRow,
} from '@rs/shared';
import { lineTotal } from '@rs/shared';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import * as repo from './vendor-invoice.repository.js';
import type { MappingRecord, VendorListRecord } from './vendor-invoice.repository.js';

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string }).code === UNIQUE_VIOLATION;

// ---------------------------------------------------------------------------
//  Vendors
// ---------------------------------------------------------------------------

function toVendorRow(vendor: VendorListRecord): VendorListRow {
  return {
    id: vendor.id,
    name: vendor.name,
    companyName: vendor.companyName,
    phone: vendor.phone,
    altPhone: vendor.altPhone,
    email: vendor.email,
    address: vendor.address,
    city: vendor.city,
    contactPerson: vendor.contactPerson,
    isActive: vendor.isActive,
    mappedProductCount: vendor._count.productMappings,
    createdAt: vendor.createdAt.toISOString(),
  };
}

function toVendorSummary(vendor: VendorListRecord): VendorSummary {
  return {
    id: vendor.id,
    name: vendor.name,
    companyName: vendor.companyName,
    address: vendor.address,
    phone: vendor.phone,
    altPhone: vendor.altPhone,
    email: vendor.email,
    contactPerson: vendor.contactPerson,
    city: vendor.city,
    isActive: vendor.isActive,
  };
}

export async function listVendors(query: VendorListQuery): Promise<{
  vendors: VendorListRow[];
  nextCursor: string | null;
}> {
  const { rows, nextCursor } = await repo.listVendors(query);
  return { vendors: rows.map(toVendorRow), nextCursor };
}

export async function getVendor(id: string): Promise<VendorSummary> {
  const vendor = await repo.findVendor(id);
  if (!vendor) throw AppError.notFound('VENDOR_NOT_FOUND', 'That vendor could not be found.');
  return toVendorSummary(vendor);
}

/**
 * Creates a vendor.
 *
 * Name uniqueness is enforced by the database, not by a check-then-insert here:
 * two concurrent requests would both pass a pre-check and one would still fail
 * on the index. Catching P2002 is what makes the outcome correct under a race,
 * and turning it into a readable conflict is what makes it useful.
 */
export async function createVendor(
  req: Request,
  actorId: string,
  input: CreateVendorInput,
): Promise<VendorListRow> {
  try {
    const created = await repo.createVendor(input as Prisma.VendorCreateInput);

    await recordAudit(req, {
      action: 'vendorInvoice.vendor.created',
      entityType: 'Vendor',
      entityId: created.id,
      actorId,
      newValue: { name: created.name, companyName: created.companyName },
    });

    return toVendorRow(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'VENDOR_NAME_TAKEN',
        'A vendor with that name already exists. Add something distinguishing, such as the city.',
      );
    }
    throw error;
  }
}

/**
 * Updates a vendor's details.
 *
 * `isActive` is deliberately not accepted here — archiving is its own operation
 * behind its own permission, and folding it into a profile edit would let EDIT
 * do what DELETE is meant to guard.
 */
export async function updateVendor(
  req: Request,
  actorId: string,
  id: string,
  input: UpdateVendorInput,
): Promise<VendorListRow> {
  const existing = await repo.findVendor(id);
  if (!existing) throw AppError.notFound('VENDOR_NOT_FOUND', 'That vendor could not be found.');

  const { isActive: _ignored, ...editable } = input;

  try {
    const updated = await repo.updateVendor(id, editable as Prisma.VendorUpdateInput);

    await recordAudit(req, {
      action: 'vendorInvoice.vendor.updated',
      entityType: 'Vendor',
      entityId: id,
      actorId,
      oldValue: { name: existing.name, companyName: existing.companyName },
      newValue: editable,
    });

    return toVendorRow(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'VENDOR_NAME_TAKEN',
        'A vendor with that name already exists. Add something distinguishing, such as the city.',
      );
    }
    throw error;
  }
}

/**
 * Archives a vendor.
 *
 * Soft, always. Purchase bills name this vendor and must stay readable, and the
 * product mappings stay too — archiving a supplier is a statement about future
 * work, not a reason to forget what was bought from them.
 */
export async function archiveVendor(
  req: Request,
  actorId: string,
  id: string,
): Promise<VendorSummary> {
  const existing = await repo.findVendor(id);
  if (!existing) throw AppError.notFound('VENDOR_NOT_FOUND', 'That vendor could not be found.');

  const { archived } = await repo.archiveVendor(id);

  if (archived) {
    await recordAudit(req, {
      action: 'vendorInvoice.vendor.archived',
      entityType: 'Vendor',
      entityId: id,
      actorId,
      oldValue: { isActive: true },
      newValue: { isActive: false },
    });
  }

  // Re-read so the caller sees the state that actually stands, whether this
  // request changed it or it was already archived.
  return getVendor(id);
}

// ---------------------------------------------------------------------------
//  Trade history — read-only
// ---------------------------------------------------------------------------

/**
 * A vendor's purchase history.
 *
 * Every row is an existing PurchaseBillItem. Nothing is stored twice: there is
 * no trade-history table, and this function has no write path of any kind.
 *
 * `lineTotal` is derived from the stored rate and quantity at read time rather
 * than persisted, so it can never drift from the numbers it summarises.
 */
export async function listVendorTrades(
  vendorId: string,
  query: VendorTradeQuery,
): Promise<{ trades: VendorTradeRow[]; nextCursor: string | null }> {
  const vendor = await repo.vendorState(vendorId);
  if (!vendor) throw AppError.notFound('VENDOR_NOT_FOUND', 'That vendor could not be found.');

  const { rows, nextCursor } = await repo.listVendorTrades(vendorId, query);

  const trades: VendorTradeRow[] = rows.map((item) => ({
    id: item.id,

    billDate: item.bill.billDate.toISOString(),
    // When the line was typed into the CRM. A real timestamp, distinct from the
    // bill's own date: a bill dated the 10th may be recorded on the 12th, and
    // both are true.
    recordedAt: item.createdAt.toISOString(),

    productName: item.productName,
    rsProductId: item.rsProductId,
    productImageUrl: item.productImage?.secureUrl ?? null,

    orderedQty: item.orderedQty,
    receivedQty: item.receivedQty,
    // The historical rate, exactly as recorded. Never the mapping's current
    // rate — that would restate what a past purchase cost.
    rate: item.rate.toString(),
    lineTotal: lineTotal(item.rate.toString(), item.orderedQty),

    billNumber: item.bill.billNumber,
    billId: item.bill.id,
    billStatus: item.bill.status,
    billType: item.bill.billType,
  }));

  return { trades, nextCursor };
}

// ---------------------------------------------------------------------------
//  Vendor ↔ product mappings
// ---------------------------------------------------------------------------

function toMappingRow(mapping: MappingRecord): VendorMappingRow {
  return {
    id: mapping.id,
    vendorId: mapping.vendorId,
    vendorName: mapping.vendor.name,

    rsProductId: mapping.rsProductId,
    productTitle: mapping.rsProduct.title,
    productImageUrl: mapping.rsProduct.images[0]?.url ?? null,
    productStatus: mapping.rsProduct.status,
    productSource: mapping.rsProduct.source,

    currentRate: mapping.currentRate.toString(),
    isActive: mapping.isActive,

    createdAt: mapping.createdAt.toISOString(),
    updatedAt: mapping.updatedAt.toISOString(),
  };
}

export async function listMappings(query: MappingListQuery): Promise<{
  mappings: VendorMappingRow[];
  nextCursor: string | null;
}> {
  const { rows, nextCursor } = await repo.listMappings(query);
  return { mappings: rows.map(toMappingRow), nextCursor };
}

/**
 * Maps a product to a vendor, or revives the mapping that already exists.
 *
 * The pair is unique regardless of state, so an archived pair cannot simply be
 * inserted again. Reviving it is also the better answer: the pair is one
 * relationship whose price and status change over time, and a second row would
 * split that history in two.
 *
 * The unique index is the arbiter under concurrency — the pre-read is a
 * courtesy that produces a good error message, and the P2002 handler is what
 * makes two simultaneous requests correct.
 */
export async function createMapping(
  req: Request,
  actorId: string,
  input: CreateMappingInput,
): Promise<VendorMappingRow> {
  const vendor = await repo.vendorState(input.vendorId);
  if (!vendor) throw AppError.badRequest('VENDOR_NOT_FOUND', 'That vendor could not be found.');
  if (!vendor.isActive) {
    throw AppError.badRequest(
      'VENDOR_ARCHIVED',
      'That vendor is archived. Restore them before mapping new products.',
    );
  }

  // RsProduct, the canonical catalogue — never the legacy Product master.
  const product = await repo.rsProductExists(input.rsProductId);
  if (!product) {
    throw AppError.badRequest('RS_PRODUCT_NOT_FOUND', 'That product could not be found.');
  }

  const existing = await repo.findMappingByPair(input.vendorId, input.rsProductId);

  if (existing?.isActive) {
    throw AppError.conflict(
      'MAPPING_ALREADY_EXISTS',
      'That product is already mapped to this vendor. Edit the existing mapping instead.',
    );
  }

  if (existing) {
    return reviveMapping(req, actorId, existing, input.currentRate);
  }

  try {
    const created = await repo.createMapping({
      vendorId: input.vendorId,
      rsProductId: input.rsProductId,
      currentRate: input.currentRate,
    });

    await recordAudit(req, {
      action: 'vendorInvoice.mapping.created',
      entityType: 'VendorProductMapping',
      entityId: created.id,
      actorId,
      newValue: {
        vendorId: created.vendorId,
        rsProductId: created.rsProductId,
        currentRate: created.currentRate.toString(),
      },
    });

    return toMappingRow(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent request created the pair between the read above and this
      // insert. Reviving it is the same outcome the sequential path produces.
      const raced = await repo.findMappingByPair(input.vendorId, input.rsProductId);
      if (raced && !raced.isActive) {
        return reviveMapping(req, actorId, raced, input.currentRate);
      }
      throw AppError.conflict(
        'MAPPING_ALREADY_EXISTS',
        'That product is already mapped to this vendor. Edit the existing mapping instead.',
      );
    }
    throw error;
  }
}

/** Brings an archived pair back, at the newly agreed rate. */
async function reviveMapping(
  req: Request,
  actorId: string,
  existing: MappingRecord,
  currentRate: string,
): Promise<VendorMappingRow> {
  const revived = await repo.updateMapping(existing.id, { isActive: true, currentRate });

  await recordAudit(req, {
    action: 'vendorInvoice.mapping.reactivated',
    entityType: 'VendorProductMapping',
    entityId: existing.id,
    actorId,
    oldValue: { isActive: false, currentRate: existing.currentRate.toString() },
    newValue: { isActive: true, currentRate },
  });

  return toMappingRow(revived);
}

/**
 * Changes what a vendor charges today.
 *
 * Only this row is written. Past purchases keep the rate they were recorded
 * with — that is the whole reason the two numbers live in different tables.
 */
export async function updateMapping(
  req: Request,
  actorId: string,
  id: string,
  input: UpdateMappingInput,
): Promise<VendorMappingRow> {
  const existing = await repo.findMapping(id);
  if (!existing) throw AppError.notFound('MAPPING_NOT_FOUND', 'That mapping could not be found.');

  const data: Prisma.VendorProductMappingUpdateInput = {};
  if (input.currentRate !== undefined) data.currentRate = input.currentRate;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  if (Object.keys(data).length === 0) return toMappingRow(existing);

  const updated = await repo.updateMapping(id, data);

  await recordAudit(req, {
    action: 'vendorInvoice.mapping.updated',
    entityType: 'VendorProductMapping',
    entityId: id,
    actorId,
    oldValue: {
      currentRate: existing.currentRate.toString(),
      isActive: existing.isActive,
    },
    newValue: { ...input },
  });

  return toMappingRow(updated);
}

/**
 * Archives a mapping.
 *
 * Soft, so the pair can be revived later without splitting its history, and so
 * nothing about past purchases changes.
 */
export async function archiveMapping(
  req: Request,
  actorId: string,
  id: string,
): Promise<VendorMappingRow> {
  const existing = await repo.findMapping(id);
  if (!existing) throw AppError.notFound('MAPPING_NOT_FOUND', 'That mapping could not be found.');

  if (!existing.isActive) return toMappingRow(existing);

  const archived = await repo.updateMapping(id, { isActive: false });

  await recordAudit(req, {
    action: 'vendorInvoice.mapping.archived',
    entityType: 'VendorProductMapping',
    entityId: id,
    actorId,
    oldValue: { isActive: true },
    newValue: { isActive: false },
  });

  return toMappingRow(archived);
}
