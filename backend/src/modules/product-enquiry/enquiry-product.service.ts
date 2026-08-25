/**
 * Enquiry lines: adding, updating, and resolving one as NO_VENDOR.
 *
 * The twenty-product cap is defended at three depths (§12, §36):
 *   - Zod rejects an oversized create payload at the edge
 *   - this service takes a row lock before allocating the next lineNo
 *   - the unique index and the line_no_within_20 CHECK are the final word
 *
 * Only the third survives concurrency on its own, which is why it exists.
 */

import type { Prisma } from '@rs/database';
import type { AddEnquiryProductInput, EnquiryDetail, UpdateEnquiryProductInput } from '@rs/shared';
import { MAX_PRODUCTS_PER_ENQUIRY } from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { canAddProduct, canEditEnquiry } from '../../policies/enquiry-access.js';
import { recordEvent } from './enquiry-event.service.js';
import { assertNotClosed } from './enquiry-status.js';
import { dimensionColumns, weightColumns } from './measurement-columns.js';
import * as repo from './product-enquiry.repository.js';
import { TX_OPTIONS, detailAfterCommit, forbidden, notFound } from './product-enquiry.service.js';

function productNotFound(): AppError {
  return AppError.notFound('PRODUCT_NOT_FOUND', 'That product could not be found.');
}

export async function addProduct(
  actor: AuthenticatedUser,
  enquiryId: string,
  input: AddEnquiryProductInput,
): Promise<EnquiryDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    const enquiry = await repo.findForPolicy(enquiryId, tx);
    if (!enquiry) throw notFound();
    // Closed first: the answer is the same for everyone and ENQUIRY_CLOSED says
    // more than a bare 403. Status is not secret — §22 lets any authenticated
    // employee view any enquiry.
    assertNotClosed(enquiry.status);
    if (!canAddProduct({ id: actor.id, role: actor.role }, enquiry)) throw forbidden();

    // Queue concurrent adds so the second sees the first's line, not a stale
    // count — the unique index and CHECK still backstop it.
    await repo.lockEnquiry(tx, enquiryId);

    const highest = await tx.enquiryProduct.aggregate({
      where: { enquiryId },
      _max: { lineNo: true },
      _count: true,
    });

    if (highest._count >= MAX_PRODUCTS_PER_ENQUIRY) {
      throw AppError.conflict(
        'MAX_PRODUCTS_REACHED',
        `An enquiry can hold at most ${MAX_PRODUCTS_PER_ENQUIRY} products.`,
      );
    }

    const lineNo = (highest._max.lineNo ?? 0) + 1;

    if (lineNo < 1 || lineNo > MAX_PRODUCTS_PER_ENQUIRY) {
      // Reachable only if lines were removed leaving a high water mark.
      throw AppError.conflict(
        'INVALID_LINE_NUMBER',
        `Line numbers must fall between 1 and ${MAX_PRODUCTS_PER_ENQUIRY}.`,
      );
    }

    const product = await tx.enquiryProduct.create({
      data: {
        enquiryId,
        lineNo,
        name: input.name,
        quantity: input.quantity,
        imageId: input.imageAssetId ?? null,
        similarOptionNeeded: input.similarOptionNeeded,
        ...weightColumns(input.weight),
        ...dimensionColumns(input.dimension),
      },
      select: { id: true, lineNo: true },
    });

    await recordEvent(tx, {
      enquiryId,
      type: 'PRODUCT_ADDED',
      actorId: actor.id,
      field: 'lineNo',
      newValue: String(product.lineNo),
      metadata: { productId: product.id, name: input.name },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(enquiryId, now);
}

export async function updateProduct(
  actor: AuthenticatedUser,
  enquiryId: string,
  productId: string,
  input: UpdateEnquiryProductInput,
): Promise<EnquiryDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    const enquiry = await repo.findForPolicy(enquiryId, tx);
    if (!enquiry) throw notFound();
    assertNotClosed(enquiry.status);
    if (!canEditEnquiry({ id: actor.id, role: actor.role }, enquiry)) throw forbidden();

    // §26 — resolved through the enquiry, never by product id alone.
    const existing = await repo.findProductInEnquiry(tx, enquiryId, productId);
    if (!existing) throw productNotFound();

    // §8 — mirrors the no_vendor_has_reason CHECK with a usable message.
    if (input.status === 'NO_VENDOR' && !input.noVendorReason) {
      throw AppError.badRequest(
        'NO_VENDOR_REASON_REQUIRED',
        'Give a reason before marking this product as having no vendor.',
      );
    }

    // A line with vendor responses cannot be declared vendor-less.
    if (input.status === 'NO_VENDOR') {
      const responses = await tx.vendorResponse.count({ where: { enquiryProductId: productId } });
      if (responses > 0) {
        throw AppError.conflict(
          'INVALID_STATUS_TRANSITION',
          'This product already has vendor responses and cannot be marked as having no vendor.',
        );
      }
    }

    const data: Prisma.EnquiryProductUpdateInput = {};

    if (input.name !== undefined) data.name = input.name;
    if (input.quantity !== undefined) data.quantity = input.quantity;
    if (input.similarOptionNeeded !== undefined) {
      data.similarOptionNeeded = input.similarOptionNeeded;
    }
    if (input.imageAssetId !== undefined) {
      data.image = input.imageAssetId
        ? { connect: { id: input.imageAssetId } }
        : { disconnect: true };
    }
    if (input.weight !== undefined) Object.assign(data, weightColumns(input.weight));
    if (input.dimension !== undefined) Object.assign(data, dimensionColumns(input.dimension));

    if (input.status !== undefined) {
      data.status = input.status;
      data.noVendorReason = input.status === 'NO_VENDOR' ? (input.noVendorReason ?? null) : null;
    }

    await tx.enquiryProduct.update({ where: { id: productId }, data });

    await recordEvent(tx, {
      enquiryId,
      type: 'PRODUCT_UPDATED',
      actorId: actor.id,
      field: input.status !== undefined ? 'status' : 'details',
      oldValue: input.status !== undefined ? existing.status : null,
      newValue: input.status !== undefined ? input.status : null,
      metadata: { productId, lineNo: existing.lineNo },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(enquiryId, now);
}

export { productNotFound };
