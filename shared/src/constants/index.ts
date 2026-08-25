/**
 * Business constants shared by every tier.
 *
 * These are contract values: the frontend uses them to render limits, the
 * backend uses them to enforce rules, and the database enforces the hard ones
 * again as CHECK constraints. Changing a value here changes all three.
 */

/** §62.1 — hard cap on products in one enquiry. Also a DB CHECK constraint. */
export const MAX_PRODUCTS_PER_ENQUIRY = 20;

/** §62.2 — default response SLA. Snapshotted onto each enquiry at creation. */
export const DEFAULT_SLA_MINUTES = 15;

/** Countdown crosses into its warning state this long before the deadline. */
export const SLA_WARNING_THRESHOLD_SECONDS = 120;

/**
 * §46 — Leader Dashboard bands, applied to
 * (on-time enquiries / responded enquiries) per employee per month.
 * Configurable later without a deployment; ordered highest first.
 */
export const EFFICIENCY_BANDS = [
  { label: 'Excellent', minPercent: 80 },
  { label: 'Good', minPercent: 70 },
  { label: 'Satisfactory', minPercent: 60 },
  { label: 'Poor', minPercent: 0 },
] as const;

export type EfficiencyBandLabel = (typeof EFFICIENCY_BANDS)[number]['label'];

export function efficiencyBand(percent: number): EfficiencyBandLabel {
  const band = EFFICIENCY_BANDS.find((b) => percent >= b.minPercent);
  return (band ?? EFFICIENCY_BANDS[EFFICIENCY_BANDS.length - 1]!).label;
}

/** Enquiry number format: ENQ-<period>-<6 digits>. */
export const ENQUIRY_NUMBER_PREFIX = 'ENQ';
export const ENQUIRY_NUMBER_PAD = 6;

/** Default page size for server-side paginated lists. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * §12 — session JWT contract.
 *
 * Auth.js signs the session token with these claims and Express verifies
 * against the same values, so they live here rather than as matching literals
 * in two packages that could drift apart.
 */
export const SESSION_JWT_ALG = 'HS256' as const;
export const SESSION_JWT_ISSUER = 'royalstuffs-crm';
export const SESSION_JWT_AUDIENCE = 'royalstuffs-crm-api';
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
