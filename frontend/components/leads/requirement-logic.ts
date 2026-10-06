import type {
  DimensionUnit,
  LeadProductRequirementInput,
  LeadRequirementView,
  ProductMatchKind,
  UpdateLeadRequirementInput,
  WeightUnit,
} from '@rs/shared';
import { volume } from '@rs/shared';

/**
 * The pure half of Complete the Ideal.
 *
 * Form state in, API payload out, with no React and no DOM — which is what lets
 * the frontend test suite assert the rules this form has to get right without
 * rendering anything.
 *
 * **Nothing here decides a business outcome.** The backend is the authority on
 * the match-kind pairing, the quantity rule and the value rule; these functions
 * exist so the form can show somebody their mistake before they submit it, and
 * so an unchanged field is not sent as a change.
 */

/** What the form holds while being typed into. Strings, because inputs are. */
export type RequirementDraft = {
  productName: string;
  imageId: string | null;
  product: { id: string; title: string; sku: string | null; imageUrl: string | null } | null;
  matchKind: ProductMatchKind | null;
  quantity: string;
  weightValue: string;
  weightUnit: WeightUnit | '';
  lengthValue: string;
  widthValue: string;
  heightValue: string;
  dimensionUnit: DimensionUnit | '';
  productValue: string;
};

export const emptyDraft = (): RequirementDraft => ({
  productName: '',
  imageId: null,
  product: null,
  matchKind: null,
  quantity: '1',
  weightValue: '',
  weightUnit: '',
  lengthValue: '',
  widthValue: '',
  heightValue: '',
  dimensionUnit: '',
  productValue: '',
});

/** An existing requirement, as the form needs to edit it. */
export function draftOf(requirement: LeadRequirementView): RequirementDraft {
  return {
    productName: requirement.productName,
    imageId: requirement.image?.id ?? null,
    product: requirement.rsProduct,
    matchKind: requirement.matchKind,
    quantity: String(requirement.quantity),
    weightValue: requirement.weight?.value ?? '',
    weightUnit: requirement.weight?.unit ?? '',
    lengthValue: requirement.dimension?.length ?? '',
    widthValue: requirement.dimension?.width ?? '',
    heightValue: requirement.dimension?.height ?? '',
    dimensionUnit: requirement.dimension?.unit ?? '',
    productValue: requirement.productValue ?? '',
  };
}

/** An empty input is absent, not zero — `Number('')` is 0 and would lie. */
const num = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
};

/** The same, but for the volume preview, which wants null for "not yet". */
const orNull = (text: string): number | null => num(text) ?? null;

/**
 * The live volume preview.
 *
 * Calls the shared `volume()` — the identical function the API derives its own
 * figure with — so the number somebody watches while typing is the number that
 * comes back when they save. The browser multiplies nothing itself.
 *
 * Null until all three dimensions and a unit are present, which is what makes
 * the preview go quiet rather than flicker through wrong figures mid-entry.
 */
export function previewVolume(draft: RequirementDraft) {
  return volume({
    length: orNull(draft.lengthValue),
    width: orNull(draft.widthValue),
    height: orNull(draft.heightValue),
    unit: draft.dimensionUnit === '' ? null : draft.dimensionUnit,
  });
}

/**
 * What is wrong with this draft, in the field somebody can fix.
 *
 * A mirror of the shared schema, not a replacement for it: the API validates
 * every one of these again and is the only authority. Checked here so the form
 * can refuse to submit something it already knows will come back 422.
 */
export function draftErrors(draft: RequirementDraft): Record<string, string> {
  const errors: Record<string, string> = {};

  if (draft.productName.trim() === '') {
    errors.productName = 'Product name is required';
  }

  const quantity = num(draft.quantity);
  if (quantity === undefined) {
    errors.quantity = 'Quantity is required';
  } else if (!Number.isInteger(quantity)) {
    errors.quantity = 'Quantity must be a whole number';
  } else if (quantity < 1) {
    errors.quantity = 'Quantity must be at least one';
  }

  // A match kind describes a matched product, so the two travel together.
  if (draft.matchKind !== null && draft.product === null) {
    errors.product = 'Choose the catalogue product this matches';
  }

  const weight = num(draft.weightValue);
  if (weight !== undefined && weight <= 0) {
    errors.weightValue = 'Weight must be greater than zero';
  }
  if (weight !== undefined && draft.weightUnit === '') {
    errors.weightUnit = 'Choose a weight unit';
  }

  for (const [field, label] of [
    ['lengthValue', 'Length'],
    ['widthValue', 'Width'],
    ['heightValue', 'Height'],
  ] as const) {
    const value = num(draft[field]);
    if (value !== undefined && value <= 0) {
      errors[field] = `${label} must be greater than zero`;
    }
  }

  const anyDimension =
    num(draft.lengthValue) !== undefined ||
    num(draft.widthValue) !== undefined ||
    num(draft.heightValue) !== undefined;
  if (anyDimension && draft.dimensionUnit === '') {
    errors.dimensionUnit = 'Choose a dimension unit';
  }

  const value = num(draft.productValue);
  if (value !== undefined && value < 0) {
    errors.productValue = 'Product value cannot be negative';
  }

  return errors;
}

export const isValid = (draft: RequirementDraft): boolean =>
  Object.keys(draftErrors(draft)).length === 0;

/**
 * The create payload.
 *
 * Optional fields are omitted rather than sent as null, because the create
 * contract treats absence as "not given" and has no null branch. `lineNo` is
 * never included: the backend assigns it, and a client-supplied one is ignored.
 */
export function createPayload(draft: RequirementDraft): LeadProductRequirementInput {
  const payload: Record<string, unknown> = {
    productName: draft.productName.trim(),
    quantity: num(draft.quantity),
  };

  if (draft.imageId) payload.imageId = draft.imageId;
  if (draft.product) payload.rsProductId = draft.product.id;
  if (draft.matchKind && draft.product) payload.matchKind = draft.matchKind;

  const weight = num(draft.weightValue);
  if (weight !== undefined && draft.weightUnit !== '') {
    payload.weightValue = weight;
    payload.weightUnit = draft.weightUnit;
  }

  const length = num(draft.lengthValue);
  const width = num(draft.widthValue);
  const height = num(draft.heightValue);
  if (draft.dimensionUnit !== '') {
    if (length !== undefined) payload.lengthValue = length;
    if (width !== undefined) payload.widthValue = width;
    if (height !== undefined) payload.heightValue = height;
    if (length !== undefined || width !== undefined || height !== undefined) {
      payload.dimensionUnit = draft.dimensionUnit;
    }
  }

  const value = num(draft.productValue);
  if (value !== undefined) payload.productValue = value;

  return payload as LeadProductRequirementInput;
}

/**
 * The patch payload — only what actually changed.
 *
 * Three states carry three meanings, and the difference is the whole reason this
 * is a diff rather than a whole-row send:
 *
 *   absent   leave it alone
 *   null     clear it
 *   value    set it
 *
 * So a field somebody emptied becomes an explicit null, and a field they never
 * touched is not in the object at all. Sending the whole draft every time would
 * mean an edit to the quantity also rewrote the weight, the image and the match —
 * and would clobber a concurrent change to any of them.
 */
export function updatePayload(
  original: LeadRequirementView,
  draft: RequirementDraft,
): UpdateLeadRequirementInput {
  const patch: Record<string, unknown> = {};
  const before = draftOf(original);

  if (draft.productName.trim() !== before.productName.trim()) {
    patch.productName = draft.productName.trim();
  }

  const quantity = num(draft.quantity);
  if (quantity !== undefined && quantity !== original.quantity) {
    patch.quantity = quantity;
  }

  if (draft.imageId !== before.imageId) {
    patch.imageId = draft.imageId;
  }

  /*
    The product and its kind move together whenever either did. Patching only
    the one that changed could leave a kind pointing at a product the same edit
    removed — a row the database's CHECK constraint would refuse.
  */
  const productId = draft.product?.id ?? null;
  const beforeProductId = before.product?.id ?? null;
  if (productId !== beforeProductId || draft.matchKind !== before.matchKind) {
    patch.rsProductId = productId;
    patch.matchKind = productId === null ? null : draft.matchKind;
  }

  const weight = num(draft.weightValue) ?? null;
  const beforeWeight = num(before.weightValue) ?? null;
  const unit = draft.weightUnit === '' ? null : draft.weightUnit;
  const beforeUnit = before.weightUnit === '' ? null : before.weightUnit;
  if (weight !== beforeWeight || unit !== beforeUnit) {
    patch.weightValue = weight;
    patch.weightUnit = weight === null ? null : unit;
  }

  const dims = (['lengthValue', 'widthValue', 'heightValue'] as const).map((field) => ({
    field,
    now: num(draft[field]) ?? null,
    was: num(before[field]) ?? null,
  }));
  const dimUnit = draft.dimensionUnit === '' ? null : draft.dimensionUnit;
  const beforeDimUnit = before.dimensionUnit === '' ? null : before.dimensionUnit;

  if (dims.some((d) => d.now !== d.was) || dimUnit !== beforeDimUnit) {
    for (const d of dims) patch[d.field] = d.now;
    // The unit goes only if some dimension survives; otherwise the whole box is
    // being cleared and the unit goes with it.
    patch.dimensionUnit = dims.every((d) => d.now === null) ? null : dimUnit;
  }

  const value = num(draft.productValue) ?? null;
  const beforeValue = num(before.productValue) ?? null;
  if (value !== beforeValue) {
    patch.productValue = value;
  }

  return patch as UpdateLeadRequirementInput;
}

/** Whether a patch would change anything, so an untouched Save can be refused. */
export const hasChanges = (
  original: LeadRequirementView,
  draft: RequirementDraft,
): boolean => Object.keys(updatePayload(original, draft)).length > 0;

/**
 * The summary line a collapsed requirement card shows.
 *
 * Reads the figures the API derived; it recomputes nothing. Volume in particular
 * comes from the response, so a card and the expanded form beneath it cannot
 * disagree about the size of the same box.
 */
export function summaryOf(requirement: LeadRequirementView): string[] {
  const parts = [`Qty ${requirement.quantity}`];

  if (requirement.weight) {
    parts.push(`${requirement.weight.value} ${requirement.weight.unit.toLowerCase()}`);
  }
  if (requirement.dimension) {
    const d = requirement.dimension;
    parts.push(`${d.length} × ${d.width} × ${d.height} ${d.unit.toLowerCase()}`);
  }
  if (requirement.volume) {
    parts.push(`${requirement.volume.value} ${requirement.volume.unit.toLowerCase()}³`);
  }

  return parts;
}
