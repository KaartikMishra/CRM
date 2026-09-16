import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Previous / Next over a cursor-paginated list.
 *
 * The backend returns only a `nextCursor`, which is enough to go forward and
 * nothing more. Going back needs the cursor that opened the *previous* page, so
 * the pages visited so far are carried in the URL as a stack: Next pushes the
 * cursor it used, Previous pops it.
 *
 * Keeping the stack in the URL rather than in component state is what makes a
 * refresh, a bookmark and the browser's own Back button all behave.
 *
 * This is the same technique as the RS Products control, parameterised: Vendor
 * Invoices paginates three independent lists on one route — vendors, trades and
 * mappings — so each needs its own cursor keys rather than the single `cursor`
 * and `pages` that a one-list page can assume.
 *
 * No total is shown, and none is invented: a cursor API cannot know how many
 * pages remain, and printing a guess would be worse than printing nothing.
 */

export type PaginationState = {
  /** Cursors for the pages already visited, oldest first. */
  stack: string[];
  /** The cursor that opens the page after this one; null on the last page. */
  nextCursor: string | null;
  /** Everything except this list's cursor state, preserved across navigation. */
  filters: Record<string, string | undefined>;
  /** The query key holding this list's cursor, e.g. "cursor" or "tradeCursor". */
  cursorKey: string;
  /** The query key holding this list's stack, e.g. "pages" or "tradePages". */
  stackKey: string;
  /** Where the links point. */
  basePath: string;
  /** Names the control for assistive technology. */
  label: string;
};

/** Serialises the stack for the URL. Cuids contain no comma, so this is safe. */
export const encodeStack = (stack: string[]): string => stack.join(',');
export const decodeStack = (value: string | undefined): string[] =>
  value ? value.split(',').filter(Boolean) : [];

/** Builds a URL, dropping empty values so the address bar stays readable. */
export function buildHref(
  basePath: string,
  filters: Record<string, string | undefined>,
  stack: string[],
  cursorKey: string,
  stackKey: string,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }

  // The cursor is the last one pushed; the stack itself is what allows going
  // back past it.
  const cursor = stack.at(-1);
  if (cursor) {
    params.set(cursorKey, cursor);
    params.set(stackKey, encodeStack(stack));
  }

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function PaginationControls({
  stack,
  nextCursor,
  filters,
  cursorKey,
  stackKey,
  basePath,
  label,
}: PaginationState) {
  // Page 1 has an empty stack; each entry past that is one Next.
  const pageNumber = stack.length + 1;
  const hasPrevious = stack.length > 0;

  // A single page needs no control at all.
  if (!hasPrevious && !nextCursor) return null;

  const previousHref = buildHref(basePath, filters, stack.slice(0, -1), cursorKey, stackKey);
  const nextHref = nextCursor
    ? buildHref(basePath, filters, [...stack, nextCursor], cursorKey, stackKey)
    : '#';

  const base =
    'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors';
  const enabled = 'border-line text-ink hover:border-accent hover:text-accent';
  const disabled = 'pointer-events-none border-line-2 text-muted opacity-60';

  return (
    <nav
      className="flex items-center justify-between gap-3 border-t border-line px-4 py-3"
      aria-label={label}
    >
      {hasPrevious ? (
        <Link href={previousHref} className={cn(base, enabled)} rel="prev" scroll={false}>
          <ChevronLeft className="size-4" />
          Previous
        </Link>
      ) : (
        <span className={cn(base, disabled)} aria-disabled="true">
          <ChevronLeft className="size-4" />
          Previous
        </span>
      )}

      {/* A real page number, counted from the stack — not a total. */}
      <span className="text-sm text-muted">Page {pageNumber}</span>

      {nextCursor ? (
        <Link href={nextHref} className={cn(base, enabled)} rel="next" scroll={false}>
          Next
          <ChevronRight className="size-4" />
        </Link>
      ) : (
        <span className={cn(base, disabled)} aria-disabled="true">
          Next
          <ChevronRight className="size-4" />
        </span>
      )}
    </nav>
  );
}
