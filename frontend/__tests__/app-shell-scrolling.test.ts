/**
 * Who scrolls, and where.
 *
 * Two bugs are guarded here, one per half of the file.
 *
 * 1. The shell was `flex min-h-screen`, so it grew with its content and the
 *    window did the scrolling. The sidebar, an ordinary flex child with no
 *    height of its own, scrolled away with everything else — taking the
 *    collapse control at its foot out of reach on any long page.
 *
 * 2. The pages then had no height either, so `<main>` absorbed all of it and
 *    became the only scroller. Titles, filters and tables all left the screen
 *    as one block, and on Procurement the two long sections — requirement vs
 *    stock, and the purchase bills — shared a single scrollbar, so reading to
 *    the end of one carried the other away.
 *
 * Both are asserted structurally, in this directory's established style. These
 * are layout classes with no runtime behaviour to render, and a jsdom test
 * without a real viewport could not tell a bounded scroll region from an
 * unbounded one anyway. Browser verification is a separate, manual step.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** The same file with its comments taken out, for assertions about code. */
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const shell = read('app/(app)/layout.tsx');
const sidebar = read('components/layout/sidebar.tsx');
const mobileNav = read('components/layout/mobile-nav.tsx');
const primitive = read('components/common/content-page.tsx');

const count = (source: string, needle: string): number => source.split(needle).length - 1;

/* ------------------------------------------------------------------ shell */

describe('the shell is exactly one viewport tall and clips its own overflow', () => {
  it('bounds the shell to the viewport', () => {
    expect(shell).toMatch(/<div className="flex h-dvh overflow-hidden">/);
  });

  it('never lets the shell grow with its content again', () => {
    expect(shell).not.toContain('min-h-screen');
    expect(shell).not.toContain('h-screen');
  });

  it('gives main a height to hand on, and a scroll of last resort', () => {
    const main = shell.slice(shell.indexOf('<main'), shell.indexOf('</main>'));
    expect(main).toContain('min-h-0');
    expect(main).toContain('overflow-y-auto');
    expect(shell).toContain('flex min-h-0 min-w-0 flex-1 flex-col');
  });
});

describe('the sidebar stays put and keeps its collapse control reachable', () => {
  it('fills the shell height rather than the content height', () => {
    expect(sidebar).toMatch(/aside[\s\S]*?h-full min-h-0/);
  });

  it('scrolls only the navigation region when the items overflow', () => {
    expect(sidebar).toContain('<nav className="min-h-0 flex-1 overflow-y-auto p-3"');
  });

  it('holds the logo header and the collapse control at a fixed size', () => {
    expect(sidebar).toContain('flex h-16 shrink-0 items-center border-b border-line');
    expect(sidebar).toContain('<div className="shrink-0 border-t border-line p-3">');
  });

  it('still carries the collapse control itself', () => {
    expect(sidebar).toContain("aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}");
  });
});

describe('the mobile drawer behaves the same way', () => {
  it('scrolls only its navigation region', () => {
    expect(mobileNav).toContain('<nav className="min-h-0 flex-1 overflow-y-auto p-3"');
  });

  it('keeps its header from being squeezed by a long nav', () => {
    expect(mobileNav).toContain('flex h-16 shrink-0 items-center border-b border-line px-5');
  });
});

describe('the header keeps its place', () => {
  it('sits outside the scrolling region, above it in the column', () => {
    expect(shell.indexOf('<Topbar')).toBeLessThan(shell.indexOf('<main'));
  });

  it('is untouched by any of this', () => {
    expect(read('components/layout/topbar.tsx')).toContain(
      'sticky top-0 z-30 flex h-16 shrink-0 items-center',
    );
  });
});

/* -------------------------------------------------------------- primitive */

describe('the bounded content region is defined once, not per page', () => {
  it('fills the height main already has, instead of growing past it', () => {
    expect(primitive).toContain('lg:h-full lg:min-h-0');
  });

  it('holds the pinned header at its own size', () => {
    expect(primitive).toContain('flex shrink-0 flex-col gap-6');
  });

  it('shares the height evenly between regions, whatever they hold', () => {
    // `basis-0` is what makes the split even. Without it the regions are
    // apportioned by content, so the page rearranges itself as rows arrive.
    expect(primitive).toContain('flex min-h-0 flex-col gap-3');
    expect(primitive).toContain("fill ? 'lg:flex-1 lg:basis-0' : 'shrink-0'");
  });

  it('lets a region with nothing to scroll stop claiming a share', () => {
    // Otherwise an empty Purchase Bills section holds open an equal share of
    // the page around one small card.
    expect(primitive).toContain('fill = true');
    expect(primitive).toContain('fill?: boolean');
  });

  it('gives the card inside a region something to bound against', () => {
    expect(primitive).toContain(
      "export const contentCard = 'flex min-h-0 flex-col overflow-hidden lg:flex-1'",
    );
  });

  it('lets the scrolling part shrink below its content', () => {
    // Without `min-h-0` it refuses to shrink, pushes the page taller, and the
    // bound on ContentPage achieves nothing.
    expect(primitive).toContain('lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain');
  });

  it('scrolls vertically only, leaving horizontal table scrolling alone', () => {
    expect(primitive).not.toContain('overflow-x');
    expect(read('components/ui/table.tsx')).toContain('scroll-x w-full');
  });

  it('leaves every table exactly one horizontal scroll container', () => {
    // RS Products wrapped the shared Table — which brings its own `.scroll-x` —
    // in a second `overflow-x-auto` div. The inner one is `w-full`, so the
    // outer could never scroll; it only nested one scroll container inside
    // another. Every table now relies on `.scroll-x` alone.
    for (const table of [
      'components/rs-products/product-table.tsx',
      'components/sales/sales-order-table.tsx',
      'components/procurement/purchase-bill-table.tsx',
    ]) {
      const code = codeOf(read(table));
      expect(code, table + ' adds its own overflow container').not.toContain('overflow-x');
      expect(code, table + ' adds its own overflow container').not.toContain('overflow-y');
    }
  });

  it('leaves small screens scrolling the main area, as they should', () => {
    // Every bounding rule is behind `lg:`. A phone has too little height to
    // split into a pinned strip and scrolling strips.
    //
    // Checked against the class strings alone; the prose above them in that
    // file naturally names the same utilities.
    const classes = codeOf(primitive)
      .match(/'[^']*'/g)
      ?.map((quoted) => quoted.slice(1, -1))
      .join(' ');

    expect(classes, 'no class strings found to check').toBeTruthy();

    for (const rule of ['h-full', 'flex-1', 'basis-0', 'overflow-y-auto', 'overscroll-contain']) {
      const ungated = (classes as string).split(/\s+/).filter((token) => token === rule);
      expect(ungated, rule + ' must be gated behind lg:').toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ pages */

describe('every long page is built from that one definition', () => {
  const pages = [
    ['Sales', 'app/(app)/sales/page.tsx'],
    ['Purchase & Procurement', 'app/(app)/procurement/page.tsx'],
    ['RS Products', 'app/(app)/rs-products/page.tsx'],
  ] as const;

  for (const [name, path] of pages) {
    describe(name, () => {
      const source = read(path);

      it('imports the shared primitive rather than rolling its own', () => {
        expect(source).toContain("from '@/components/common/content-page'");
        expect(source).toContain('<ContentPage>');
        expect(source).toContain('<ContentPageHeader>');
      });

      it('pins its header above everything that scrolls', () => {
        expect(source.indexOf('</ContentPageHeader>')).toBeLessThan(
          source.indexOf('<ContentRegion'),
        );
      });

      it('never wraps its whole body in one scroll container', () => {
        // The regression this replaces: a single scroll area straight after the
        // header, which made every section share one scrollbar.
        expect(source).not.toMatch(/<\/ContentPageHeader>\s*<ContentScrollArea>/);
      });

      it('owns no viewport height, scrolling or positioning of its own', () => {
        expect(source).not.toContain('min-h-screen');
        expect(source).not.toContain('h-screen');
        expect(source).not.toContain('100vh');
        expect(source).not.toContain('overflow-y-auto');
        expect(source).not.toContain('position: fixed');
        expect(source).not.toMatch(/\bfixed inset/);
      });

      it('no longer roots itself in a plain auto-height stack', () => {
        expect(source).not.toContain('<div className="flex flex-col gap-6">');
      });
    });
  }
});

describe('Sales scrolls its orders and nothing else', () => {
  const source = read('app/(app)/sales/page.tsx');

  it('keeps the title, the New Order button and the filters out of the scroll', () => {
    const pinned = source.slice(
      source.indexOf('<ContentPageHeader>'),
      source.indexOf('</ContentPageHeader>'),
    );
    expect(pinned).toContain('<PageHeader');
    expect(pinned).toContain('New Order');
    expect(pinned).toContain('<SalesFilters');
  });

  it('has exactly one scroll region, around the orders table', () => {
    expect(count(source, '<ContentScrollArea>')).toBe(1);
    const area = source.slice(
      source.indexOf('<ContentScrollArea>'),
      source.indexOf('</ContentScrollArea>'),
    );
    expect(area).toContain('<SalesOrderTable');
  });

  it('bounds that region in a card that can actually clip', () => {
    expect(source).toContain('<Card className={contentCard}>');
  });

  it('leaves the pager pinned at the foot of the card', () => {
    expect(source.indexOf('</ContentScrollArea>')).toBeLessThan(source.indexOf('Next page'));
    expect(source).toContain('flex shrink-0 items-center justify-between border-t border-line');
  });
});

describe('RS Products scrolls its products and nothing else', () => {
  const source = read('app/(app)/rs-products/page.tsx');

  it('keeps the title and the search bar out of the scroll', () => {
    const pinned = source.slice(
      source.indexOf('<ContentPageHeader>'),
      source.indexOf('</ContentPageHeader>'),
    );
    expect(pinned).toContain('<PageHeader');
    expect(pinned).toContain('<form');
    expect(pinned).toContain('name="q"');
  });

  it('has exactly one scroll region, around the product table', () => {
    expect(count(source, '<ContentScrollArea>')).toBe(1);
    const area = source.slice(
      source.indexOf('<ContentScrollArea>'),
      source.indexOf('</ContentScrollArea>'),
    );
    expect(area).toContain('<RsProductTable');
  });

  it('bounds that region in a card that can actually clip', () => {
    expect(source).toContain('<Card className={contentCard}>');
  });

  it('leaves the pager pinned at the foot of the card', () => {
    expect(source.indexOf('</ContentScrollArea>')).toBeLessThan(
      source.indexOf('<PaginationControls'),
    );
    expect(source).toContain('<div className="shrink-0">');
  });
});

describe('Procurement gives each long section its own scrollbar', () => {
  const page = read('app/(app)/procurement/page.tsx');
  const shortages = read('components/procurement/shortage-board.tsx');
  const changeQueue = read('components/procurement/product-change-queue.tsx');

  it('keeps the page title out of every scroll region', () => {
    const pinned = page.slice(
      page.indexOf('<ContentPageHeader>'),
      page.indexOf('</ContentPageHeader>'),
    );
    expect(pinned).toContain('Purchase & Procurement');
    expect(pinned).toContain('Add Purchase Bill');
  });

  it('never puts the two long sections under one scrollbar', () => {
    // The page owns one scroll region only — the bills. Requirement vs stock
    // brings its own, from its own component.
    expect(count(page, '<ContentScrollArea>')).toBe(1);
    const area = page.slice(
      page.indexOf('<ContentScrollArea>'),
      page.indexOf('</ContentScrollArea>'),
    );
    expect(area).toContain('<PurchaseBillTable');
  });

  it('gives Requirement vs stock a bounded scroll region of its own', () => {
    expect(shortages).toContain("from '@/components/common/content-page'");
    expect(shortages).toContain('<ContentRegion>');
    expect(shortages).toContain('<Card className={contentCard}>');
    expect(count(shortages, '<ContentScrollArea>')).toBe(1);
    const area = shortages.slice(
      shortages.indexOf('<ContentScrollArea>'),
      shortages.indexOf('</ContentScrollArea>'),
    );
    expect(area).toContain('<Table>');
  });

  it('gives Purchase bills a bounded scroll region of its own', () => {
    expect(page).toContain('<ContentRegion fill=');
    expect(page).toContain('<Card className={contentCard}>');
  });

  it('does not hold a share of the page open when there are no bills', () => {
    expect(page).toContain(
      '<ContentRegion fill={result.success && result.data.bills.length > 0}>',
    );
  });

  it('adds up to two independent regions on the page, three with the queue', () => {
    const onPage = count(page, '<ContentRegion');
    const fromShortages = count(shortages, '<ContentRegion');
    const fromQueue = count(changeQueue, '<ContentRegion');

    expect(onPage, 'the bills section').toBe(1);
    expect(fromShortages, 'requirement vs stock').toBe(1);
    expect(onPage + fromShortages).toBeGreaterThanOrEqual(2);

    // The approval queue renders only when something is pending, and gets its
    // own region too so it cannot push the other two off the page.
    expect(fromQueue, 'the approval queue').toBe(1);
    expect(count(changeQueue, '<ContentScrollArea')).toBe(1);
  });

  it('keeps each section heading out of its own scroll', () => {
    expect(page).toContain('<h2 className="shrink-0 text-sm font-semibold uppercase');
    expect(shortages).toContain('flex shrink-0 items-baseline justify-between gap-3');
    expect(changeQueue).toContain('flex shrink-0 items-baseline justify-between gap-3');
  });
});
