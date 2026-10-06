/**
 * Complete the Ideal — Phase 4F, frontend.
 *
 * Two halves. The first exercises `requirement-logic.ts` as real functions:
 * drafts in, payloads out, which is where the rules this form has to get right
 * actually live. The second reads the components as source to prove facts a
 * DOM-less test cannot reach — that the browser computes no volume of its own,
 * that an untouched field is not sent as a change, and that the upload and
 * picker are the existing shared ones rather than new copies.
 *
 * Comments are stripped before the structural assertions, so a test cannot pass
 * on the strength of the prose describing it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIMENSION_UNITS,
  PRODUCT_MATCH_KINDS,
  WEIGHT_UNITS,
  formatVolume,
  leadProductRequirementSchema,
  updateLeadRequirementSchema,
  volume,
  type LeadRequirementView,
} from '@rs/shared';
import {
  createPayload,
  draftErrors,
  draftOf,
  emptyDraft,
  hasChanges,
  isValid,
  previewVolume,
  summaryOf,
  updatePayload,
  type RequirementDraft,
} from '@/components/leads/requirement-logic';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const codeOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const card = read('components/leads/requirement-card.tsx');
const section = read('components/leads/complete-the-ideal.tsx');
const logic = read('components/leads/requirement-logic.ts');
const detail = read('app/(app)/leads/[id]/page.tsx');
const actions = read('app/(app)/leads/actions.ts');
const table = read('components/leads/lead-table.tsx');

/** A requirement as the API reports one. */
const view = (over: Partial<LeadRequirementView> = {}): LeadRequirementView =>
  ({
    id: 'cuikreq0000000000000000001',
    lineNo: 1,
    productName: 'Brass dinner set',
    image: null,
    rsProduct: null,
    matchKind: null,
    quantity: 5,
    weight: null,
    dimension: null,
    volume: null,
    productValue: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...over,
  }) as LeadRequirementView;

const draft = (over: Partial<RequirementDraft> = {}): RequirementDraft => ({
  ...emptyDraft(),
  productName: 'Brass dinner set',
  quantity: '5',
  ...over,
});

const product = { id: 'cuikprod000000000000000001', title: 'Brass Thali', sku: 'BT-1', imageUrl: null };

// ---------------------------------------------------------------------------
//  Quantity
// ---------------------------------------------------------------------------

describe('quantity validation', () => {
  it('accepts a positive whole number', () => {
    expect(draftErrors(draft({ quantity: '12' })).quantity).toBeUndefined();
  });

  it('refuses zero and negatives', () => {
    expect(draftErrors(draft({ quantity: '0' })).quantity).toBeTruthy();
    expect(draftErrors(draft({ quantity: '-3' })).quantity).toBeTruthy();
  });

  it('refuses a fraction', () => {
    expect(draftErrors(draft({ quantity: '2.5' })).quantity).toBe('Quantity must be a whole number');
  });

  it('refuses an empty quantity rather than defaulting it to zero', () => {
    // `Number('')` is 0, which would pass a naive positive check as a silent
    // zero. An empty field is "not given", not "none".
    expect(draftErrors(draft({ quantity: '' })).quantity).toBe('Quantity is required');
  });

  it('starts a new requirement at one, not zero or blank', () => {
    expect(emptyDraft().quantity).toBe('1');
  });
});

// ---------------------------------------------------------------------------
//  Product name
// ---------------------------------------------------------------------------

describe('product name', () => {
  it('is required', () => {
    expect(draftErrors(draft({ productName: '' })).productName).toBeTruthy();
    expect(draftErrors(draft({ productName: '   ' })).productName).toBeTruthy();
  });

  it('is trimmed into the payload', () => {
    expect(createPayload(draft({ productName: '  Brass set  ' })).productName).toBe('Brass set');
  });

  it('survives a catalogue match rather than being replaced by the title', () => {
    const payload = createPayload(
      draft({ productName: 'Big brass thali for weddings', product, matchKind: 'EXACT' }),
    );
    expect(payload.productName).toBe('Big brass thali for weddings');
    expect(payload.productName).not.toBe(product.title);
  });
});

// ---------------------------------------------------------------------------
//  Exact vs similar
// ---------------------------------------------------------------------------

describe('exact and similar', () => {
  it('offers exactly the two kinds the schema knows', () => {
    expect([...PRODUCT_MATCH_KINDS]).toEqual(['EXACT', 'SIMILAR']);
  });

  it('accepts either kind with a product', () => {
    for (const matchKind of PRODUCT_MATCH_KINDS) {
      expect(draftErrors(draft({ product, matchKind })).product).toBeUndefined();
    }
  });

  it('refuses a kind with no product', () => {
    for (const matchKind of PRODUCT_MATCH_KINDS) {
      expect(draftErrors(draft({ matchKind })).product).toBeTruthy();
    }
  });

  it('accepts no match at all', () => {
    const errors = draftErrors(draft());
    expect(errors.product).toBeUndefined();
    const payload = createPayload(draft());
    expect(payload.rsProductId).toBeUndefined();
    expect(payload.matchKind).toBeUndefined();
  });

  it('never sends a kind without the product it describes', () => {
    // Even if state somehow held one, the payload drops it rather than letting
    // the database's CHECK constraint turn it into a 500.
    const payload = createPayload(draft({ matchKind: 'EXACT', product: null }));
    expect(payload.matchKind).toBeUndefined();
  });

  it('sends both when both are present', () => {
    const payload = createPayload(draft({ product, matchKind: 'SIMILAR' }));
    expect(payload.rsProductId).toBe(product.id);
    expect(payload.matchKind).toBe('SIMILAR');
  });

  it('clears the kind in the patch when the product is cleared', () => {
    const original = view({ rsProduct: product, matchKind: 'EXACT' });
    const patch = updatePayload(original, draft({ product: null, matchKind: null }));
    expect(patch.rsProductId).toBeNull();
    expect(patch.matchKind).toBeNull();
  });

  it('moves product and kind together when the product changes', () => {
    const original = view({ rsProduct: product, matchKind: 'EXACT' });
    const other = { ...product, id: 'cuikprod000000000000000002' };
    const patch = updatePayload(original, draft({ product: other, matchKind: 'EXACT' }));
    expect(patch.rsProductId).toBe(other.id);
    expect(patch.matchKind).toBe('EXACT');
  });

  it('disables the kind buttons until a product is chosen', () => {
    const code = codeOf(card);
    expect(code).toContain('draft.product === null');
    expect(code).toContain('aria-pressed');
  });

  it('labels them as the brief does', () => {
    const code = codeOf(card);
    expect(code).toContain('Exact Product');
    expect(code).toContain('Similar Product');
  });

  it('clears the kind in the card when the product is unpicked', () => {
    expect(codeOf(card)).toContain('matchKind: product === null ? null : d.matchKind');
  });
});

// ---------------------------------------------------------------------------
//  Product value
// ---------------------------------------------------------------------------

describe('product value', () => {
  it('permits zero', () => {
    expect(draftErrors(draft({ productValue: '0' })).productValue).toBeUndefined();
    expect(createPayload(draft({ productValue: '0' })).productValue).toBe(0);
  });

  it('refuses a negative figure', () => {
    expect(draftErrors(draft({ productValue: '-1' })).productValue).toBeTruthy();
  });

  it('omits it when blank, rather than sending zero', () => {
    // Unpriced and worth nothing are different facts.
    expect(createPayload(draft({ productValue: '' })).productValue).toBeUndefined();
  });

  it('is never taken from the matched product price', () => {
    const payload = createPayload(draft({ product, matchKind: 'EXACT' }));
    expect(payload.productValue).toBeUndefined();
  });

  it('is described as the requirement value, not the catalogue price', () => {
    expect(card).toContain('not the catalogue price');
  });
});

// ---------------------------------------------------------------------------
//  Weight
// ---------------------------------------------------------------------------

describe('weight', () => {
  it('offers the project vocabulary and invents no unit', () => {
    expect([...WEIGHT_UNITS]).toEqual(['G', 'KG', 'LB']);
    expect(codeOf(card)).toContain('WEIGHT_UNITS.map');
  });

  it('requires a unit beside a figure', () => {
    expect(draftErrors(draft({ weightValue: '5', weightUnit: '' })).weightUnit).toBeTruthy();
  });

  it('refuses a non-positive figure', () => {
    expect(draftErrors(draft({ weightValue: '0', weightUnit: 'KG' })).weightValue).toBeTruthy();
    expect(draftErrors(draft({ weightValue: '-2', weightUnit: 'KG' })).weightValue).toBeTruthy();
  });

  it('is optional', () => {
    expect(isValid(draft())).toBe(true);
    expect(createPayload(draft()).weightValue).toBeUndefined();
  });

  it('sends the pair together', () => {
    const payload = createPayload(draft({ weightValue: '2.5', weightUnit: 'KG' }));
    expect(payload.weightValue).toBe(2.5);
    expect(payload.weightUnit).toBe('KG');
  });

  it('sends no normalised gram figure — the backend derives that', () => {
    const payload = createPayload(draft({ weightValue: '2.5', weightUnit: 'KG' })) as Record<
      string,
      unknown
    >;
    expect(payload.weightInGrams).toBeUndefined();
  });

  it('clears both halves together in a patch', () => {
    const original = view({ weight: { value: '2', unit: 'KG', inGrams: '2000' } });
    const patch = updatePayload(original, draft({ weightValue: '', weightUnit: '' }));
    expect(patch.weightValue).toBeNull();
    expect(patch.weightUnit).toBeNull();
  });

  it('resends the value when only the unit changed, so grams renormalise', () => {
    const original = view({ weight: { value: '2', unit: 'KG', inGrams: '2000' } });
    const patch = updatePayload(original, draft({ weightValue: '2', weightUnit: 'G' }));
    expect(patch.weightUnit).toBe('G');
    expect(patch.weightValue).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  Dimensions and the volume preview
// ---------------------------------------------------------------------------

describe('dimensions', () => {
  it('offers the project vocabulary', () => {
    expect([...DIMENSION_UNITS]).toEqual(['MM', 'CM', 'IN', 'FT']);
    expect(codeOf(card)).toContain('DIMENSION_UNITS.map');
  });

  it('requires a unit when any figure is given', () => {
    expect(draftErrors(draft({ lengthValue: '20' })).dimensionUnit).toBeTruthy();
  });

  it('refuses a non-positive figure', () => {
    expect(draftErrors(draft({ lengthValue: '0', dimensionUnit: 'CM' })).lengthValue).toBeTruthy();
    expect(draftErrors(draft({ widthValue: '-1', dimensionUnit: 'CM' })).widthValue).toBeTruthy();
  });

  it('is optional', () => {
    expect(isValid(draft())).toBe(true);
  });

  it('offers three labelled inputs', () => {
    const code = codeOf(card);
    for (const field of ['lengthValue', 'widthValue', 'heightValue']) {
      expect(code, field).toContain(field);
    }
    expect(code).toContain('dimension`}');
  });

  it('sends no normalised millimetre columns', () => {
    const payload = createPayload(
      draft({ lengthValue: '20', widthValue: '10', heightValue: '5', dimensionUnit: 'CM' }),
    ) as Record<string, unknown>;
    expect(payload.lengthMm).toBeUndefined();
    expect(payload.widthMm).toBeUndefined();
    expect(payload.heightMm).toBeUndefined();
  });
});

describe('the volume preview', () => {
  it('derives 20 × 10 × 5 cm as 1000 cm³', () => {
    const v = previewVolume(
      draft({ lengthValue: '20', widthValue: '10', heightValue: '5', dimensionUnit: 'CM' }),
    );
    expect(v).not.toBeNull();
    expect(v!.value).toBe(1000);
    expect(v!.unit).toBe('CM');
  });

  it('derives 2 × 3 × 4 cm as 24 cm³', () => {
    const v = previewVolume(
      draft({ lengthValue: '2', widthValue: '3', heightValue: '4', dimensionUnit: 'CM' }),
    );
    expect(v!.value).toBe(24);
  });

  it('is null while a dimension is missing', () => {
    expect(
      previewVolume(draft({ lengthValue: '20', heightValue: '5', dimensionUnit: 'CM' })),
    ).toBeNull();
  });

  it('is null before a unit is chosen', () => {
    expect(
      previewVolume(draft({ lengthValue: '20', widthValue: '10', heightValue: '5' })),
    ).toBeNull();
  });

  it('is null rather than zero for an invalid figure', () => {
    expect(
      previewVolume(
        draft({ lengthValue: '0', widthValue: '10', heightValue: '5', dimensionUnit: 'CM' }),
      ),
    ).toBeNull();
  });

  it('agrees exactly with the shared calculation the API uses', () => {
    /*
      The whole point of putting `volume()` in @rs/shared: the figure somebody
      watches while typing is the figure that comes back when they save, because
      it is literally the same function.
    */
    const d = draft({ lengthValue: '7', widthValue: '3', heightValue: '2', dimensionUnit: 'IN' });
    expect(previewVolume(d)).toEqual(
      volume({ length: 7, width: 3, height: 2, unit: 'IN' }),
    );
  });

  it('formats through the shared formatter', () => {
    const v = volume({ length: 20, width: 10, height: 5, unit: 'CM' })!;
    expect(formatVolume(v)).toBe('1000 cm³');
  });

  it('multiplies nothing in the browser — it calls the shared helper', () => {
    const code = codeOf(logic) + codeOf(card);
    expect(code).toContain('volume(');
    // No local formula and no local conversion table.
    expect(code).not.toMatch(/length\s*\*\s*width\s*\*\s*height/);
    expect(code).not.toContain('25.4');
    expect(code).not.toContain('304.8');
  });

  it('is labelled as derived, so nobody reads it as an entry field', () => {
    expect(codeOf(card)).toContain('derived');
  });

  it('explains itself while incomplete rather than showing a wrong figure', () => {
    expect(card).toContain('Enter length, width, height and a unit');
  });
});

// ---------------------------------------------------------------------------
//  The patch diff
// ---------------------------------------------------------------------------

describe('editing sends only what changed', () => {
  it('sends nothing for an untouched draft', () => {
    const original = view({ quantity: 5, productName: 'Brass dinner set' });
    expect(updatePayload(original, draftOf(original))).toEqual({});
    expect(hasChanges(original, draftOf(original))).toBe(false);
  });

  it('sends one field when one field changed', () => {
    const original = view({ quantity: 5 });
    const patch = updatePayload(original, draft({ quantity: '9' }));
    expect(patch).toEqual({ quantity: 9 });
  });

  it('does not rewrite the weight when only the quantity moved', () => {
    /*
      The reason this is a diff rather than a whole-row send: an edit to one
      field must not clobber a concurrent change to another.
    */
    const original = view({
      quantity: 5,
      weight: { value: '2', unit: 'KG', inGrams: '2000' },
    });
    const patch = updatePayload(original, { ...draftOf(original), quantity: '6' });
    expect(patch).toEqual({ quantity: 6 });
    expect(patch).not.toHaveProperty('weightValue');
  });

  it('distinguishes clearing a field from not touching it', () => {
    const original = view({ productValue: '500' });
    expect(updatePayload(original, draftOf(original))).toEqual({});
    expect(updatePayload(original, { ...draftOf(original), productValue: '' })).toEqual({
      productValue: null,
    });
  });

  it('clears the dimension unit only when the whole box goes', () => {
    const original = view({
      dimension: { length: '20', width: '10', height: '5', unit: 'CM' },
    });

    // One dimension removed: the unit stays, because two figures remain.
    const partial = updatePayload(original, { ...draftOf(original), widthValue: '' });
    expect(partial.widthValue).toBeNull();
    expect(partial.dimensionUnit).toBe('CM');

    // All three removed: the unit goes too.
    const whole = updatePayload(original, {
      ...draftOf(original),
      lengthValue: '',
      widthValue: '',
      heightValue: '',
    });
    expect(whole.dimensionUnit).toBeNull();
  });

  it('never sends leadId or lineNo', () => {
    const original = view();
    const patch = updatePayload(original, draft({ quantity: '7' })) as Record<string, unknown>;
    expect(patch.leadId).toBeUndefined();
    expect(patch.lineNo).toBeUndefined();
  });

  it('produces a patch the shared schema accepts', () => {
    const original = view({ quantity: 5 });
    const patch = updatePayload(original, draft({ quantity: '9' }));
    expect(updateLeadRequirementSchema.safeParse(patch).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Payloads match the shared contracts
// ---------------------------------------------------------------------------

describe('payloads satisfy the shared schemas', () => {
  it('a minimal create passes', () => {
    const result = leadProductRequirementSchema.safeParse(createPayload(draft()));
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('a fully populated create passes', () => {
    const payload = createPayload(
      draft({
        product,
        matchKind: 'SIMILAR',
        imageId: 'cuikimg0000000000000000001',
        quantity: '12',
        weightValue: '2.5',
        weightUnit: 'KG',
        lengthValue: '20',
        widthValue: '10',
        heightValue: '5',
        dimensionUnit: 'CM',
        productValue: '24500.50',
      }),
    );
    const result = leadProductRequirementSchema.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('a create carrying an invalid draft is refused by the schema too', () => {
    // The form and the contract agree about what is wrong.
    const bad = createPayload(draft({ quantity: '0' }));
    expect(leadProductRequirementSchema.safeParse(bad).success).toBe(false);
    expect(isValid(draft({ quantity: '0' }))).toBe(false);
  });

  it('never sends lineNo on create — the backend assigns it', () => {
    const payload = createPayload(draft()) as Record<string, unknown>;
    expect(payload.lineNo).toBeUndefined();
    expect(codeOf(logic)).not.toContain('lineNo:');
  });
});

// ---------------------------------------------------------------------------
//  The image
// ---------------------------------------------------------------------------

describe('the requirement image', () => {
  it('reuses the existing upload field rather than a second uploader', () => {
    const code = codeOf(card);
    expect(code).toContain('ImageUploadField');
    expect(code).toContain('product-enquiry/image-upload-field');
    // No Cloudinary call, no new form post, no second accept list.
    expect(code).not.toContain('cloudinary');
    expect(code).not.toContain('FormData');
    expect(code).not.toContain('image/jpeg');
  });

  it('inherits upload, preview, replace and remove from that field', () => {
    const upload = codeOf(read('components/product-enquiry/image-upload-field.tsx'));
    expect(upload).toContain('Replace image');
    expect(upload).toContain('Remove image');
    expect(upload).toContain("status: 'uploading'");
    expect(upload).toContain("status: 'error'");
  });

  it('sends an asset id, never a raw URL', () => {
    const payload = createPayload(draft({ imageId: 'cuikimg0000000000000000001' }));
    expect(payload.imageId).toBe('cuikimg0000000000000000001');
    expect(JSON.stringify(payload)).not.toContain('http');
  });

  it('is optional', () => {
    expect(createPayload(draft()).imageId).toBeUndefined();
    expect(emptyDraft().imageId).toBeNull();
  });

  it('removes the reference as an explicit null', () => {
    const original = view({
      image: { id: 'cuikimg0000000000000000001', secureUrl: 'https://x/y.jpg', publicId: 'y' },
    });
    const patch = updatePayload(original, { ...draftOf(original), imageId: null });
    expect(patch.imageId).toBeNull();
  });

  it('never deletes the asset itself from the browser', () => {
    const code = codeOf(card) + codeOf(section) + codeOf(actions);
    expect(code).not.toContain('/api/proxy/uploads/');
    expect(code).not.toMatch(/mediaAsset|deleteAsset/i);
  });

  it('keeps the requirement photo separate from the catalogue image', () => {
    const code = codeOf(card);
    // Two different pictures, drawn from two different fields.
    expect(code).toContain('draft.imageId');
    expect(code).toContain('product.imageUrl');
  });
});

// ---------------------------------------------------------------------------
//  The product picker
// ---------------------------------------------------------------------------

describe('the product picker', () => {
  it('reuses the shared RS Products picker', () => {
    expect(codeOf(card)).toContain('RsProductPicker');
    expect(codeOf(card)).toContain('components/products/rs-product-picker');
  });

  it('searches on the server rather than loading the catalogue', () => {
    const picker = codeOf(read('components/products/rs-product-picker.tsx'));
    expect(picker).toContain('/api/proxy/rs-products?');
    expect(picker).toContain('limit:');
    // 500+ products are never shipped to the browser to be filtered locally.
    expect(picker).not.toContain('limit: 1000');
  });

  it('inherits debounce, loading, empty and denied states', () => {
    const picker = codeOf(read('components/products/rs-product-picker.tsx'));
    expect(picker).toContain('DEBOUNCE_MS');
    expect(picker).toContain('setDenied');
    expect(picker).toContain('CommandEmpty');
    expect(picker).toContain('Loader2');
  });

  it('shows title, SKU and image so products can be told apart', () => {
    const picker = codeOf(read('components/products/rs-product-picker.tsx'));
    expect(picker).toContain('sku');
    expect(picker).toContain('imageUrl');
    expect(picker).toContain('title');
  });

  it('adds no debounce dependency of its own', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain('lodash.debounce');
    expect(Object.keys(pkg.dependencies)).not.toContain('use-debounce');
  });

  it('allows the selection to be cleared', () => {
    expect(codeOf(card)).toContain('product === null');
  });
});

// ---------------------------------------------------------------------------
//  Multiple requirements
// ---------------------------------------------------------------------------

describe('multiple requirements', () => {
  it('renders every requirement, keyed by id', () => {
    const code = codeOf(section);
    expect(code).toContain('requirements.map');
    expect(code).toContain('key={requirement.id}');
  });

  it('adds a new one beside the existing list rather than replacing it', () => {
    const code = codeOf(section);
    // The add form is its own card, outside the list of existing ones.
    expect(code).toContain('adding');
    expect(code).toContain('setAdding(true)');
    expect(code).toContain('requirements.length > 0');
  });

  it('edits one line at a time, by id', () => {
    const code = codeOf(section);
    expect(code).toContain('editing === requirement.id');
    expect(code).toContain('setEditing(requirement.id)');
  });

  it('shows the line number so three requirements are distinguishable', () => {
    expect(codeOf(section)).toContain('requirement.lineNo');
  });

  it('summarises a line from the figures the API derived', () => {
    const summary = summaryOf(
      view({
        quantity: 5,
        weight: { value: '2', unit: 'KG', inGrams: '2000' },
        dimension: { length: '20', width: '10', height: '5', unit: 'CM' },
        volume: { value: '1000', unit: 'CM', inCubicMm: '1000000' },
      }),
    );
    expect(summary).toEqual(['Qty 5', '2 kg', '20 × 10 × 5 cm', '1000 cm³']);
  });

  it('summarises a bare line without inventing figures', () => {
    expect(summaryOf(view({ quantity: 10 }))).toEqual(['Qty 10']);
  });

  it('reads volume from the response rather than recomputing it', () => {
    // A card and the form beneath it must not disagree about the same box.
    expect(codeOf(logic)).toContain('requirement.volume');
  });
});

// ---------------------------------------------------------------------------
//  States
// ---------------------------------------------------------------------------

describe('loading, empty and error states', () => {
  it('has an empty state that says what to do', () => {
    const code = codeOf(section);
    expect(code).toContain('No requirements captured yet');
  });

  it('tells a read-only viewer why there is no add button', () => {
    expect(section).toContain('do not have permission to add requirements');
  });

  it('has a loading skeleton for the detail page', () => {
    const loading = codeOf(read('app/(app)/leads/[id]/loading.tsx'));
    expect(loading).toContain('Skeleton');
  });

  it('shows a saving state while a write is in flight', () => {
    const code = codeOf(card);
    expect(code).toContain('useTransition');
    expect(code).toContain('animate-spin');
    expect(code).toContain('disabled={');
  });

  it('shows the API message on failure rather than inventing one', () => {
    const code = codeOf(card);
    expect(code).toContain('setError(result.message)');
    expect(code).toContain('role="alert"');
  });

  it('places a field error where the API said the problem was', () => {
    expect(codeOf(card)).toContain('result.details');
  });

  it('refuses to submit a draft it knows is invalid', () => {
    expect(codeOf(card)).toContain('isValid(draft)');
  });

  it('refuses an unchanged save', () => {
    expect(codeOf(card)).toContain('hasChanges(requirement, draft)');
  });
});

// ---------------------------------------------------------------------------
//  The detail page
// ---------------------------------------------------------------------------

describe('the lead detail page', () => {
  it('gates on LEAD_DEAL', () => {
    const code = codeOf(detail);
    expect(code).toContain("requireModule('LEAD_DEAL')");
    expect(code).toContain('NoModuleAccess');
  });

  it('decides the write permission from the matrix, not the role', () => {
    const code = codeOf(detail);
    expect(code).toContain("can(access.user, 'LEAD_DEAL', 'EDIT')");
    expect(code).not.toContain("role === 'ADMIN'");
  });

  it('hosts Complete the Ideal', () => {
    expect(codeOf(detail)).toContain('CompleteTheIdeal');
  });

  it('passes the requirements that came with the lead', () => {
    // Not a second fetch: they arrive on the detail read.
    const code = codeOf(detail);
    expect(code).toContain('requirements={lead.requirements}');
    expect(code).not.toContain('fetchRequirements');
  });

  it('reads the lead through the one typed reader, and nothing else', () => {
    /*
      `fetchLead` appears twice — once in `generateMetadata`, once in the page —
      which Next.js dedupes into a single request per render. What matters is
      that there is no second endpoint: no per-requirement read, no per-product
      read, no raw apiFetch alongside it.
    */
    const code = codeOf(detail);
    expect(code).toContain('await fetchLead(id)');
    expect(code).not.toContain('apiFetch(');
    expect(code).not.toContain('/requirements');
    expect(code).not.toContain('rs-products');
  });

  it('handles not-found and error separately', () => {
    const code = codeOf(detail);
    expect(code).toContain("result.code === 'LEAD_NOT_FOUND'");
    expect(code).toContain('notFound()');
    expect(code).toContain('ErrorMessage');
  });

  it('is reachable from the analytics board', () => {
    expect(codeOf(table)).toContain('href={`/leads/${lead.id}`}');
  });

  it('links back to the board', () => {
    expect(codeOf(detail)).toContain('href="/leads"');
  });
});

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------

describe('Phase 4F stays in its lane', () => {
  it('creates no order and touches no stock', () => {
    const code = codeOf(card) + codeOf(section) + codeOf(actions) + codeOf(detail);
    for (const absent of [
      'salesOrder',
      'SalesOrder',
      'crmStockQty',
      'inventoryQty',
      'allocation/',
      'dispatch',
    ]) {
      expect(code, absent).not.toContain(absent);
    }
  });

  it('introduces no new permission vocabulary', () => {
    const code = codeOf(card) + codeOf(section) + codeOf(actions) + codeOf(detail);

    /*
      LEAD_DEAL is the only module these files name, and EDIT the only capability
      they check. Matched as quoted module literals rather than bare words, so
      `REQUIREMENT_TYPE_LABELS` — a Phase 1 lead field, not a permission — does
      not read as an invented module.
    */
    const checks = [...code.matchAll(/can\([^,]+,\s*'([A-Z_]+)'\s*,\s*'([A-Z_]+)'\)/g)];
    // LEAD_DEAL only, and only its own capabilities. Two now: EDIT for the
    // work, ASSIGN for allocation — separate on purpose.
    expect(new Set(checks.map((m) => m[1]))).toEqual(new Set(['LEAD_DEAL']));
    expect(new Set(checks.map((m) => m[2]))).toEqual(new Set(['EDIT', 'ASSIGN']));

    for (const invented of ['LEAD_REQUIREMENT', "'REQUIREMENT'", 'PRODUCT_REQUIREMENT']) {
      expect(code, invented).not.toContain(invented);
    }
  });

  it('scopes every requirement call under its lead', () => {
    const code = codeOf(actions);
    for (const path of [
      '`/api/leads/${leadId}/requirements`',
      '`/api/leads/${leadId}/requirements/${requirementId}`',
    ]) {
      expect(code, path).toContain(path);
    }
  });

  it('computes no business figure in an action', () => {
    const code = codeOf(actions);
    expect(code).not.toContain('volume(');
    expect(code).not.toMatch(/\*\s*quantity/);
  });

  it('leaves the Phase 4E analytics row shape alone', () => {
    const code = codeOf(table);
    // Order Value is still the linked order's, never a requirement's.
    expect(code).toContain('lead.orderValue');
    expect(code).not.toContain('productValue');
    expect(code).not.toContain('requirements');
  });
});
