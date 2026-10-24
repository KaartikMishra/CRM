/**
 * Grouping three source vocabularies for reporting, without rewriting any of them.
 *
 * The CRM holds three lists that overlap and disagree:
 *
 *     EnquirySource   WHATSAPP, EMAIL, CALL, WEBSITE, INDIAMART, OTHERS
 *     LeadSource      CALL, WHATSAPP, EMAIL, ABANDONED_CART, SOCIAL_MEDIA, OTHER
 *     LEAD_CHANNELS   ROYALSTUFFS_COM, ROYALSTUFFS_STORE, INDIAMART, AMAZON,
 *                     FLIPKART, OTHER
 *
 * `INDIAMART` is a *source* on an enquiry and a *channel* on a lead. `WEBSITE`
 * exists only for enquiries, `SOCIAL_MEDIA` only for leads. So a report that
 * grouped on the raw value would split one real acquisition route in two and
 * merge two different kinds of fact.
 *
 * ### This is a mapping layer, not a migration
 *
 * Nothing here changes a stored value. Every function takes the original and
 * returns a reporting category *alongside* it, so a row can always be traced
 * back to what was actually recorded. The stored vocabularies are the system of
 * record; these categories exist only so a chart can add two rows together.
 *
 * ### Unknown values stay visible
 *
 * A value this file has never seen is not discarded and is not folded into
 * OTHER. It comes back categorised as UNMAPPED with the original attached, so a
 * new source value added to an enum shows up in reports as itself rather than
 * vanishing — which is how a reporting layer silently loses data.
 *
 * ### None of these are integrations
 *
 * Every value was typed by a person. The CRM has no IndiaMART, WhatsApp, email
 * or social connector — no client library, no inbound route — so `WHATSAPP`
 * means somebody recorded a WhatsApp conversation. Nothing here should be read
 * as evidence of a connected channel.
 */

import { UNKNOWN_SOURCE } from './customer-attribution.js';

/**
 * The reporting categories.
 *
 * Deliberately few and about *how the customer reached us*, which is the
 * question a source report answers. MARKETPLACE covers IndiaMART, Amazon and
 * Flipkart together because they are the same kind of route; OWN_STORE covers
 * the two RoyalStuffs storefronts and a direct website enquiry.
 */
export const SOURCE_CATEGORIES = [
  'DIRECT_CONTACT',
  'MESSAGING',
  'EMAIL',
  'OWN_STORE',
  'MARKETPLACE',
  'SOCIAL',
  'OTHER_STATED',
  'NOT_RECORDED',
  'UNMAPPED',
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export const SOURCE_CATEGORY_LABELS = {
  DIRECT_CONTACT: 'Phone call',
  MESSAGING: 'Messaging',
  EMAIL: 'Email',
  OWN_STORE: 'Own storefront',
  MARKETPLACE: 'Marketplace',
  SOCIAL: 'Social media',
  OTHER_STATED: 'Other (stated)',
  NOT_RECORDED: 'Not recorded',
  UNMAPPED: 'Unrecognised value',
} as const satisfies Record<SourceCategory, string>;

/**
 * Known source values, from both source vocabularies.
 *
 * `ABANDONED_CART` maps to OWN_STORE: a cart can only be abandoned on a
 * storefront we run, so that is where the contact originated.
 */
const SOURCE_CATEGORIES_BY_VALUE: Record<string, SourceCategory> = {
  // Shared by EnquirySource and LeadSource.
  CALL: 'DIRECT_CONTACT',
  WHATSAPP: 'MESSAGING',
  EMAIL: 'EMAIL',
  // EnquirySource only.
  WEBSITE: 'OWN_STORE',
  INDIAMART: 'MARKETPLACE',
  // LeadSource only.
  SOCIAL_MEDIA: 'SOCIAL',
  ABANDONED_CART: 'OWN_STORE',
  /*
    Both spellings are real — LeadSource.OTHER and EnquirySource.OTHERS — and
    both mean "a route somebody wrote down in free text". OTHER_STATED rather
    than UNMAPPED: the value is recognised, it is the detail that is free-form.
  */
  OTHER: 'OTHER_STATED',
  OTHERS: 'OTHER_STATED',
};

/** Known channel values, from LEAD_CHANNELS. Channels are a lead-only concept. */
const CHANNEL_CATEGORIES_BY_VALUE: Record<string, SourceCategory> = {
  ROYALSTUFFS_COM: 'OWN_STORE',
  ROYALSTUFFS_STORE: 'OWN_STORE',
  INDIAMART: 'MARKETPLACE',
  AMAZON: 'MARKETPLACE',
  FLIPKART: 'MARKETPLACE',
  OTHER: 'OTHER_STATED',
};

/** A stored value with its reporting category, never instead of it. */
export type CategorisedSource = {
  /** Exactly what is stored. The system of record. */
  original: string;
  category: SourceCategory;
  /** The free text, where the value has one. Shown in place of a bare OTHER. */
  detail: string | null;
  /** What to display: the free text if present, else a readable form. */
  label: string;
};

/**
 * Categorises a source value.
 *
 * `UNKNOWN_SOURCE` — no record carried a source at all — becomes NOT_RECORDED,
 * which is deliberately distinct from OTHER_STATED. "Nobody wrote down where
 * this came from" and "somebody wrote down 'other'" are different facts, and a
 * report that merged them would overstate how much is genuinely unattributed.
 */
export function categoriseSource(
  original: string,
  detail?: string | null,
): CategorisedSource {
  if (original === UNKNOWN_SOURCE) {
    return {
      original,
      category: 'NOT_RECORDED',
      detail: null,
      label: SOURCE_CATEGORY_LABELS.NOT_RECORDED,
    };
  }

  const category = SOURCE_CATEGORIES_BY_VALUE[original] ?? 'UNMAPPED';
  const text = detail?.trim() ? detail.trim() : null;

  return {
    original,
    category,
    detail: text,
    /*
      The free text wins when there is one: "Trade fair, Jaipur" tells a reader
      more than "Other". An unmapped value shows as itself rather than as a
      category name, so a newly added enum value is visible as the thing it is.
    */
    label: text ?? (category === 'UNMAPPED' ? original : readable(original)),
  };
}

/** Categorises a lead channel. Returns null for a customer with no channel. */
export function categoriseChannel(
  original: string | null | undefined,
  detail?: string | null,
): CategorisedSource | null {
  if (!original) return null;

  const category = CHANNEL_CATEGORIES_BY_VALUE[original] ?? 'UNMAPPED';
  const text = detail?.trim() ? detail.trim() : null;

  return {
    original,
    category,
    detail: text,
    label: text ?? (category === 'UNMAPPED' ? original : readable(original)),
  };
}

/** SCREAMING_SNAKE to Title Case, for values with no label of their own. */
function readable(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Groups categorised rows for a report.
 *
 * Returns one bucket per category present, each listing which original values
 * fed it. The originals are kept so a reader can see that MARKETPLACE is
 * IndiaMART plus Amazon rather than an opaque total — and so the two
 * vocabularies' disagreement over INDIAMART is visible rather than smoothed
 * over.
 */
export function groupBySourceCategory(
  rows: readonly { source: string; detail?: string | null }[],
): { category: SourceCategory; label: string; count: number; originals: string[] }[] {
  const buckets = new Map<SourceCategory, { count: number; originals: Set<string> }>();

  for (const row of rows) {
    const categorised = categoriseSource(row.source, row.detail);
    let bucket = buckets.get(categorised.category);
    if (!bucket) {
      bucket = { count: 0, originals: new Set() };
      buckets.set(categorised.category, bucket);
    }
    bucket.count += 1;
    bucket.originals.add(categorised.original);
  }

  // Ordered by the declaration order of SOURCE_CATEGORIES, so a report's rows
  // do not move about between runs.
  return SOURCE_CATEGORIES.filter((category) => buckets.has(category)).map((category) => {
    const bucket = buckets.get(category)!;
    return {
      category,
      label: SOURCE_CATEGORY_LABELS[category],
      count: bucket.count,
      originals: [...bucket.originals].sort(),
    };
  });
}
