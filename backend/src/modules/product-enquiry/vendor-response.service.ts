/**
 * §7/§14 — recording what a vendor came back with.
 *
 * A product may carry several vendor responses; that is the point of the module
 * (§39 of the original brief), so a second POST is not automatically a mistake.
 * What is a mistake is the same response arriving twice because a request was
 * retried, which the duplicate guard below catches without blocking a genuine
 * second quote from another vendor.
 *
 * Rate is a decimal string end to end and reaches Postgres as NUMERIC; no
 * floating point touches money at any point (§7).
 */

import type { CreateVendorResponseInput, EnquiryDetail } from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { canAddVendorResponse } from '../../policies/enquiry-access.js';
import { recordEvent } from './enquiry-event.service.js';
import { assertNotClosed } from './enquiry-status.js';
import { vendorDimensionColumns, weightColumns } from './measurement-columns.js';
import { productNotFound } from './enquiry-product.service.js';
import * as repo from './product-enquiry.repository.js';
import { TX_OPTIONS, detailAfterCommit, forbidden, notFound } from './product-enquiry.service.js';

/**
 * §29 — how long an identical response is treated as a retry rather than a
 * second quote. Long enough to absorb a double-click or a client retry, short
 * enough that a deliberate re-entry minutes later still records.
 */
const DUPLICATE_WINDOW_MS = 60_000;

export async function addVendorResponse(
  actor: AuthenticatedUser,
  enquiryId: string,
  productId: string,
  input: CreateVendorResponseInput,
): Promise<EnquiryDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    // Queue concurrent responses on this enquiry so the duplicate guard below
    // cannot be raced by two identical retries.
    await repo.lockEnquiry(tx, enquiryId);

    const enquiry = await repo.findForPolicy(enquiryId, tx);
    if (!enquiry) throw notFound();
    assertNotClosed(enquiry.status);
    // §23 — vendor responses are Towards-only, plus admin.
    if (!canAddVendorResponse({ id: actor.id, role: actor.role }, enquiry)) throw forbidden();

    const product = await repo.findProductInEnquiry(tx, enquiryId, productId);
    if (!product) throw productNotFound();

    const vendor = await tx.vendor.findUnique({
      where: { id: input.vendorId },
      select: { id: true, name: true, isActive: true },
    });
    if (!vendor || !vendor.isActive) {
      throw AppError.notFound('VENDOR_NOT_FOUND', 'That vendor could not be found.');
    }

    if (input.imageAssetId) {
      const asset = await tx.mediaAsset.findUnique({
        where: { id: input.imageAssetId },
        select: { id: true },
      });
      if (!asset) {
        throw AppError.badRequest('INVALID_IMAGE', 'That image could not be found.');
      }
    }

    // §29 — an identical response inside the window is a retry, not a new quote.
    const duplicate = await tx.vendorResponse.findFirst({
      where: {
        enquiryProductId: productId,
        vendorId: input.vendorId,
        matchType: input.matchType,
        ratePerUnit: input.ratePerUnit,
        deliveryWithinDays: input.deliveryWithinDays,
        createdAt: { gte: new Date(at.getTime() - DUPLICATE_WINDOW_MS) },
      },
      select: { id: true },
    });

    if (!duplicate) {
      await tx.vendorResponse.create({
        data: {
          enquiryProductId: productId,
          vendorId: input.vendorId,
          matchType: input.matchType,
          ratePerUnit: input.ratePerUnit,
          currency: input.currency,
          deliveryWithinDays: input.deliveryWithinDays,
          deliveryNote: input.deliveryNote ?? null,
          notes: input.notes ?? null,
          imageId: input.imageAssetId ?? null,
          createdById: actor.id,
          ...weightColumns(input.weight),
          ...vendorDimensionColumns(input.dimension),
        },
      });

      // The product is now answered. Any NO_VENDOR reason is cleared, because
      // the line is no longer vendor-less.
      await tx.enquiryProduct.update({
        where: { id: productId },
        data: { status: 'RESPONDED', noVendorReason: null },
      });

      await recordEvent(tx, {
        enquiryId,
        type: 'VENDOR_RESPONSE_ADDED',
        actorId: actor.id,
        field: 'vendorId',
        newValue: vendor.id,
        metadata: {
          productId,
          lineNo: product.lineNo,
          vendorName: vendor.name,
          ratePerUnit: input.ratePerUnit,
          deliveryWithinDays: input.deliveryWithinDays,
        },
      });
    }

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(enquiryId, now);
}
