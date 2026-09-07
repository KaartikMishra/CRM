/**
 * Which catalogue entry a written product name refers to.
 *
 * Sales writes "Brass Cooker", procurement writes "Brasscooker", and both mean
 * the one thing sitting on the shelf. `normalizeProductName` already folds
 * those to a single key and the unique index on `normalizedName` already
 * guarantees at most one catalogue entry per key — this module is only the
 * place that *asks* the question, so the eight callers that used to each
 * decide product identity for themselves now get one answer.
 *
 * Matching is exact on the folded name and nothing else. No edit distance, no
 * similarity score, no prefix: "Brass Cooker" and "Brass Kadhai" are five
 * characters apart and are different products, so any threshold loose enough
 * to join a typo is loose enough to pool two products' stock — and a wrong
 * merge cannot be undone once orders and bills reference it.
 *
 * Resolution is a *read*. Finding the match does not write `productId`; that
 * stays an explicit act by someone who has seen both names.
 */

import { normalizeProductName } from '@rs/shared';
import * as repo from './procurement.repository.js';

/** What a name resolved to, and why, so callers need not re-derive it. */
export type ResolvedProduct = {
  id: string;
  name: string;
  isActive: boolean;
  onHand: number;
};

type Resolvable = { id: string; name: string; isActive: boolean; inventory: { onHand: number } | null };

const toResolved = (p: Resolvable): ResolvedProduct => ({
  id: p.id,
  name: p.name,
  isActive: p.isActive,
  onHand: p.inventory?.onHand ?? 0,
});

/**
 * An index of a catalogue the caller already holds.
 *
 * Built per request and thrown away: a map kept between requests would go
 * stale the moment another request catalogued something, and would quietly
 * reintroduce the duplicate it exists to prevent. Postgres stays the source
 * of truth; this is only a way to avoid asking it the same question N times.
 */
export function indexByNormalizedName(products: Resolvable[]): Map<string, ResolvedProduct> {
  const byKey = new Map<string, ResolvedProduct>();
  for (const p of products) byKey.set(normalizeProductName(p.name), toResolved(p));
  return byKey;
}

/** The catalogue entry a single written name refers to, or null. */
export async function resolveOne(name: string): Promise<ResolvedProduct | null> {
  const key = normalizeProductName(name);
  if (key === '') return null;
  const found = await repo.findProductByNormalizedName(key);
  return found ? toResolved(found) : null;
}

/**
 * The same question for many names at once, in one query.
 *
 * Keyed by the folded name rather than the written one, so callers look up
 * with `normalizeProductName(theirName)` and two spellings share an entry.
 */
export async function resolveMany(names: string[]): Promise<Map<string, ResolvedProduct>> {
  const keys = [...new Set(names.map(normalizeProductName))].filter((k) => k !== '');
  if (keys.length === 0) return new Map();
  return indexByNormalizedName(await repo.findProductsByNormalizedNames(keys));
}
