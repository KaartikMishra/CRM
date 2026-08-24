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
