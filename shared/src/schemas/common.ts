import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/index.js';
import { DIMENSION_UNITS, WEIGHT_UNITS } from '../enums.js';
import { isValidAmount, normaliseAmount } from '../utils/money.js';

export const cuidSchema = z.string().cuid('Not a valid identifier');

/** §35 — accepts a number or string, always yields a canonical decimal string. */
export const amountSchema = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
  .refine(isValidAmount, 'Enter a valid amount with up to two decimal places')
  .transform(normaliseAmount);

/** §19 — value plus unit as one control, so a bare number can never be stored. */
export const weightSchema = z.object({
  value: z.number().positive('Weight must be greater than zero').max(1_000_000),
  unit: z.enum(WEIGHT_UNITS),
});

/** §20 — structured, never a free-text string. */
export const dimensionSchema = z.object({
  length: z.number().positive('Length must be greater than zero').max(1_000_000),
  width: z.number().positive('Width must be greater than zero').max(1_000_000),
  height: z.number().positive('Height must be greater than zero').max(1_000_000),
  unit: z.enum(DIMENSION_UNITS),
});

/** Keyset pagination — §49 rules out fetching everything and filtering locally. */
export const paginationSchema = z.object({
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type Weight = z.infer<typeof weightSchema>;
export type Dimension = z.infer<typeof dimensionSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
