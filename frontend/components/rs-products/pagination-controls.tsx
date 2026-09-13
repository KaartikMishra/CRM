import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Previous / Next over a cursor-paginated catalogue.
 *
 * The backend returns only a `nextCursor`, which is enough to go forward and
 * nothing more. Going back needs the cursor that opened the *previous* page, so
 * the pages visited so far are carried in the URL as a stack: Next pushes the
 * cursor it used, Previous pops it.
 *
 * Keeping the stack in the URL rather than in component state is what makes a
 * refresh, a bookmark and the browser's own Back button all behave. The
 * alternative — asking the backend for a `prevCursor` — would cost a second
 * reversed query on every page load to solve a problem the URL already can.
 *
 * Any change to search or filters drops the stack, because a cursor from one
 * result set means nothing in another.
 */

export type PaginationState = {
  /** Cursors for the pages already visited, oldest first. */
  stack: string[];
  /** The cursor that opens the page after this one; null on the last page. */
  nextCursor: string | null;
  /** Everything except cursor state, preserved across navigation. */
  filters: Record<string, string | undefined>;
};

/** Serialises the stack for the URL. Cuids contain no comma, so this is safe. */
export const encodeStack = (stack: string[]): string => stack.join(',');
export const decodeStack = (value: string | undefined): string[] =>
  value ? value.split(',').filter(Boolean) : [];

/** Builds a catalogue URL, dropping empty values so the bar stays readable. */
function buildHref(filters: Record<string, string | undefined>, stack: string[]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }

  // The cursor is the last one pushed; the stack itself is what allows going
  // back past it.
  const cursor = stack.at(-1);
  if (cursor) {
    params.set('cursor', cursor);
    params.set('pages', encodeStack(stack));
  }

  const query = params.toString();
  return query ? `/rs-products?${query}` : '/rs-products';
}

export function PaginationControls({ stack, nextCursor, filters }: PaginationState) {
  // Page 1 has an empty stack; each entry past that is one Next.
  const pageNumber = stack.length + 1;
  const hasPrevious = stack.length > 0;

  const previousHref = buildHref(filters, stack.slice(0, -1));
  const nextHref = nextCursor ? buildHref(filters, [...stack, nextCursor]) : '#';

  const base =
    'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors';
  const enabled = 'border-line text-ink hover:border-accent hover:text-accent';
  const disabled = 'pointer-events-none border-line-2 text-muted opacity-60';

  return (
    <nav
      className="flex items-center justify-between gap-3 border-t border-line px-4 py-3"
      aria-label="Catalogue pages"
    >
      {hasPrevious ? (
        <Link href={previousHref} className={cn(base, enabled)} rel="prev">
          <ChevronLeft className="size-4" />
          Previous
        </Link>
      ) : (
        <span className={cn(base, disabled)} aria-disabled="true">
          <ChevronLeft className="size-4" />
          Previous
        </span>
      )}

      {/* A real page number, counted from the stack — not invented, and not a
          total, because a cursor API cannot know how many pages remain. */}
      <span className="text-sm text-muted">Page {pageNumber}</span>

      {nextCursor ? (
        <Link href={nextHref} className={cn(base, enabled)} rel="next">
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
