/**
 * Derived volume, as pure arithmetic — Phase 4F, Part Z.
 *
 * No database and no HTTP. Volume is the one figure on a requirement that no
 * column stores, so these tests are the specification of it: if this file and
 * the table ever disagree, the table is wrong by construction.
 *
 * The worked examples from the brief are asserted by name, and so are the two
 * cases that are decisions rather than arithmetic — an incomplete box is null
 * rather than zero, and a mixed-unit figure normalises through the same helper
 * the enquiry module already uses.
 */

import { describe, expect, it } from 'vitest';
import { toMillimetres } from '@rs/shared';
import { volume } from '../lead.calc.js';

const box = (
  length: number | null,
  width: number | null,
  height: number | null,
  unit: 'MM' | 'CM' | 'IN' | 'FT' | null = 'CM',
) => volume({ length, width, height, unit });

// ---------------------------------------------------------------------------
//  The worked examples
// ---------------------------------------------------------------------------

describe('the examples from the brief', () => {
  it('20 × 10 × 5 cm = 1000 cm³', () => {
    const v = box(20, 10, 5, 'CM');
    expect(v).not.toBeNull();
    expect(v!.value).toBe(1000);
    expect(v!.unit).toBe('CM');
  });

  it('2 × 3 × 4 cm = 24 cm³', () => {
    expect(box(2, 3, 4, 'CM')!.value).toBe(24);
  });

  it('reports the figure in the unit somebody actually typed', () => {
    /*
      1000 cm³ and 1,000,000 mm³ are the same box. The first is the one a person
      recognises, so `value` stays in their unit and the normalised companion
      carries the comparable figure.
    */
    const v = box(20, 10, 5, 'CM')!;
    expect(v.value).toBe(1000);
    expect(v.inCubicMm).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
//  Incomplete dimensions
// ---------------------------------------------------------------------------

describe('an incomplete box has no volume', () => {
  it('returns null when the width is missing', () => {
    // 20 × null × 5 — the brief's own example.
    expect(box(20, null, 5)).toBeNull();
  });

  it('returns null when any single dimension is missing', () => {
    expect(box(null, 10, 5)).toBeNull();
    expect(box(20, null, 5)).toBeNull();
    expect(box(20, 10, null)).toBeNull();
  });

  it('returns null when nothing was entered at all', () => {
    expect(box(null, null, null, null)).toBeNull();
  });

  it('returns null when the figures are there but the unit is not', () => {
    // Three numbers with no unit describe no particular box. Reporting a figure
    // here would mean picking a unit on the customer's behalf.
    expect(box(20, 10, 5, null)).toBeNull();
  });

  it('is null rather than zero, which would claim a flat box', () => {
    const v = box(20, null, 5);
    expect(v).toBeNull();
    expect(v).not.toEqual({ value: 0, unit: 'CM', inCubicMm: 0 });
  });
});

// ---------------------------------------------------------------------------
//  Invalid dimensions
// ---------------------------------------------------------------------------

describe('a non-positive dimension is not a box', () => {
  it('returns null for a zero dimension', () => {
    // Unreachable through the schema, which demands each dimension be positive.
    // Guarded anyway because the frontend calls this on a half-typed form.
    expect(box(0, 10, 5)).toBeNull();
  });

  it('returns null for a negative dimension', () => {
    expect(box(-20, 10, 5)).toBeNull();
    expect(box(20, -10, 5)).toBeNull();
    expect(box(20, 10, -5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Unit normalisation
// ---------------------------------------------------------------------------

describe('normalisation reuses the existing unit conversion', () => {
  it('gives a millimetre box the same figure in both fields', () => {
    const v = box(20, 10, 5, 'MM')!;
    expect(v.value).toBe(1000);
    expect(v.inCubicMm).toBe(1000);
  });

  it('normalises a 1 m × 20 cm × 10 cm box consistently', () => {
    /*
      The brief's mixed-unit example. There is no metre unit in DimensionUnit —
      the project's vocabulary is MM/CM/IN/FT — so a metre is entered as 100 cm,
      and the comparable figure comes out in cubic millimetres.
    */
    const v = box(100, 20, 10, 'CM')!;
    expect(v.value).toBe(20_000);
    expect(v.inCubicMm).toBe(20_000_000);
  });

  it('converts inches through the shared helper, not a local factor', () => {
    const v = box(2, 2, 2, 'IN')!;
    expect(v.value).toBe(8);
    // 25.4mm per inch, cubed — asserted against the helper itself so this test
    // cannot pass while disagreeing with how the rest of the CRM converts.
    const side = toMillimetres(2, 'IN');
    expect(v.inCubicMm).toBeCloseTo(side * side * side, 2);
  });

  it('converts feet through the shared helper too', () => {
    const v = box(1, 1, 1, 'FT')!;
    expect(v.value).toBe(1);
    const side = toMillimetres(1, 'FT');
    expect(v.inCubicMm).toBeCloseTo(side * side * side, 2);
  });

  it('makes two boxes of equal size comparable across units', () => {
    // 10 cm cube and 100 mm cube are the same box, entered differently.
    const inCm = box(10, 10, 10, 'CM')!;
    const inMm = box(100, 100, 100, 'MM')!;
    expect(inCm.inCubicMm).toBe(inMm.inCubicMm);
    // And their own figures differ, which is exactly why both fields exist.
    expect(inCm.value).not.toBe(inMm.value);
  });
});

// ---------------------------------------------------------------------------
//  Rounding and scale
// ---------------------------------------------------------------------------

describe('rounding', () => {
  it('keeps two decimal places, matching the dimension columns', () => {
    const v = box(1.5, 1.5, 1.5, 'CM')!;
    expect(v.value).toBe(3.38);
  });

  it('handles a large box without losing the figure to precision', () => {
    const v = box(1000, 1000, 1000, 'MM')!;
    expect(v.value).toBe(1_000_000_000);
  });

  it('handles a small box without rounding it away to zero', () => {
    const v = box(0.5, 0.5, 0.5, 'CM')!;
    expect(v.value).toBe(0.13);
    expect(v.value).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
//  One definition
// ---------------------------------------------------------------------------

describe('there is one formula', () => {
  it('is order-independent, as a product should be', () => {
    const a = box(20, 10, 5, 'CM')!;
    const b = box(5, 10, 20, 'CM')!;
    expect(a.value).toBe(b.value);
    expect(a.inCubicMm).toBe(b.inCubicMm);
  });

  it('is a pure function of its input', () => {
    // Called twice with the same box, it answers the same thing — no clock, no
    // database, nothing stored between calls.
    expect(box(7, 3, 2, 'CM')).toEqual(box(7, 3, 2, 'CM'));
  });

  it('never returns a partially filled result', () => {
    // Either all three fields or null. A result with a value but no unit would
    // be a figure meaning nothing.
    for (const v of [box(20, 10, 5, 'CM'), box(20, null, 5), box(0, 1, 1)]) {
      if (v === null) continue;
      expect(v.unit).toBeTruthy();
      expect(typeof v.value).toBe('number');
      expect(typeof v.inCubicMm).toBe('number');
    }
  });
});
