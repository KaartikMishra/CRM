/**
 * Where a customer came from, first and last.
 *
 * Two record types carry a source today, and they use different vocabularies:
 *
 *     Lead            leadSource (CALL, WHATSAPP, EMAIL, ABANDONED_CART,
 *                     SOCIAL_MEDIA, OTHER) + channel (ROYALSTUFFS_COM,
 *                     ROYALSTUFFS_STORE, INDIAMART, AMAZON, FLIPKART, OTHER)
 *     ProductEnquiry  source (WHATSAPP, EMAIL, CALL, WEBSITE, INDIAMART, OTHERS)
 *
 * The two overlap and disagree: INDIAMART is a *channel* on a lead and a
 * *source* on an enquiry, WEBSITE exists only on enquiries, SOCIAL_MEDIA only
 * on leads. Reconciling those vocabularies is a business decision, so this
 * module deliberately does not: it preserves each original value verbatim and
 * reports which record it came from. A reporting-layer mapping can group them
 * later without rewriting history.
 *
 * ### These are attribution labels, not integrations
 *
 * Every value here was typed by a person. The CRM has no IndiaMART, WhatsApp,
 * email or social-media ingestion — no client library, no inbound route — so a
 * source of WHATSAPP means somebody recorded a WhatsApp conversation, not that
 * a WhatsApp integration reported one. Nothing in this file should be read as
 * evidence of a connected channel.
 */

/** Which record a source value was read from. */
export type AttributionOrigin = 'LEAD' | 'ENQUIRY';

/**
 * One source event, as a record states it.
 *
 * `channel` is only ever present on a lead; an enquiry has no equivalent field,
 * and inventing one would mean guessing a storefront the enquiry never named.
 */
export type SourceEvent = {
  origin: AttributionOrigin;
  /** The record's own id, used as the final tie-break so ordering is total. */
  recordId: string;
  /** The value exactly as stored. Never remapped here. */
  source: string;
  /** The free text paired with an OTHER/OTHERS value, when there is one. */
  sourceOther?: string | null;
  /** Lead only: which storefront or marketplace carried it. */
  channel?: string | null;
  channelOther?: string | null;
  /**
   * When the contact happened.
   *
   * For a lead this is `sourceAt`, a business instant somebody recorded. For an
   * enquiry it is `createdAt`, which is when the row was written. The two are
   * not the same kind of fact, and the tie-break below exists because of it.
   */
  at: Date;
};

/** What the directory and profile show for one end of the journey. */
export type Attribution = {
  /** The stored value, or 'UNKNOWN' when there is no source event at all. */
  source: string;
  sourceOther: string | null;
  channel: string | null;
  channelOther: string | null;
  origin: AttributionOrigin | null;
  at: string | null;
};

/**
 * What a customer with no lead and no enquiry is attributed to.
 *
 * A distinct value rather than null or OTHER. Null would render as a blank cell
 * that reads like missing data, and OTHER would claim somebody chose "other"
 * when nobody chose anything. UNKNOWN says the honest thing: no record carries
 * a source for this customer.
 */
export const UNKNOWN_SOURCE = 'UNKNOWN';

const unknown = (): Attribution => ({
  source: UNKNOWN_SOURCE,
  sourceOther: null,
  channel: null,
  channelOther: null,
  origin: null,
  at: null,
});

const toAttribution = (event: SourceEvent): Attribution => ({
  source: event.source,
  sourceOther: event.sourceOther ?? null,
  channel: event.channel ?? null,
  channelOther: event.channelOther ?? null,
  origin: event.origin,
  at: event.at.toISOString(),
});

/**
 * Orders two events oldest-first, deterministically.
 *
 * The tie-break matters more than it looks. Two events can share a timestamp —
 * a lead and an enquiry entered in the same import, or simply the same second —
 * and "whichever the database happened to return first" would make a customer's
 * first-touch source flip between page loads.
 *
 * So: timestamp, then LEAD before ENQUIRY, then record id.
 *
 * LEAD wins the middle rule because `Lead.sourceAt` is a business instant
 * somebody recorded ("a lead is often entered hours after the call", as the
 * schema puts it) while `ProductEnquiry.createdAt` is a row-creation artefact.
 * When the two claim the same moment, the deliberately recorded one is the
 * better evidence of what actually happened first.
 */
function compareEvents(a: SourceEvent, b: SourceEvent): number {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) return byTime;

  if (a.origin !== b.origin) return a.origin === 'LEAD' ? -1 : 1;

  // Total order, so the result cannot depend on input order.
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

/**
 * First-touch and last-touch, from every source event a customer has.
 *
 * Derived on every read rather than stored. A lead's `sourceAt` corrected after
 * the fact therefore corrects the attribution too, which a stored column would
 * not — and the cost is sorting a handful of events per customer.
 *
 * With exactly one event, first and last are the same event, which is correct:
 * one contact is both the first and the most recent.
 */
export function attributionFor(events: readonly SourceEvent[]): {
  firstTouch: Attribution;
  lastTouch: Attribution;
} {
  if (events.length === 0) {
    return { firstTouch: unknown(), lastTouch: unknown() };
  }

  // Copied before sorting: callers pass arrays they still own.
  const ordered = [...events].sort(compareEvents);

  return {
    firstTouch: toAttribution(ordered[0]!),
    lastTouch: toAttribution(ordered[ordered.length - 1]!),
  };
}

/**
 * A display label for a source value, with the free text when it has one.
 *
 * Mapping, not rewriting: the stored value is unchanged and this is what a
 * reader sees. `OTHER` and `OTHERS` are both spelled in the live vocabularies —
 * `LeadSource.OTHER` and `EnquirySource.OTHERS` — so both are honoured rather
 * than one being treated as a typo for the other.
 */
export function sourceLabel(source: string, sourceOther?: string | null): string {
  if ((source === 'OTHER' || source === 'OTHERS') && sourceOther) {
    return sourceOther;
  }
  if (source === UNKNOWN_SOURCE) return 'Unknown';
  return source;
}
