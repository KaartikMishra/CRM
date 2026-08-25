/**
 * §19–20 — turning a weight or dimension from the API into database columns.
 *
 * Both are stored twice: exactly as the employee entered them, plus a
 * normalised copy in grams/millimetres so that records entered in kilograms and
 * pounds still sort and filter together. The conversion lives in @rs/shared so
 * the frontend computes the same numbers.
 *
 * The `weight_value_and_unit_together` CHECK constraint requires value and unit
 * to be null or non-null as a pair, which is why clearing writes both.
 */

import type { Dimension, Weight } from '@rs/shared';
import { toGrams, toMillimetres } from '@rs/shared';

export type WeightColumns = {
  weightValue: number | null;
  weightUnit: Weight['unit'] | null;
  weightInGrams: number | null;
};

export type DimensionColumns = {
  lengthValue: number | null;
  widthValue: number | null;
  heightValue: number | null;
  dimensionUnit: Dimension['unit'] | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
};

export function weightColumns(weight: Weight | null | undefined): WeightColumns {
  if (!weight) {
    return { weightValue: null, weightUnit: null, weightInGrams: null };
  }
  return {
    weightValue: weight.value,
    weightUnit: weight.unit,
    weightInGrams: toGrams(weight.value, weight.unit),
  };
}

export function dimensionColumns(
  dimension: Dimension | null | undefined,
): DimensionColumns {
  if (!dimension) {
    return {
      lengthValue: null,
      widthValue: null,
      heightValue: null,
      dimensionUnit: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    };
  }
  return {
    lengthValue: dimension.length,
    widthValue: dimension.width,
    heightValue: dimension.height,
    dimensionUnit: dimension.unit,
    lengthMm: toMillimetres(dimension.length, dimension.unit),
    widthMm: toMillimetres(dimension.width, dimension.unit),
    heightMm: toMillimetres(dimension.height, dimension.unit),
  };
}

/** VendorResponse has no normalised millimetre columns, only the raw values. */
export function vendorDimensionColumns(dimension: Dimension | null | undefined) {
  const all = dimensionColumns(dimension);
  return {
    lengthValue: all.lengthValue,
    widthValue: all.widthValue,
    heightValue: all.heightValue,
    dimensionUnit: all.dimensionUnit,
  };
}
