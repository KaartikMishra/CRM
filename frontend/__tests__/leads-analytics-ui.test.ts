/**
 * The /leads analytics dashboard — Phase 4E, frontend.
 *
 * Structural assertions in the style of the rest of this suite: the components
 * are read as source to prove facts a DOM-less test cannot reach — that no
 * figure is recomputed in the browser, that null and zero order values render
 * differently, and that an overdue follow-up is never drawn as an upcoming one.
 *
 * Comments are stripped first, so a test cannot pass on the strength of the
 * prose describing it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEAL_STATUSES,
  DEAL_STATUS_LABELS,
  LEAD_CHANNELS,
  LEAD_PROMPTNESS_LABELS,
  LEAD_PROMPTNESS_RATINGS,
  LEAD_SORTS,
  leadListQuerySchema,
} from '@rs/shared';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const codeOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const page = read('app/(app)/leads/page.tsx');
const table = read('components/leads/lead-table.tsx');
const badges = read('components/leads/lead-badges.tsx');
const apiClient = read('lib/lead-api.ts');
const nav = read('components/layout/nav-items.ts');

// ---------------------------------------------------------------------------
//  The query contract
// ---------------------------------------------------------------------------

describe('the analytics query', () => {
  it('uses the CRM cursor convention, not page numbers', () => {
    const parsed = leadListQuerySchema.parse({});
    expect(parsed).toHaveProperty('limit');
    expect(parsed).not.toHaveProperty('page');
    expect(parsed).not.toHaveProperty('pageSize');
  });

  it('defaults to newest-initiated first', () => {
    const parsed = leadListQuerySchema.parse({});
    expect(parsed.sort).toBe('initiatedAt');
    expect(parsed.direction).toBe('desc');
  });

  it('allowlists sort fields and refuses anything else', () => {
    for (const sort of LEAD_SORTS) {
      expect(leadListQuerySchema.safeParse({ sort }).success, sort).toBe(true);
    }
    expect(leadListQuerySchema.safeParse({ sort: 'customerName' }).success).toBe(false);
    expect(leadListQuerySchema.safeParse({ sort: 'id; DROP TABLE "Lead"' }).success).toBe(false);
  });

  it('omits the derived fields from the sort allowlist', () => {
    /*
      lastFollowUpAt and nextFollowUpAt are computed from activity rows, so
      Postgres cannot order by them without a per-lead subquery — the N+1 this
      phase exists to avoid. The table sorts on what the database holds.
    */
    expect([...LEAD_SORTS]).not.toContain('lastFollowUpAt');
    expect([...LEAD_SORTS]).not.toContain('nextFollowUpAt');
    expect([...LEAD_SORTS]).not.toContain('orderValue');
  });

  it('validates every filter against its vocabulary', () => {
    expect(leadListQuerySchema.safeParse({ dealStatus: 'WON' }).success).toBe(true);
    expect(leadListQuerySchema.safeParse({ dealStatus: 'PENDING' }).success).toBe(false);

    expect(leadListQuerySchema.safeParse({ channel: 'INDIAMART' }).success).toBe(true);
    expect(leadListQuerySchema.safeParse({ channel: 'EBAY' }).success).toBe(false);

    expect(leadListQuerySchema.safeParse({ promptness: 'NOT_RATED' }).success).toBe(true);
    expect(leadListQuerySchema.safeParse({ promptness: 'EXCELLENT' }).success).toBe(false);

    expect(leadListQuerySchema.safeParse({ allocation: 'SELF' }).success).toBe(true);
    expect(leadListQuerySchema.safeParse({ allocation: 'MINE' }).success).toBe(false);

    expect(leadListQuerySchema.safeParse({ followUp: 'overdue' }).success).toBe(true);
    expect(leadListQuerySchema.safeParse({ followUp: 'someday' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  The page
// ---------------------------------------------------------------------------

describe('the page', () => {
  it('gates on LEAD_DEAL', () => {
    const code = codeOf(page);
    expect(code).toContain("requireModule('LEAD_DEAL')");
    expect(code).toContain('NoModuleAccess');
  });

  it('borrows no other module permission', () => {
    const code = codeOf(page) + codeOf(table) + codeOf(apiClient);
    expect(code).not.toContain("'SALES'");
    expect(code).not.toContain("'PRODUCT_ENQUIRY'");
  });

  it('has a navigation entry under Create Lead / Deal', () => {
    const code = codeOf(nav);
    expect(code).toContain("href: '/leads'");
    expect(code).toContain("label: 'Lead / Deal Analytics'");
  });

  it('renders error and loading states', () => {
    expect(codeOf(page)).toContain('ErrorMessage');
    const loading = codeOf(read('app/(app)/leads/loading.tsx'));
    expect(loading).toContain('Skeleton');
  });

  it('distinguishes "no leads" from "no matches"', () => {
    const code = codeOf(table);
    expect(code).toContain('No leads match those filters');
    expect(code).toContain('No leads yet');
  });

  it('carries filters onto the next page, so paging keeps them', () => {
    expect(codeOf(page)).toContain('function nextHref');
    expect(codeOf(page)).toContain("query.set('cursor', cursor)");
  });

  it('says when a page was narrowed by a calculated field', () => {
    // A short page under a derived filter is not necessarily the last one.
    expect(codeOf(page)).toContain('narrowedByDerivedFilter');
  });
});

// ---------------------------------------------------------------------------
//  The toolbar
// ---------------------------------------------------------------------------

describe('the filter toolbar', () => {
  it('offers search and the four filters', () => {
    const code = codeOf(page);
    expect(code).toContain('name="q"');
    for (const name of ['dealStatus', 'channel', 'promptness', 'allocation']) {
      expect(code, name).toContain(`name="${name}"`);
    }
  });

  it('builds its options from the shared vocabularies', () => {
    const code = codeOf(page);
    expect(code).toContain('DEAL_STATUSES.map');
    expect(code).toContain('LEAD_CHANNELS.map');
    expect(code).toContain('LEAD_PROMPTNESS_RATINGS.map');
    // Not retyped — a hand-written label would drift from what the API accepts.
    expect(code).not.toContain("'IndiaMART'");
    expect(code).not.toContain("'In process'");
  });

  it('gives every filter an All option that clears it', () => {
    expect(codeOf(page)).toContain('<option value="">All</option>');
  });

  it('drops the cursor when filters change', () => {
    // A GET form submits only its named inputs, so `cursor` is not among them.
    const code = codeOf(page);
    expect(code).toContain('action="/leads"');
    expect(code).not.toContain('name="cursor"');
  });
});

// ---------------------------------------------------------------------------
//  The table
// ---------------------------------------------------------------------------

describe('the table', () => {
  it('shows the nine business columns', () => {
    const code = codeOf(table);
    for (const header of [
      'CX Name',
      'Deal Status',
      'Associate Promptness',
      'Channel',
      'Allocation',
      'Order Value',
      'Initiated On',
      'Last Follow-up',
      'Next Follow-up',
    ]) {
      expect(code, header).toContain(header);
    }
  });

  it('recomputes nothing — every figure comes from the API', () => {
    const code = codeOf(table) + codeOf(badges);
    /*
      No threshold literals, no score arithmetic, no order summing. Matched as
      comparisons rather than bare substrings, because Tailwind spacing classes
      (`gap-0.5`, `mt-0.5`) contain the same digits and mean nothing like it.
    */
    expect(code).not.toMatch(/[<>]=?\s*0\.(65|5)\b/);
    expect(code).not.toContain('LEAD_PROMPTNESS_THRESHOLDS');
    expect(code).not.toMatch(/onTime\s*\/\s*expected/);
    expect(code).not.toContain('reduce');
  });

  it('scrolls sideways through the Table container rather than claiming height', () => {
    const tableSource = codeOf(read('components/ui/table.tsx'));
    expect(tableSource).toContain('scroll-x');
  });

  it('uses the existing date and currency formatters', () => {
    const code = codeOf(table);
    expect(code).toContain('formatDateTime');
    expect(code).toContain('formatCurrency');
  });
});

describe('order value in the table', () => {
  it('shows an em dash for a missing value and a formatted figure otherwise', () => {
    const code = codeOf(table);
    expect(code).toContain('lead.orderValue == null');
    expect(code).toContain('formatCurrency(lead.orderValue)');
  });

  it('guards against undefined as well as null', () => {
    /*
      The regression this pins. `=== null` let `undefined` through, and a backend
      serving a response older than the field sends neither — so the cell reached
      `formatCurrency(undefined)` and `undefined.split('.')` took down the whole
      table. A nullish check costs nothing and survives that.
    */
    const code = codeOf(table);
    expect(code).not.toContain('lead.orderValue === null');
    expect(code).not.toContain('lead.requirementValue === null');
  });

  it('does not conflate no order with an order worth nothing', () => {
    // Nullish rather than falsy: '0.00' is truthy but 0 is not, and a falsy test
    // would print an em dash for a real order totalling nothing.
    const code = codeOf(table);
    expect(code).not.toMatch(/!lead\.orderValue/);
    expect(code).not.toContain("lead.orderValue || '—'");
    expect(code).not.toMatch(/lead\.orderValue\s*\?\s*formatCurrency/);
  });
});

describe('the follow-up columns', () => {
  it('shows an em dash when nothing is scheduled', () => {
    expect(codeOf(table)).toContain("lead.nextFollowUpAt ?");
  });

  it('shows Overdue instead of a fake next follow-up', () => {
    /*
      The distinction the calculator draws, carried into the UI: an overdue
      incomplete follow-up is outstanding, not upcoming, so it must never be
      drawn in the Next column as though it were a plan.
    */
    const code = codeOf(table);
    expect(code).toContain('Overdue');
    expect(code).toContain('lead.promptness.overdue > 0');
  });
});

// ---------------------------------------------------------------------------
//  Badges
// ---------------------------------------------------------------------------

describe('the deal status badge', () => {
  it('maps the three statuses onto the existing palette', () => {
    const code = codeOf(badges);
    expect(code).toContain("WON: { variant: 'positive' }");
    expect(code).toContain("LOST: { variant: 'critical' }");
    expect(code).toContain("INPROCESS: { variant: 'warning' }");
  });

  it('labels them from the shared constants', () => {
    expect(codeOf(badges)).toContain('DEAL_STATUS_LABELS[status]');
    expect(DEAL_STATUS_LABELS.INPROCESS).toBe('In process');
    expect([...DEAL_STATUSES]).toHaveLength(3);
  });
});

describe('the promptness badge', () => {
  it('maps the four ratings onto green/amber/red/neutral', () => {
    const code = codeOf(badges);
    expect(code).toContain("rating === 'GOOD'");
    expect(code).toContain("'positive'");
    expect(code).toContain("'warning'");
    expect(code).toContain("'critical'");
    expect(code).toContain("'neutral'");
    expect([...LEAD_PROMPTNESS_RATINGS]).toHaveLength(4);
  });

  it('shows the arithmetic beside a real rating', () => {
    const code = codeOf(badges);
    expect(code).toContain('{onTime}/{expected}');
  });

  it('never shows a percentage for NOT_RATED', () => {
    /*
      The whole reason the badge branches: 0% would read as bad performance, when
      NOT_RATED means there is nothing to measure or nobody to attribute it to.
    */
    const code = codeOf(badges);
    expect(code).toContain("rating === 'NOT_RATED' ?");
    expect(code).toContain('No measurable activity');
    expect(code).toContain('Unassigned');
  });

  it('distinguishes the two reasons for NOT_RATED', () => {
    // Unassigned and no-activity are different facts and must read differently.
    expect(codeOf(badges)).toContain('hasAssociate ?');
    expect(LEAD_PROMPTNESS_LABELS.NOT_RATED).toBe('Not rated');
  });

  it('surfaces the overdue count where there is one', () => {
    expect(codeOf(badges)).toContain('overdue > 0');
  });
});

describe('the allocation badge', () => {
  it('renders all three states', () => {
    const code = codeOf(badges);
    expect(code).toContain("allocation === 'UNASSIGNED'");
    expect(code).toContain("allocation === 'SELF'");
    expect(code).toContain('Other user');
  });
});

// ---------------------------------------------------------------------------
//  Phase boundary
// ---------------------------------------------------------------------------

describe('Phase 4F is not implemented here', () => {
  it('adds no product requirement UI', () => {
    const code = codeOf(page) + codeOf(table) + codeOf(badges) + codeOf(apiClient);
    for (const absent of [
      'ProductRequirement',
      'matchKind',
      'Complete the Ideal',
      'rsProductId',
      'Cloudinary',
      'imageId',
    ]) {
      expect(code, absent).not.toContain(absent);
    }
  });
});
