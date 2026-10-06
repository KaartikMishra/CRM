/**
 * Lead/Deal analytics — the shared contracts, Phase 4B.
 *
 * Foundation only. These assert the vocabularies the later phases build on, the
 * one pairing rule that is genuinely a contract, and the thresholds the business
 * fixed — nothing about how a score is computed, which is Phase 4D.
 *
 * The thresholds are asserted as values on purpose. They are a business decision
 * the team made, and a test that reads them from the same constant it is
 * checking would prove nothing; these numbers are written out so changing one
 * has to be deliberate.
 */

import { describe, expect, it } from 'vitest';
import {
  DEAL_STATUSES,
  DEAL_STATUS_LABELS,
  LEAD_ACTIVITY_KINDS,
  LEAD_ACTIVITY_KIND_LABELS,
  LEAD_PROMPTNESS_LABELS,
  LEAD_PROMPTNESS_RATINGS,
  LEAD_PROMPTNESS_THRESHOLDS,
  PRODUCT_MATCH_KINDS,
  PRODUCT_MATCH_KIND_LABELS,
  PRODUCT_MATCH_TYPES,
  dealStatusSchema,
  leadActivityKindSchema,
  leadActivitySchema,
  leadProductRequirementSchema,
  productMatchKindSchema,
} from '@rs/shared';

const CUID = 'clx0000000000000000000000';

const requirement = (over: Record<string, unknown> = {}) => ({
  productName: 'Kansa Thali, 10 inch',
  quantity: 5,
  ...over,
});

// ---------------------------------------------------------------------------
//  The vocabularies
// ---------------------------------------------------------------------------

describe('deal status', () => {
  it('is exactly the three the business named', () => {
    expect([...DEAL_STATUSES]).toEqual(['WON', 'LOST', 'INPROCESS']);
  });

  it('has a label for each', () => {
    expect(DEAL_STATUS_LABELS.INPROCESS).toBe('In process');
    expect(DEAL_STATUS_LABELS.WON).toBe('Won');
    expect(DEAL_STATUS_LABELS.LOST).toBe('Lost');
  });

  it('accepts each and refuses anything else', () => {
    for (const status of DEAL_STATUSES) {
      expect(dealStatusSchema.safeParse(status).success, status).toBe(true);
    }
    expect(dealStatusSchema.safeParse('PENDING').success).toBe(false);
    expect(dealStatusSchema.safeParse('').success).toBe(false);
  });
});

describe('lead activity kind', () => {
  it('is exactly the three stages of the workflow', () => {
    expect([...LEAD_ACTIVITY_KINDS]).toEqual(['FIRST_CONTACT', 'FOLLOW_UP', 'RESULT']);
  });

  it('has a label for each', () => {
    expect(LEAD_ACTIVITY_KIND_LABELS.FIRST_CONTACT).toBe('First contact');
    expect(LEAD_ACTIVITY_KIND_LABELS.FOLLOW_UP).toBe('Follow-up');
  });

  it('accepts each and refuses anything else', () => {
    for (const kind of LEAD_ACTIVITY_KINDS) {
      expect(leadActivityKindSchema.safeParse(kind).success, kind).toBe(true);
    }
    expect(leadActivityKindSchema.safeParse('REMINDER').success).toBe(false);
  });
});

describe('product match kind', () => {
  it('is exactly EXACT and SIMILAR', () => {
    expect([...PRODUCT_MATCH_KINDS]).toEqual(['EXACT', 'SIMILAR']);
  });

  it('has no third "unmatched" member', () => {
    // Unmatched is the absence of both the product and the kind, not a value.
    expect(PRODUCT_MATCH_KINDS).toHaveLength(2);
    expect([...PRODUCT_MATCH_KINDS]).not.toContain('NONE');
  });

  it('has a label for each', () => {
    expect(PRODUCT_MATCH_KIND_LABELS.EXACT).toBe('Exact product');
    expect(PRODUCT_MATCH_KIND_LABELS.SIMILAR).toBe('Similar product');
  });

  it('is a separate vocabulary from the vendor-response match type', () => {
    /*
      PRODUCT_MATCH_TYPES already existed, for how a vendor's offering relates to
      an enquiry line. Same idea, different subject and different spelling, so
      they must not be conflated — a test here because the names are one word
      apart.
    */
    expect([...PRODUCT_MATCH_TYPES]).toEqual(['SIMILAR_PRODUCT', 'EXACT_PRODUCT']);
    expect([...PRODUCT_MATCH_KINDS]).not.toEqual([...PRODUCT_MATCH_TYPES]);
  });

  it('accepts each and refuses anything else', () => {
    expect(productMatchKindSchema.safeParse('EXACT').success).toBe(true);
    expect(productMatchKindSchema.safeParse('SIMILAR').success).toBe(true);
    expect(productMatchKindSchema.safeParse('CLOSE_ENOUGH').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Promptness thresholds — the business decision, centralised
// ---------------------------------------------------------------------------

describe('promptness thresholds', () => {
  it('are the bands the business fixed', () => {
    expect(LEAD_PROMPTNESS_THRESHOLDS.GOOD).toBe(0.65);
    expect(LEAD_PROMPTNESS_THRESHOLDS.AVERAGE).toBe(0.5);
  });

  it('leave no gap and no overlap between the bands', () => {
    expect(LEAD_PROMPTNESS_THRESHOLDS.GOOD).toBeGreaterThan(
      LEAD_PROMPTNESS_THRESHOLDS.AVERAGE,
    );
  });

  it('are two thresholds, because NOT_RATED is not a band', () => {
    // "Not measurable" is the absence of a score, not the bottom of the scale.
    expect(Object.keys(LEAD_PROMPTNESS_THRESHOLDS)).toEqual(['GOOD', 'AVERAGE']);
  });

  it('name four ratings, with NOT_RATED a peer of the rest', () => {
    expect([...LEAD_PROMPTNESS_RATINGS]).toEqual(['GOOD', 'AVERAGE', 'POOR', 'NOT_RATED']);
    expect(LEAD_PROMPTNESS_LABELS.NOT_RATED).toBe('Not rated');
  });

  it('classify the worked examples the business gave', () => {
    /*
      Banding only — no score is computed here, which is Phase 4D. These are the
      ratios from the notebook, checked against the thresholds alone.
    */
    const band = (score: number): string =>
      score >= LEAD_PROMPTNESS_THRESHOLDS.GOOD
        ? 'GOOD'
        : score >= LEAD_PROMPTNESS_THRESHOLDS.AVERAGE
          ? 'AVERAGE'
          : 'POOR';

    expect(band(1 / 1)).toBe('GOOD'); // 1.00
    expect(band(3 / 4)).toBe('GOOD'); // 0.75
    expect(band(2 / 3)).toBe('GOOD'); // 0.66
    expect(band(3 / 5)).toBe('AVERAGE'); // 0.60
    expect(band(0.5)).toBe('AVERAGE'); // boundary is inclusive
    expect(band(0.49)).toBe('POOR');
    expect(band(0)).toBe('POOR');
  });
});

// ---------------------------------------------------------------------------
//  Product requirement validation
// ---------------------------------------------------------------------------

describe('a product requirement', () => {
  it('accepts a minimal one — name and quantity', () => {
    expect(leadProductRequirementSchema.safeParse(requirement()).success).toBe(true);
  });

  it('requires a product name', () => {
    expect(
      leadProductRequirementSchema.safeParse(requirement({ productName: '' })).success,
    ).toBe(false);
    expect(
      leadProductRequirementSchema.safeParse(requirement({ productName: '   ' })).success,
    ).toBe(false);
  });

  it('requires a positive whole quantity', () => {
    expect(leadProductRequirementSchema.safeParse(requirement({ quantity: 0 })).success).toBe(
      false,
    );
    expect(leadProductRequirementSchema.safeParse(requirement({ quantity: -1 })).success).toBe(
      false,
    );
    expect(leadProductRequirementSchema.safeParse(requirement({ quantity: 1.5 })).success).toBe(
      false,
    );
    expect(leadProductRequirementSchema.safeParse(requirement({ quantity: 1 })).success).toBe(
      true,
    );
  });

  it('accepts a zero product value but not a negative one', () => {
    // Zero is a real case — a sample, a replacement — and differs from unpriced.
    expect(
      leadProductRequirementSchema.safeParse(requirement({ productValue: '0.00' })).success,
    ).toBe(true);
    expect(
      leadProductRequirementSchema.safeParse(requirement({ productValue: '-1.00' })).success,
    ).toBe(false);
  });

  it('treats product value as optional', () => {
    expect(
      leadProductRequirementSchema.safeParse(requirement({ productValue: undefined })).success,
    ).toBe(true);
  });
});

describe('the exact/similar pairing', () => {
  it('requires a product when EXACT is claimed', () => {
    const r = leadProductRequirementSchema.safeParse(
      requirement({ matchKind: 'EXACT' }),
    );
    expect(r.success).toBe(false);
  });

  it('requires a product when SIMILAR is claimed', () => {
    const r = leadProductRequirementSchema.safeParse(
      requirement({ matchKind: 'SIMILAR' }),
    );
    expect(r.success).toBe(false);
  });

  it('accepts EXACT with a product', () => {
    expect(
      leadProductRequirementSchema.safeParse(
        requirement({ matchKind: 'EXACT', rsProductId: CUID }),
      ).success,
    ).toBe(true);
  });

  it('accepts SIMILAR with a product', () => {
    expect(
      leadProductRequirementSchema.safeParse(
        requirement({ matchKind: 'SIMILAR', rsProductId: CUID }),
      ).success,
    ).toBe(true);
  });

  it('accepts neither — an unmatched requirement is valid', () => {
    const r = leadProductRequirementSchema.safeParse(requirement());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.matchKind).toBeUndefined();
      expect(r.data.rsProductId).toBeUndefined();
    }
  });

  it('accepts a product with no kind yet — the decision can come later', () => {
    expect(
      leadProductRequirementSchema.safeParse(requirement({ rsProductId: CUID })).success,
    ).toBe(true);
  });
});

describe('measurements on a requirement', () => {
  it('needs a unit beside a weight figure', () => {
    expect(
      leadProductRequirementSchema.safeParse(requirement({ weightValue: 2.5 })).success,
    ).toBe(false);
    expect(
      leadProductRequirementSchema.safeParse(requirement({ weightValue: 2.5, weightUnit: 'KG' }))
        .success,
    ).toBe(true);
  });

  it('needs a unit beside any dimension', () => {
    expect(
      leadProductRequirementSchema.safeParse(requirement({ lengthValue: 250 })).success,
    ).toBe(false);
    expect(
      leadProductRequirementSchema.safeParse(
        requirement({ lengthValue: 250, dimensionUnit: 'MM' }),
      ).success,
    ).toBe(true);
  });

  it('refuses a non-positive measurement', () => {
    expect(
      leadProductRequirementSchema.safeParse(requirement({ weightValue: 0, weightUnit: 'KG' }))
        .success,
    ).toBe(false);
  });

  it('accepts a requirement with no measurements at all', () => {
    expect(leadProductRequirementSchema.safeParse(requirement()).success).toBe(true);
  });

  it('asks for no volume — it is derived, never sent', () => {
    const r = leadProductRequirementSchema.safeParse(
      requirement({ volume: 1000 } as Record<string, unknown>),
    );
    // Zod strips unknown keys rather than failing; the point is that nothing in
    // the parsed output carries a volume.
    expect(r.success).toBe(true);
    if (r.success) expect('volume' in r.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Lead activity validation
// ---------------------------------------------------------------------------

describe('a lead activity', () => {
  const AT = '2026-10-05T09:00:00.000Z';

  it('needs a kind and a due moment', () => {
    expect(leadActivitySchema.safeParse({ kind: 'FOLLOW_UP', dueAt: AT }).success).toBe(true);
    expect(leadActivitySchema.safeParse({ dueAt: AT }).success).toBe(false);
    expect(leadActivitySchema.safeParse({ kind: 'FOLLOW_UP' }).success).toBe(false);
  });

  it('refuses a due moment that is not a real instant', () => {
    expect(
      leadActivitySchema.safeParse({ kind: 'FOLLOW_UP', dueAt: 'next Tuesday' }).success,
    ).toBe(false);
  });

  it('treats completion as optional — absent means outstanding', () => {
    const r = leadActivitySchema.safeParse({ kind: 'FOLLOW_UP', dueAt: AT });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.completedAt).toBeUndefined();
  });

  it('accepts a completion earlier than the due moment', () => {
    // Early is the good case, and nothing may forbid it.
    expect(
      leadActivitySchema.safeParse({
        kind: 'FOLLOW_UP',
        dueAt: AT,
        completedAt: '2026-10-04T09:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('accepts a completion later than the due moment', () => {
    // Late is the case promptness exists to measure, so it must be storable.
    expect(
      leadActivitySchema.safeParse({
        kind: 'FOLLOW_UP',
        dueAt: AT,
        completedAt: '2026-10-09T09:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('carries no score field — promptness is never submitted', () => {
    const r = leadActivitySchema.safeParse({ kind: 'FOLLOW_UP', dueAt: AT });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('score' in r.data).toBe(false);
      expect('promptness' in r.data).toBe(false);
    }
  });
});
