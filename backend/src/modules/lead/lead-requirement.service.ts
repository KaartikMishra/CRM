/**
 * Complete the Ideal — the product requirements on a lead.
 *
 * What a customer asked for, which is not the same thing as a catalogue product
 * and not the same thing as an order. A requirement is pre-sales information:
 * nothing here creates a SalesOrder, allocates stock, or touches an inventory
 * figure, and the module holds no path to any of those.
 *
 * ### Three facts kept apart on purpose
 *
 *   - **`productName`** is the customer's own words. It survives a catalogue
 *     match: somebody who asked for a "big brass thali for weddings" asked for
 *     that, even once it has been mapped to a product titled differently.
 *   - **`rsProduct`** is the catalogue row, matched EXACT or SIMILAR.
 *   - **`productValue`** is what this requirement is worth to this customer. It
 *     is deliberately not the product's price: a catalogue figure is the
 *     catalogue's, and copying it here would quietly turn a quote into a price
 *     list. Nothing in this file reads `ShopifyVariant.price`.
 *
 * ### What is derived rather than stored
 *
 * Volume. It is length x width x height, computed by `lead.calc.ts` on every
 * read, and there is no column for it — see the comment on `volume` for why a
 * fourth number free to contradict three is worse than no number at all.
 */

import type { Prisma } from '@rs/database';
import type {
  LeadProductRequirementInput,
  LeadRequirementView,
  UpdateLeadRequirementInput,
} from '@rs/shared';
import { toGrams, toMillimetres } from '@rs/shared';
import type { Request } from 'express';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { volume } from './lead.calc.js';
import * as repo from './lead.repository.js';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

const leadNotFound = (): AppError =>
  AppError.notFound('LEAD_NOT_FOUND', 'That lead could not be found.');

const requirementNotFound = (): AppError =>
  AppError.notFound('REQUIREMENT_NOT_FOUND', 'That requirement could not be found.');

// ---------------------------------------------------------------------------
//  Mappers
// ---------------------------------------------------------------------------

const dec = (d: Prisma.Decimal | null): string | null => (d === null ? null : d.toString());

/**
 * One requirement as the API reports it.
 *
 * Exported because the lead detail read maps the same rows — one definition of
 * what a requirement looks like on the wire, rather than two that can drift.
 */
export function toRequirementView(row: repo.LeadRequirementRecord): LeadRequirementView {
  const weight =
    row.weightValue === null || row.weightUnit === null
      ? null
      : {
          value: row.weightValue.toString(),
          unit: row.weightUnit,
          inGrams: dec(row.weightInGrams) ?? '0',
        };

  const dimension =
    row.lengthValue === null ||
    row.widthValue === null ||
    row.heightValue === null ||
    row.dimensionUnit === null
      ? null
      : {
          length: row.lengthValue.toString(),
          width: row.widthValue.toString(),
          height: row.heightValue.toString(),
          unit: row.dimensionUnit,
        };

  /*
    Derived here, on the read, from the same columns `dimension` above reports.
    Numbers rather than the Decimal strings, because this is arithmetic — and
    back to strings in the response, matching how every other money and
    measurement figure crosses the wire.
  */
  const computed = volume({
    length: row.lengthValue === null ? null : Number(row.lengthValue),
    width: row.widthValue === null ? null : Number(row.widthValue),
    height: row.heightValue === null ? null : Number(row.heightValue),
    unit: row.dimensionUnit,
  });

  return {
    id: row.id,
    lineNo: row.lineNo,
    productName: row.productName,
    image: row.image,
    rsProduct: row.rsProduct
      ? {
          id: row.rsProduct.id,
          title: row.rsProduct.title,
          // SKU lives on the variant and a product has many; the first is the
          // one a picker shows. Absent rather than invented when there is none.
          sku: row.rsProduct.variants[0]?.sku ?? null,
          imageUrl: row.rsProduct.images[0]?.url ?? null,
        }
      : null,
    matchKind: row.matchKind,
    quantity: row.quantity,
    weight,
    dimension,
    volume: computed
      ? {
          value: String(computed.value),
          unit: computed.unit,
          inCubicMm: String(computed.inCubicMm),
        }
      : null,
    productValue: dec(row.productValue),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
//  Writing the measurement columns
// ---------------------------------------------------------------------------

/**
 * The raw figures plus their normalised companions.
 *
 * Same shape and the same two helpers EnquiryProduct uses — `toGrams` and
 * `toMillimetres` from @rs/shared — so a requirement and an enquiry line
 * normalise identically and no second unit system enters the codebase. The
 * normalised columns are never accepted from a caller: they are computed from
 * what was sent, which is what stops a client storing "5 kg = 3 g".
 */
function weightColumns(
  value: number | null | undefined,
  unit: repo.LeadRequirementRecord['weightUnit'] | null | undefined,
): { weightValue: number | null; weightUnit: typeof unit; weightInGrams: number | null } {
  if (value === null || value === undefined || !unit) {
    return { weightValue: null, weightUnit: null, weightInGrams: null };
  }
  return { weightValue: value, weightUnit: unit, weightInGrams: toGrams(value, unit) };
}

function dimensionColumns(
  length: number | null | undefined,
  width: number | null | undefined,
  height: number | null | undefined,
  unit: repo.LeadRequirementRecord['dimensionUnit'] | null | undefined,
) {
  const mm = (v: number | null | undefined): number | null =>
    v === null || v === undefined || !unit ? null : toMillimetres(v, unit);

  return {
    lengthValue: length ?? null,
    widthValue: width ?? null,
    heightValue: height ?? null,
    dimensionUnit: unit ?? null,
    lengthMm: mm(length),
    widthMm: mm(width),
    heightMm: mm(height),
  };
}

// ---------------------------------------------------------------------------
//  Validation that needs the database
// ---------------------------------------------------------------------------

/**
 * A named product must exist, and a named image must exist.
 *
 * Both are checked against the database rather than trusted, because a cuid that
 * parses is not a row that exists: without this, a requirement could point at a
 * deleted product or at nothing at all, and the foreign key would surface as a
 * 500 rather than as an answer.
 */
async function assertReferencesExist(
  tx: Prisma.TransactionClient,
  refs: { rsProductId?: string | null; imageId?: string | null },
): Promise<void> {
  if (refs.rsProductId) {
    const product = await repo.findRsProduct(refs.rsProductId, tx);
    if (!product) {
      throw AppError.badRequest('RS_PRODUCT_NOT_FOUND', 'That catalogue product could not be found.');
    }
  }

  if (refs.imageId) {
    const asset = await repo.findMediaAsset(refs.imageId, tx);
    if (!asset) {
      throw AppError.badRequest('INVALID_IMAGE', 'That image could not be found.');
    }
  }
}

// ---------------------------------------------------------------------------
//  Reading
// ---------------------------------------------------------------------------

export async function listRequirements(leadId: string): Promise<LeadRequirementView[]> {
  const lead = await repo.findLeadExists(leadId);
  if (!lead) throw leadNotFound();

  const rows = await repo.findRequirements(leadId);
  return rows.map(toRequirementView);
}

// ---------------------------------------------------------------------------
//  Creating
// ---------------------------------------------------------------------------

/**
 * Adds one requirement line.
 *
 * `lineNo` is assigned here, never accepted from the caller. It is allocated
 * inside a transaction that first locks the lead row, so two simultaneous adds
 * queue rather than both reading the same high-water mark — the mechanism
 * `addProduct` already uses for enquiry lines. The `@@unique([leadId, lineNo])`
 * index is the real backstop: the lock makes a collision unlikely, the index
 * makes it impossible.
 */
export async function createRequirement(
  req: Request,
  actor: AuthenticatedUser,
  leadId: string,
  input: LeadProductRequirementInput,
): Promise<LeadRequirementView> {
  const created = await prisma.$transaction(async (tx) => {
    const lead = await repo.findLeadExists(leadId, tx);
    if (!lead) throw leadNotFound();

    await assertReferencesExist(tx, {
      rsProductId: input.rsProductId,
      imageId: input.imageId,
    });

    await repo.lockLead(tx, leadId);
    const lineNo = await repo.nextRequirementLineNo(tx, leadId);

    return repo.createRequirement(tx, {
      leadId,
      lineNo,
      productName: input.productName,
      imageId: input.imageId ?? null,
      rsProductId: input.rsProductId ?? null,
      matchKind: input.matchKind ?? null,
      quantity: input.quantity,
      ...weightColumns(input.weightValue, input.weightUnit),
      ...dimensionColumns(
        input.lengthValue,
        input.widthValue,
        input.heightValue,
        input.dimensionUnit,
      ),
      productValue: input.productValue ?? null,
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'lead.requirement.added',
    entityType: 'LeadProductRequirement',
    entityId: created.id,
    actorId: actor.id,
    newValue: {
      leadId,
      productName: input.productName,
      quantity: input.quantity,
      rsProductId: input.rsProductId ?? null,
      matchKind: input.matchKind ?? null,
    },
  });

  const row = await repo.findRequirementView(leadId, created.id);
  if (!row) throw requirementNotFound();
  return toRequirementView(row);
}

// ---------------------------------------------------------------------------
//  Updating
// ---------------------------------------------------------------------------

/**
 * Edits one requirement.
 *
 * Absent, null and a value mean three different things — leave alone, clear, set
 * — so every field is tested for presence with `!== undefined` rather than for
 * truthiness. A falsy check here would make clearing a weight indistinguishable
 * from not mentioning it.
 *
 * ### The pairing rule
 *
 * `matchKind` describes a matched product, so the two have to agree *after* the
 * patch, not just within it. The merged result is therefore checked against the
 * row already in the database: clearing the product clears the kind with it, and
 * setting a kind on a requirement that has no product — and is not gaining one
 * in this same patch — is refused. Zod catches the one case it can see; this
 * catches the case that depends on stored state, and the table's CHECK
 * constraint catches anything either of us missed.
 */
export async function updateRequirement(
  req: Request,
  actor: AuthenticatedUser,
  leadId: string,
  requirementId: string,
  input: UpdateLeadRequirementInput,
): Promise<LeadRequirementView> {
  await prisma.$transaction(async (tx) => {
    const existing = await repo.findRequirementState(leadId, requirementId, tx);
    if (!existing) throw requirementNotFound();

    await assertReferencesExist(tx, {
      rsProductId: input.rsProductId,
      imageId: input.imageId,
    });

    // What the row will hold once this patch lands.
    const rsProductId =
      input.rsProductId !== undefined ? input.rsProductId : existing.rsProductId;
    const matchKind = input.matchKind !== undefined ? input.matchKind : existing.matchKind;

    if (matchKind !== null && rsProductId === null) {
      throw AppError.badRequest(
        'MATCH_KIND_WITHOUT_PRODUCT',
        'Choose the catalogue product this matches, or clear the match kind.',
      );
    }

    const data: Prisma.LeadProductRequirementUncheckedUpdateInput = {};

    if (input.productName !== undefined) data.productName = input.productName;
    if (input.quantity !== undefined) data.quantity = input.quantity;
    if (input.imageId !== undefined) data.imageId = input.imageId;
    if (input.productValue !== undefined) data.productValue = input.productValue;

    /*
      The product and its kind are written together whenever either moved, so the
      pair the rule above resolved is the pair that reaches the row. Writing only
      the field that was sent could leave a kind pointing at a product that this
      same patch removed.
    */
    if (input.rsProductId !== undefined || input.matchKind !== undefined) {
      data.rsProductId = rsProductId;
      data.matchKind = matchKind;
    }

    /*
      Measurements travel as a set, for the reason the enquiry module's
      `weightColumns` gives: a value and its unit are one answer, and the
      normalised companion is computed from both. Recomputed from the merged
      figures so a patch changing only the unit renormalises the value that was
      already stored.
    */
    if (input.weightValue !== undefined || input.weightUnit !== undefined) {
      const value = input.weightValue !== undefined ? input.weightValue : existing.weightValue;
      const unit = input.weightUnit !== undefined ? input.weightUnit : existing.weightUnit;
      Object.assign(data, weightColumns(value, unit));
    }

    if (
      input.lengthValue !== undefined ||
      input.widthValue !== undefined ||
      input.heightValue !== undefined ||
      input.dimensionUnit !== undefined
    ) {
      const length = input.lengthValue !== undefined ? input.lengthValue : existing.lengthValue;
      const width = input.widthValue !== undefined ? input.widthValue : existing.widthValue;
      const height = input.heightValue !== undefined ? input.heightValue : existing.heightValue;
      const unit = input.dimensionUnit !== undefined ? input.dimensionUnit : existing.dimensionUnit;
      Object.assign(data, dimensionColumns(length, width, height, unit));
    }

    const count = await repo.updateRequirementForLead(leadId, requirementId, data);
    if (count === 0) throw requirementNotFound();
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'lead.requirement.updated',
    entityType: 'LeadProductRequirement',
    entityId: requirementId,
    actorId: actor.id,
    newValue: { leadId, ...input },
  });

  const row = await repo.findRequirementView(leadId, requirementId);
  if (!row) throw requirementNotFound();
  return toRequirementView(row);
}

// ---------------------------------------------------------------------------
//  Deleting
// ---------------------------------------------------------------------------

/**
 * Removes one requirement line.
 *
 * **The MediaAsset it referenced is deliberately left in place.** Media here is
 * an independently retained record: it carries its own uploader and timestamps,
 * six tables reference it, and every one of those foreign keys is SetNull rather
 * than Cascade — the schema's own statement that an asset outlives the row
 * pointing at it. Deleting the Cloudinary object would additionally be
 * irreversible and could strip an image still shown elsewhere.
 *
 * There is no orphan-sweep mechanism in this codebase to hand the asset to, so
 * nothing is invented here: the row goes, the asset stays, and Phase 4F adds no
 * destructive media path.
 *
 * Line numbers are not closed up afterwards. Deleting line 2 of three leaves 1
 * and 3, which is honest about what happened and keeps every surviving row's
 * identity stable; renumbering would rewrite rows nobody asked to change.
 */
export async function deleteRequirement(
  req: Request,
  actor: AuthenticatedUser,
  leadId: string,
  requirementId: string,
): Promise<void> {
  const existing = await repo.findRequirementForLead(leadId, requirementId);
  if (!existing) throw requirementNotFound();

  const count = await repo.deleteRequirementForLead(leadId, requirementId);
  if (count === 0) throw requirementNotFound();

  await recordAudit(req, {
    action: 'lead.requirement.removed',
    entityType: 'LeadProductRequirement',
    entityId: requirementId,
    actorId: actor.id,
    // The image id is recorded so the audit trail shows which asset was
    // detached — the asset itself is retained, deliberately.
    oldValue: { leadId, imageId: existing.imageId },
  });
}
