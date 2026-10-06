import type { DimensionUnit, WeightUnit } from '../enums.js';

/**
 * §19–20 — values are stored exactly as the employee entered them, plus a
 * normalised column so that mixed-unit records still sort and filter together.
 * Both tiers use these functions so the two never disagree.
 */

const GRAMS_PER: Record<WeightUnit, number> = {
  G: 1,
  KG: 1000,
  LB: 453.59237,
};

const MILLIMETRES_PER: Record<DimensionUnit, number> = {
  MM: 1,
  CM: 10,
  IN: 25.4,
  FT: 304.8,
};

/** Normalises any supported weight to grams, rounded to 3 decimal places. */
export function toGrams(value: number, unit: WeightUnit): number {
  return round(value * GRAMS_PER[unit], 3);
}

/** Normalises any supported length to millimetres, rounded to 2 decimal places. */
export function toMillimetres(value: number, unit: DimensionUnit): number {
  return round(value * MILLIMETRES_PER[unit], 2);
}

/**
 * The volume of a box, derived from its three dimensions.
 *
 * ### Why this lives here, in shared
 *
 * Volume is length × width × height, which is simple enough that it would get
 * written three times — once in the API response, once on the form that previews
 * it as somebody types, once in whatever reads it next — and the three would
 * drift the first time one of them rounded differently. One function, called by
 * both tiers: the backend derives it on every read and the browser previews it
 * with the identical formula, so a figure cannot change by being displayed.
 *
 * It sits beside `toMillimetres` because it composes it. No second conversion
 * table is introduced — the millimetre factors above are the same ones
 * EnquiryProduct and ShopifyVariant normalise with.
 *
 * ### Why it is not stored
 *
 * A `volume` column would be a fourth number free to contradict the three it
 * came from: an edit that changed the height and missed the volume would leave a
 * row stating its own impossible size. Nothing persists this.
 *
 * ### Units, reported twice over
 *
 * `value` is in the unit the dimensions were entered in, because somebody who
 * typed centimetres is looking for cubic centimetres. `inCubicMm` is normalised,
 * so two boxes captured in different units can be compared.
 *
 * ### Null, not zero
 *
 * Null whenever any of the three is missing, or the unit is: a box with no stated
 * height has an unknown volume, not a volume of nothing, and three numbers with
 * no unit describe no particular box. Zero is unreachable from stored input,
 * since each dimension must be positive to be written at all — but the guard is
 * explicit, because this is also the function a half-filled form calls.
 */
export type VolumeResult = {
  /** In `unit` — the unit the dimensions were given in. */
  value: number;
  unit: DimensionUnit;
  /** Normalised, for comparison across units. */
  inCubicMm: number;
};

/** Two places, matching the Decimal(_, 2) the dimension columns themselves use. */
const VOLUME_DECIMALS = 2;

export function volume(dimension: {
  length: number | null;
  width: number | null;
  height: number | null;
  unit: DimensionUnit | null;
}): VolumeResult | null {
  const { length, width, height, unit } = dimension;

  if (length === null || width === null || height === null || unit === null) return null;
  if (length <= 0 || width <= 0 || height <= 0) return null;

  return {
    value: round(length * width * height, VOLUME_DECIMALS),
    unit,
    inCubicMm: round(
      toMillimetres(length, unit) * toMillimetres(width, unit) * toMillimetres(height, unit),
      VOLUME_DECIMALS,
    ),
  };
}

/** `1000 cm³`, for a figure the browser shows rather than computes. */
export function formatVolume(result: VolumeResult): string {
  return `${trimZeros(result.value)} ${result.unit.toLowerCase()}³`;
}

export function formatWeight(value: number, unit: WeightUnit): string {
  return `${trimZeros(value)} ${unit.toLowerCase()}`;
}

export function formatDimension(
  length: number,
  width: number,
  height: number,
  unit: DimensionUnit,
): string {
  return `${trimZeros(length)} × ${trimZeros(width)} × ${trimZeros(height)} ${unit.toLowerCase()}`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function trimZeros(value: number): string {
  return String(Number(value.toFixed(3)));
}
