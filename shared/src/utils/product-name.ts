/**
 * Product identity, folded to one key.
 *
 * A person writing "Kansa Dinner Set" on an order and "kansadinnerset" on a
 * bill means the same thing, and the catalogue must hold that thing once. The
 * fold is deliberately aggressive — case *and* every space — because the two
 * spellings above are the real ones this CRM already contains, and treating
 * them as different products would split their stock in half.
 *
 * This is the single definition. The migration backfills with the equivalent
 * SQL, the API looks up and creates through it, and the picker searches with
 * it; a second, subtly different implementation would let the UI offer to
 * create a product the database then refuses.
 *
 * It decides *identity*, never *display*. `Product.name` keeps the spelling it
 * was given and is never rewritten to match the fold.
 */
export function normalizeProductName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}
