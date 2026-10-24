/**
 * Source mapping — Clarification 2.
 *
 * Three vocabularies that overlap and disagree are grouped for reporting
 * without any stored value being renamed or overwritten. These tests exist
 * because the failure modes are all silent: a report that folds an unknown
 * value into OTHER loses data without erroring, and one that merges
 * NOT_RECORDED with OTHER overstates how much is genuinely unattributed.
 */

import { describe, expect, it } from 'vitest';
import {
  categoriseChannel,
  categoriseSource,
  groupBySourceCategory,
  UNKNOWN_SOURCE,
} from '@rs/shared';

describe('the stored value is never replaced', () => {
  it('returns the original alongside the category', () => {
    const result = categoriseSource('WHATSAPP');
    expect(result.original).toBe('WHATSAPP');
    expect(result.category).toBe('MESSAGING');
  });

  it('keeps the original for an unmapped value rather than discarding it', () => {
    // A value added to an enum that this mapping has not met yet must stay
    // visible as itself. Folding it into OTHER would lose it silently.
    const result = categoriseSource('TELEGRAM');
    expect(result.original).toBe('TELEGRAM');
    expect(result.category).toBe('UNMAPPED');
    expect(result.label).toBe('TELEGRAM');
  });
});

describe('the conflicting vocabularies', () => {
  it('maps INDIAMART to MARKETPLACE whether it arrives as a source or a channel', () => {
    /*
      The core conflict: INDIAMART is an EnquirySource value and a LEAD_CHANNELS
      value. Both describe the same real acquisition route, so both land in the
      same reporting category — which is the whole reason this layer exists.
    */
    expect(categoriseSource('INDIAMART').category).toBe('MARKETPLACE');
    expect(categoriseChannel('INDIAMART')?.category).toBe('MARKETPLACE');
  });

  it('maps WEBSITE, which only enquiries have', () => {
    expect(categoriseSource('WEBSITE').category).toBe('OWN_STORE');
  });

  it('maps SOCIAL_MEDIA, which only leads have', () => {
    expect(categoriseSource('SOCIAL_MEDIA').category).toBe('SOCIAL');
  });

  it('groups both RoyalStuffs storefronts together', () => {
    expect(categoriseChannel('ROYALSTUFFS_COM')?.category).toBe('OWN_STORE');
    expect(categoriseChannel('ROYALSTUFFS_STORE')?.category).toBe('OWN_STORE');
  });

  it('groups the marketplaces together', () => {
    for (const channel of ['INDIAMART', 'AMAZON', 'FLIPKART']) {
      expect(categoriseChannel(channel)?.category).toBe('MARKETPLACE');
    }
  });

  it('treats an abandoned cart as our own storefront', () => {
    // A cart can only be abandoned on a store we run.
    expect(categoriseSource('ABANDONED_CART').category).toBe('OWN_STORE');
  });
});

describe('UNKNOWN is not OTHER', () => {
  it('categorises a recorded "other" as OTHER_STATED', () => {
    // Somebody chose "other" and may have written why.
    expect(categoriseSource('OTHER').category).toBe('OTHER_STATED');
    expect(categoriseSource('OTHERS').category).toBe('OTHER_STATED');
  });

  it('categorises an absent source as NOT_RECORDED', () => {
    /*
      Distinct from OTHER_STATED on purpose. "Nobody wrote down where this came
      from" and "somebody wrote down 'other'" are different facts; merging them
      would overstate how much of the book is genuinely unattributed.
    */
    const result = categoriseSource(UNKNOWN_SOURCE);
    expect(result.category).toBe('NOT_RECORDED');
    expect(result.detail).toBeNull();
  });

  it('keeps the two apart when grouped', () => {
    const grouped = groupBySourceCategory([
      { source: 'OTHER', detail: 'Trade fair' },
      { source: UNKNOWN_SOURCE },
    ]);
    const categories = grouped.map((g) => g.category);
    expect(categories).toContain('OTHER_STATED');
    expect(categories).toContain('NOT_RECORDED');
  });
});

describe('free text', () => {
  it('shows the written detail instead of a bare OTHER', () => {
    const result = categoriseSource('OTHER', 'Trade fair, Jaipur');
    expect(result.detail).toBe('Trade fair, Jaipur');
    expect(result.label).toBe('Trade fair, Jaipur');
  });

  it('trims the detail and treats whitespace as absent', () => {
    expect(categoriseSource('OTHER', '   ').detail).toBeNull();
    expect(categoriseSource('OTHER', '  Walk-in  ').detail).toBe('Walk-in');
  });

  it('falls back to a readable label when there is no detail', () => {
    expect(categoriseSource('OTHER').label).toBe('Other');
    expect(categoriseSource('SOCIAL_MEDIA').label).toBe('Social Media');
  });

  it('carries channel free text too', () => {
    expect(categoriseChannel('OTHER', 'Reseller')?.label).toBe('Reseller');
  });
});

describe('channels are a lead-only concept', () => {
  it('returns null rather than a category when there is no channel', () => {
    // An enquiry has no channel field. Inventing one would mean guessing a
    // storefront the enquiry never named.
    expect(categoriseChannel(null)).toBeNull();
    expect(categoriseChannel(undefined)).toBeNull();
    expect(categoriseChannel('')).toBeNull();
  });
});

describe('grouping for a report', () => {
  it('shows which original values fed each bucket', () => {
    // So MARKETPLACE is visibly IndiaMART plus Amazon, not an opaque total.
    const grouped = groupBySourceCategory([
      { source: 'INDIAMART' },
      { source: 'INDIAMART' },
      { source: 'CALL' },
    ]);
    const marketplace = grouped.find((g) => g.category === 'MARKETPLACE');
    expect(marketplace?.count).toBe(2);
    expect(marketplace?.originals).toEqual(['INDIAMART']);
  });

  it('merges values that mean the same route', () => {
    const grouped = groupBySourceCategory([
      { source: 'WEBSITE' },
      { source: 'ABANDONED_CART' },
    ]);
    const store = grouped.find((g) => g.category === 'OWN_STORE');
    expect(store?.count).toBe(2);
    expect(store?.originals).toEqual(['ABANDONED_CART', 'WEBSITE']);
  });

  it('orders buckets stably rather than by whichever appeared first', () => {
    const a = groupBySourceCategory([{ source: 'CALL' }, { source: 'INDIAMART' }]);
    const b = groupBySourceCategory([{ source: 'INDIAMART' }, { source: 'CALL' }]);
    expect(a.map((g) => g.category)).toEqual(b.map((g) => g.category));
  });

  it('omits categories with nothing in them', () => {
    const grouped = groupBySourceCategory([{ source: 'CALL' }]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.category).toBe('DIRECT_CONTACT');
  });

  it('surfaces an unmapped value as its own bucket', () => {
    const grouped = groupBySourceCategory([{ source: 'TELEGRAM' }]);
    expect(grouped[0]?.category).toBe('UNMAPPED');
    expect(grouped[0]?.originals).toEqual(['TELEGRAM']);
  });
});
