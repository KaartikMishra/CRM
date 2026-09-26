import { cn } from '@/lib/utils';

/**
 * A page that fills the main content area rather than growing past it.
 *
 * The shell bounds itself to the viewport, so `<main>` already has a real
 * height — but a page whose root is auto-height hands its full content height
 * straight back up, and `<main>` becomes the only thing that scrolls.
 * Everything then travels together: the title, the filters and the table all
 * leave the screen as one block.
 *
 * `h-full` is what stops that. It resolves against the height `<main>` already
 * has, so the page is exactly as tall as the space it was given, and the
 * scrolling can be handed to the regions inside it.
 *
 * Below `lg` the page stays auto-height on purpose. A phone has too little room
 * to divide into a pinned part and scrolling parts, and `<main>` scrolling the
 * whole page is the right behaviour there.
 */
export function ContentPage({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-6 lg:h-full lg:min-h-0', className)}>{children}</div>
  );
}

/**
 * Whatever stays put above the regions — the page header, and a filter bar
 * where the page has one.
 *
 * A flex child will otherwise be squeezed by a long sibling rather than holding
 * its size, which is exactly what must not happen to the controls somebody uses
 * to shorten the list underneath.
 */
export function ContentPageHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('flex shrink-0 flex-col gap-6', className)}>{children}</div>;
}

/**
 * One independently scrolling section of a `ContentPage`.
 *
 * A page may hold several. Procurement holds two long ones — requirement vs
 * stock, and the purchase bills — and they must not share a scrollbar: reading
 * to the end of one would otherwise carry the other off the screen, when the
 * whole point of showing them together is to read one against the other.
 *
 * `basis-0` with `flex-1` is what makes the split even. Without it the regions
 * would be apportioned by how much content each happens to hold, so a page
 * would rearrange itself as rows arrived.
 *
 * `min-h-0` is the part that is easy to leave out and impossible to work
 * around: a flex child defaults to `min-height: auto` and refuses to shrink
 * below its content, so without it a region pushes the page taller instead of
 * scrolling, and the bound on `ContentPage` achieves nothing.
 */
export function ContentRegion({
  children,
  className,
  fill = true,
}: {
  children: React.ReactNode;
  className?: string;
  /**
   * False when the section has nothing to scroll — an empty state, or an
   * error. It then takes only the height it needs, instead of holding open an
   * equal share of the page around a single small card.
   */
  fill?: boolean;
}) {
  return (
    <section
      className={cn(
        'flex min-h-0 flex-col gap-3',
        fill ? 'lg:flex-1 lg:basis-0' : 'shrink-0',
        className,
      )}
    >
      {children}
    </section>
  );
}

/**
 * A card that fills its `ContentRegion` and clips, so the scroll area inside it
 * has something to bound against.
 *
 * Exported as classes rather than a component because it is the existing `Card`
 * that has to carry them — wrapping `Card` in another box would put a border
 * around a border.
 */
export const contentCard = 'flex min-h-0 flex-col overflow-hidden lg:flex-1';

/**
 * The part of a `ContentRegion` that actually scrolls.
 *
 * Only vertical. Wide tables keep scrolling horizontally in their own `.scroll-x`
 * container, exactly as they did before.
 *
 * `overscroll-contain` stops a flick at the end of one region from carrying on
 * into whatever is behind it — which matters most on Procurement, where two of
 * these sit one above the other.
 */
export function ContentScrollArea({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain',
        className,
      )}
    >
      {children}
    </div>
  );
}
