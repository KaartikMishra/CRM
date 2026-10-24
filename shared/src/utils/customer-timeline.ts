/**
 * Ordering the customer timeline.
 *
 * Extracted from the profile service so the rule can be tested without a
 * database — which matters, because the development database holds no customer
 * history and the ordering is exactly the kind of logic that looks right and
 * is subtly wrong.
 *
 * Newest first, and the order is *total*: no two entries can compare equal, so
 * the same set always comes back in the same sequence. Without that, two events
 * sharing a timestamp would appear in whichever order the queries happened to
 * return, and the timeline would reshuffle itself between page loads.
 */

/** The event kinds the timeline can carry. */
export const TIMELINE_KINDS = [
  'ENQUIRY_RAISED',
  'ENQUIRY_EVENT',
  'LEAD_CAPTURED',
  'LEAD_ACTIVITY',
  'ORDER_PLACED',
  'PAYMENT_RECORDED',
  'ORDER_CANCELLED',
  'REFUND_RECORDED',
  'DISPATCH_RECORDED',
  'POST_SALES_CASE',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/**
 * Precedence for entries sharing a timestamp.
 *
 * The sequence follows the life of a customer relationship: they enquire, a
 * lead is captured and worked, an order is placed and paid, money may come
 * back, and a case may follow. So when a bulk import stamps several events with
 * one timestamp, they still read in a sensible order rather than at random.
 *
 * Derived from the declaration order above, so adding a kind in the right place
 * is all that is needed — there is no second list to keep in step.
 */
const KIND_PRECEDENCE: Record<TimelineKind, number> = Object.fromEntries(
  TIMELINE_KINDS.map((kind, index) => [kind, index]),
) as Record<TimelineKind, number>;

/** The minimum an entry needs to be ordered. */
export type OrderableEntry = {
  id: string;
  kind: TimelineKind;
  /** An ISO-8601 instant. Compared as a string, which is ordering-safe for ISO. */
  at: string;
};

/**
 * Compares two entries, newest first.
 *
 * ISO-8601 strings in the same offset sort correctly as strings, which is why
 * `at` is kept as the serialised form rather than being parsed back into a Date
 * for every comparison.
 */
export function compareTimelineEntries(a: OrderableEntry, b: OrderableEntry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;

  const byKind = KIND_PRECEDENCE[a.kind] - KIND_PRECEDENCE[b.kind];
  if (byKind !== 0) return byKind;

  // The final tiebreaker, which is what makes the order total. Entry ids are
  // prefixed by source ("order:abc"), so they are unique across every source.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Orders a timeline, newest first, deterministically. Does not mutate the input. */
export function sortTimeline<T extends OrderableEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(compareTimelineEntries);
}
