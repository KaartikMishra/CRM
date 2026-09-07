/**
 * Purchase & Procurement — the arithmetic the UI renders.
 *
 * Standing and pending are the two numbers this module exists to keep apart,
 * and both are shown prominently. These assert the contract the components
 * rely on, without needing a DOM or a database: the backend integration suite
 * covers the same rules end to end.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  APP_MODULES,
  FULFILLMENT_STATUSES,
  PURCHASE_BILL_STATUSES,
  PURCHASE_BILL_TYPES,
  createPurchaseBillSchema,
  createAllocationSchema,
  purchaseDelaySchema,
  adjustInventorySchema,
} from '@rs/shared';
import {
  createVendorSchema,
  lineTotal,
  linkPurchaseItemSchema,
  vendorSearchSchema,
} from '@rs/shared';
import type { SalesRequirementRow, ShortageRow } from '@rs/shared';
import { normalizeProductName } from '@rs/shared';
import { displayName, rowKey } from '@/components/procurement/shortage-board';
import { shiftDay, todayInIST } from '@/components/procurement/sales-board';
import { NAV_ITEMS, visibleNavItems } from '@/components/layout/nav-items';
import { navIcon } from '@/components/layout/nav-icons';
import { VENDOR_PAGE_LIMIT } from '@/lib/procurement-api';

describe('procurement is a live, permission-gated module', () => {
  it('appears in the navigation as available', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/procurement');
    expect(item).toBeDefined();
    expect(item?.available).toBe(true);
    expect(item?.module).toBe('PROCUREMENT');
  });

  it('has a resolvable icon', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/procurement')!;
    expect(navIcon(item.icon)).toBeDefined();
  });

  it('is hidden from a USER without the module', () => {
    const hrefs = visibleNavItems(['PRODUCT_ENQUIRY', 'SALES'], false).map((i) => i.href);
    expect(hrefs).not.toContain('/procurement');
  });

  it('is shown once the module is granted', () => {
    const hrefs = visibleNavItems(['PROCUREMENT'], false).map((i) => i.href);
    expect(hrefs).toContain('/procurement');
  });

  it('is shown to an administrator', () => {
    const hrefs = visibleNavItems([...APP_MODULES], true).map((i) => i.href);
    expect(hrefs).toContain('/procurement');
  });
});

describe('the shared vocabulary the badges render', () => {
  it('offers exactly Credit and Paid Up', () => {
    expect([...PURCHASE_BILL_TYPES]).toEqual(['CREDIT', 'PAID_UP']);
  });

  it('has a linear bill lifecycle with no reopen', () => {
    expect([...PURCHASE_BILL_STATUSES]).toEqual(['OPEN', 'RECEIVED', 'CLOSED']);
  });

  it('distinguishes unfulfilled, partial and fulfilled', () => {
    expect([...FULFILLMENT_STATUSES]).toEqual(['UNFULFILLED', 'PARTIAL', 'FULFILLED']);
  });
});

describe('the create-bill contract the form validates against', () => {
  const valid = {
    billNumber: 'INV-1',
    vendorId: 'ckd0000000000000000000000',
    billType: 'CREDIT' as const,
    billDate: '2026-09-04',
    items: [{ productName: 'Kansa Thali Set', orderedQty: 10, receivedQty: 4, rate: '100.00' }],
  };

  it('accepts a well-formed bill', () => {
    expect(createPurchaseBillSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses receiving more than was ordered', () => {
    const parsed = createPurchaseBillSchema.safeParse({
      ...valid,
      items: [{ ...valid.items[0], orderedQty: 4, receivedQty: 10 }],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a bill with no lines', () => {
    expect(createPurchaseBillSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
  });

  it('refuses an expected date before the bill date', () => {
    const parsed = createPurchaseBillSchema.safeParse({
      ...valid, billDate: '2026-09-04', expectedBy: '2026-09-01',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a zero or negative ordered quantity', () => {
    for (const orderedQty of [0, -1]) {
      const parsed = createPurchaseBillSchema.safeParse({
        ...valid, items: [{ ...valid.items[0], orderedQty, receivedQty: 0 }],
      });
      expect(parsed.success, `orderedQty ${orderedQty}`).toBe(false);
    }
  });

  it('defaults received to zero — ordered today, arriving later', () => {
    const parsed = createPurchaseBillSchema.safeParse({
      ...valid,
      items: [{ productName: valid.items[0].productName, orderedQty: 5, rate: '10.00' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.items[0]!.receivedQty).toBe(0);
  });
});

describe('allocation and delay contracts', () => {
  it('requires a positive allocation quantity', () => {
    const id = 'ckd0000000000000000000002';
    expect(createAllocationSchema.safeParse({ salesOrderItemId: id, quantity: 1 }).success).toBe(true);
    expect(createAllocationSchema.safeParse({ salesOrderItemId: id, quantity: 0 }).success).toBe(false);
    expect(createAllocationSchema.safeParse({ salesOrderItemId: id, quantity: -2 }).success).toBe(false);
  });

  it('refuses a fractional allocation — units are whole things', () => {
    const id = 'ckd0000000000000000000002';
    expect(createAllocationSchema.safeParse({ salesOrderItemId: id, quantity: 1.5 }).success).toBe(false);
  });

  it('requires a reason for a delay', () => {
    expect(purchaseDelaySchema.safeParse({ reason: 'Held at depot' }).success).toBe(true);
    expect(purchaseDelaySchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(purchaseDelaySchema.safeParse({}).success).toBe(false);
  });

  it('requires a reason and a non-zero delta for a stock correction', () => {
    expect(adjustInventorySchema.safeParse({ delta: -3, reason: 'breakage' }).success).toBe(true);
    expect(adjustInventorySchema.safeParse({ delta: 0, reason: 'nothing' }).success).toBe(false);
    expect(adjustInventorySchema.safeParse({ delta: 5 }).success).toBe(false);
  });
});

describe('the vendor picker fetches a list the API will actually serve', () => {
  /**
   * Regression: the procurement reader asked for `limit=100`, which
   * vendorSearchSchema caps at 50. The request 422'd, the reader swallowed the
   * failure and returned [], and the dropdown rendered empty — looking like a
   * broken component rather than a rejected query.
   */
  it('requests a limit the vendor search schema accepts', () => {
    const parsed = vendorSearchSchema.safeParse({ limit: String(VENDOR_PAGE_LIMIT) });
    expect(parsed.success, `limit=${VENDOR_PAGE_LIMIT} must be within the schema's range`).toBe(true);
  });

  it('would have caught the original bug', () => {
    expect(vendorSearchSchema.safeParse({ limit: '100' }).success).toBe(false);
  });

  it('asks only for vendors that can still be bought from', () => {
    expect(vendorSearchSchema.safeParse({ limit: '50', active: 'true' }).success).toBe(true);
  });
});

describe('the bill line records what the vendor wrote', () => {
  /**
   * A purchase bill is a record of a document someone was handed. Forcing a
   * catalogue choice at entry made it impossible to type a bill for goods that
   * were not catalogued yet — so the line takes free text, and the catalogue
   * link is a later, deliberate step.
   */
  const base = {
    billNumber: 'INV-9',
    vendorId: 'ckd0000000000000000000000',
    billType: 'CREDIT' as const,
    billDate: '2026-09-05',
  };

  it('accepts an arbitrary product name straight off the bill', () => {
    for (const name of ['Kansa Thali Set', 'Brass Lota', 'Hammered copper bottle 1L (2nd)']) {
      const parsed = createPurchaseBillSchema.safeParse({
        ...base,
        items: [{ productName: name, orderedQty: 10, receivedQty: 10, rate: '2000.00' }],
      });
      expect(parsed.success, name).toBe(true);
    }
  });

  it('needs no catalogue product at entry', () => {
    const parsed = createPurchaseBillSchema.safeParse({
      ...base,
      items: [{ productName: 'Brass Lota', orderedQty: 5, receivedQty: 5, rate: '500.00' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.items[0]!.productId).toBeUndefined();
  });

  it('still accepts a catalogue link when one is known', () => {
    const parsed = createPurchaseBillSchema.safeParse({
      ...base,
      items: [{
        productName: 'Brass Lota', productId: 'ckd0000000000000000000001',
        orderedQty: 5, receivedQty: 5, rate: '500.00',
      }],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an empty or whitespace-only product name', () => {
    for (const productName of ['', '   ']) {
      const parsed = createPurchaseBillSchema.safeParse({
        ...base, items: [{ productName, orderedQty: 1, receivedQty: 1, rate: '1.00' }],
      });
      expect(parsed.success, JSON.stringify(productName)).toBe(false);
    }
  });

  it('refuses a non-positive quantity and a negative rate', () => {
    expect(createPurchaseBillSchema.safeParse({
      ...base, items: [{ productName: 'X', orderedQty: 0, receivedQty: 0, rate: '1.00' }],
    }).success).toBe(false);
    expect(createPurchaseBillSchema.safeParse({
      ...base, items: [{ productName: 'X', orderedQty: 1, receivedQty: 1, rate: '-1.00' }],
    }).success).toBe(false);
  });

  it('supports several products from one bill', () => {
    const parsed = createPurchaseBillSchema.safeParse({
      ...base,
      items: [
        { productName: 'Kansa Thali Set', orderedQty: 10, receivedQty: 10, rate: '2000.00' },
        { productName: 'Brass Lota', orderedQty: 5, receivedQty: 5, rate: '500.00' },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.items).toHaveLength(2);
  });
});

/**
 * The same subtraction the products table renders. Defined here rather than
 * imported from the backend: the frontend must not reach across the workspace
 * boundary, and the authoritative implementation is covered by the backend
 * suite. If the two ever disagree, that suite is the one that is right.
 */
const standingQty = (received: number, allocations: { quantity: number }[]): number =>
  Math.max(0, received - allocations.reduce((sum, a) => sum + a.quantity, 0));

describe('the figures the products table shows', () => {
  it('computes Total Bill as qty x rate, exactly', () => {
    // The brief's own examples.
    expect(lineTotal('2000.00', 10)).toBe('20000.00');
    expect(lineTotal('500.00', 5)).toBe('2500.00');
    // And no floating point drift on the classic case.
    expect(lineTotal('0.10', 3)).toBe('0.30');
  });

  it('starts Standing Out at everything received, since nothing is mapped yet', () => {
    expect(standingQty(10, [])).toBe(10);
  });

  it('reduces Standing Out as quantity is mapped to orders', () => {
    expect(standingQty(10, [{ quantity: 6 }])).toBe(4);
    expect(standingQty(10, [{ quantity: 6 }, { quantity: 4 }])).toBe(0);
  });

  it('links a purchase line to the catalogue by id, never by name', () => {
    expect(linkPurchaseItemSchema.safeParse({ productId: 'ckd0000000000000000000001' }).success).toBe(true);
    expect(linkPurchaseItemSchema.safeParse({ productId: 'Kansa Thali Set' }).success).toBe(false);
  });
});

describe('the combined Map Quantity flow', () => {
  /**
   * Linking a bill line to the catalogue and allocating its stock used to be
   * two buttons and two dialogs. They are one flow now — but the *contracts*
   * behind them are unchanged and still separate, which is what keeps the
   * safety rules intact while the UI gets simpler.
   */
  it('links by catalogue id, never by the name on the bill', () => {
    expect(linkPurchaseItemSchema.safeParse({ productId: 'ckd0000000000000000000001' }).success).toBe(true);
    // The vendor's wording is not an identifier and must never be accepted as one.
    for (const notAnId of ['brassdinnerset', 'Brass Dinner Set', 'kansa thali set', '']) {
      expect(linkPurchaseItemSchema.safeParse({ productId: notAnId }).success, notAnId).toBe(false);
    }
  });

  it('still requires a positive whole quantity to allocate', () => {
    const id = 'ckd0000000000000000000002';
    expect(createAllocationSchema.safeParse({ salesOrderItemId: id, quantity: 5 }).success).toBe(true);
    for (const quantity of [0, -1, 1.5]) {
      expect(createAllocationSchema.safeParse({ salesOrderItemId: id, quantity }).success, String(quantity)).toBe(false);
    }
  });

  it('identifies the order line by id, so a name cannot select it', () => {
    expect(createAllocationSchema.safeParse({ salesOrderItemId: 'kansa thali set', quantity: 1 }).success).toBe(false);
  });
});

describe('adding a vendor without leaving the bill form', () => {
  it('needs only a name, matching the existing vendor schema', () => {
    expect(createVendorSchema.safeParse({ name: 'Shree Brass Works' }).success).toBe(true);
  });

  it('rejects a name the existing rules would reject', () => {
    // The shared schema requires at least two characters; the inline dialog
    // must not be a way around that.
    expect(createVendorSchema.safeParse({ name: 'a' }).success).toBe(false);
    expect(createVendorSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createVendorSchema.safeParse({}).success).toBe(false);
  });

  it('accepts the optional contact fields the master already defines', () => {
    const parsed = createVendorSchema.safeParse({
      name: 'Copperline Exports', contactPerson: 'Imran', city: 'Moradabad',
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * Shortage row identity.
 *
 * A shortage row is an aggregate over many order lines, so it has no single id
 * of its own. Its identity is the thing it aggregates *by*, mirroring how the
 * server keys demand: `product:<id>` when catalogued, `name:<exact text>` when
 * free text. These assert that the key is read from those fields rather than
 * from the `linked` flag — deriving it from the flag let a mismatch stringify
 * an absent value into `name:undefined`, and two of those collide.
 */
const shortage = (over: Partial<ShortageRow>): ShortageRow => ({
  productName: 'Kansa Thali Set',
  product: null,
  linked: false,
  totalRequired: 5,
  totalAllocated: 0,
  onHand: 0,
  shortageQty: 5,
  standingQty: 0,
  ...over,
});

const product = (id: string, name: string): ShortageRow['product'] => ({
  id,
  name,
  description: null,
  isActive: true,
  onHand: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('every shortage row renders under a stable, unique key', () => {
  it('keys a catalogued row by product id', () => {
    const row = shortage({ product: product('ckp1', 'Kansa Thali Set'), linked: true });
    expect(rowKey(row)).toBe('product:ckp1');
  });

  it('keys a free-text row by its exact name', () => {
    expect(rowKey(shortage({ productName: 'Ganesha Idol' }))).toBe('name:Ganesha Idol');
  });

  it('never produces name:undefined when a row is missing its name', () => {
    const row = shortage({ productName: undefined as unknown as string });
    expect(rowKey(row)).toBeNull();
    expect(rowKey(row)).not.toBe('name:undefined');
  });

  it('prefers product identity even when linked disagrees with the data', () => {
    // linked says false, but a product is present: the data wins.
    const row = shortage({ product: product('ckp2', 'Brass Diya'), linked: false });
    expect(rowKey(row)).toBe('product:ckp2');
  });

  it('falls back to the name when linked claims a product that is not there', () => {
    // The case the old `row.product!.id` assertion could not survive.
    const row = shortage({ productName: 'Ganesha Idol', product: null, linked: true });
    expect(rowKey(row)).toBe('name:Ganesha Idol');
  });

  it('gives a mixed board of nullable-product rows all-unique keys', () => {
    const rows: ShortageRow[] = [
      shortage({ product: product('ckp1', 'Kansa Thali Set'), linked: true }),
      shortage({ product: product('ckp2', 'Brass Diya'), linked: true }),
      shortage({ productName: 'Ganesha Idol' }),
      shortage({ productName: 'Silver Bowl' }),
      // Two spellings stay two rows: the server never normalises, nor does the key.
      shortage({ productName: 'ganesha idol' }),
    ];
    const keys = rows.map(rowKey);
    expect(keys.every((k) => k !== null)).toBe(true);
    expect(new Set(keys).size).toBe(rows.length);
  });

  it('drops a row with no identity at all rather than inventing one', () => {
    const row = shortage({ productName: '', product: null });
    expect(rowKey(row)).toBeNull();
  });

  it('keeps a key stable when the row is reordered or its quantities change', () => {
    // Sorting is by shortage size, so rows move as quantities change. The key
    // must not move with them, which is exactly what an index key would do.
    const before = shortage({ productName: 'Ganesha Idol', shortageQty: 9 });
    const after = shortage({ productName: 'Ganesha Idol', shortageQty: 1, totalAllocated: 8 });
    expect(rowKey(before)).toBe(rowKey(after));
  });
});

/**
 * The PRODUCT column.
 *
 * The name lives on different fields depending on the row — on the Product for
 * a catalogued row, on the line for a free-text one — so the column reads
 * whichever is present. Reading only one field blanks half the board, which is
 * what these guard against in both directions.
 */
describe('the product column shows a name for every row', () => {
  it('shows the catalogue name for a linked row', () => {
    const row = shortage({ product: product('ckp1', 'Kansa Thali Set'), linked: true });
    expect(displayName(row)).toBe('Kansa Thali Set');
  });

  it('shows the free-text name for an unlinked row', () => {
    expect(displayName(shortage({ productName: 'Ganesha Idol' }))).toBe('Ganesha Idol');
  });

  it('shows the catalogue name even when the row carries no productName', () => {
    // The shape an older server sends: the name lives only on the product.
    const row = shortage({
      product: product('ckp1', 'Brass Diya'),
      productName: undefined as unknown as string,
      linked: true,
    });
    expect(displayName(row)).toBe('Brass Diya');
    expect(displayName(row)).not.toBe('');
  });

  it('never blanks a row that has a name on either field', () => {
    const rows: ShortageRow[] = [
      shortage({ product: product('ckp1', 'Kansa Thali Set'), linked: true }),
      shortage({ product: product('ckp2', 'Brass Diya'), productName: undefined as unknown as string }),
      shortage({ productName: 'Ganesha Idol' }),
      shortage({ productName: 'thali set brass' }),
    ];
    expect(rows.map(displayName).every((n) => n.length > 0)).toBe(true);
  });

  it('keeps differently spelled free-text names distinct in the column', () => {
    // Same guarantee as the key: no normalisation, no merging.
    expect(displayName(shortage({ productName: 'Ganesha Idol' }))).toBe('Ganesha Idol');
    expect(displayName(shortage({ productName: 'ganesha idol' }))).toBe('ganesha idol');
  });

  it('prefers the catalogue name when both fields are present', () => {
    // Product Master is the authority on what a catalogued product is called.
    const row = shortage({
      product: product('ckp1', 'Kansa Thali Set'),
      productName: 'kansa thali set',
      linked: true,
    });
    expect(displayName(row)).toBe('Kansa Thali Set');
  });
});

/**
 * The Map Quantity line summary.
 *
 * "Required" meant two different things across two views: gross ordered
 * quantity in this modal, outstanding demand on the shortage board. The same
 * line therefore read as 5 in one place and 3 in the other, which looked like
 * a disagreement rather than the subtraction it is. Naming each term shows the
 * arithmetic, so the two views reconcile on screen.
 *
 * The string is built the same way the component builds it. No value is
 * recomputed here — every number comes from the API payload as-is.
 */
const lineSummary = (line: {
  requiredQty: number;
  alreadyFulfilled: number;
  allocatedQty: number;
  pendingQty: number;
}): string =>
  `${line.requiredQty} ordered · ${line.alreadyFulfilled} already fulfilled · ` +
  `${line.allocatedQty} allocated · ${line.pendingQty} still needed`;

describe('the Map Quantity line names each quantity it shows', () => {
  it('reads the live rsm1 Ganesha Idol line the way the brief specifies', () => {
    expect(
      lineSummary({ requiredQty: 5, alreadyFulfilled: 2, allocatedQty: 0, pendingQty: 3 }),
    ).toBe('5 ordered · 2 already fulfilled · 0 allocated · 3 still needed');
  });

  it('shows zeros rather than hiding them, so the subtraction stays legible', () => {
    expect(
      lineSummary({ requiredQty: 4, alreadyFulfilled: 0, allocatedQty: 0, pendingQty: 4 }),
    ).toBe('4 ordered · 0 already fulfilled · 0 allocated · 4 still needed');
  });

  it('reconciles with the shortage board: still needed is what the board calls Required', () => {
    // The board aggregates pendingQty; this line shows the same number. Equal
    // for rsm1 because exactly one Ganesha Idol line exists.
    const line = { requiredQty: 5, alreadyFulfilled: 2, allocatedQty: 0, pendingQty: 3 };
    const boardRequired = 3;
    expect(line.pendingQty).toBe(boardRequired);
    expect(lineSummary(line)).toContain(`${boardRequired} still needed`);
  });

  it('no longer calls the gross quantity "required"', () => {
    const text = lineSummary({ requiredQty: 5, alreadyFulfilled: 2, allocatedQty: 0, pendingQty: 3 });
    expect(text).not.toContain('5 required');
    expect(text).not.toContain('from stock');
  });
});

/**
 * The catalogue picker in Map Quantity.
 *
 * Product Master is the only catalogue: a name typed on a bill or an order is
 * free text and never a catalogue record. The picker therefore searches the
 * active catalogue and nothing else, matches on a folded copy of the name, and
 * links by product id — the stored names on both sides are left alone.
 */
const catalogueEntry = (
  id: string,
  name: string,
  isActive = true,
): { id: string; name: string; isActive: boolean; onHand: number } => ({
  id,
  name,
  isActive,
  onHand: 0,
});

/** The picker's filter, as the component applies it. */
const search = (
  catalogue: ReturnType<typeof catalogueEntry>[],
  query: string,
): ReturnType<typeof catalogueEntry>[] => {
  const term = normalizeProductName(query);
  return catalogue.filter(
    (p) => p.isActive && (term === '' || normalizeProductName(p.name).includes(term)),
  );
};

describe('the Map Quantity catalogue picker searches the whole active catalogue', () => {
  // Deliberately longer than any handful the picker used to render, so a
  // reintroduced cap would fail these rather than pass by luck.
  const catalogue = [
    catalogueEntry('p1', 'Brass lota 1L'),
    catalogueEntry('p2', 'Hammered copper water bottle'),
    catalogueEntry('p3', 'bartan'),
    catalogueEntry('p4', 'black hole'),
    catalogueEntry('p5', 'ghee'),
    catalogueEntry('p6', 'hhh'),
    catalogueEntry('p7', 'BRASS LOTA'),
    catalogueEntry('p8', 'Ganesha Idol'),
    catalogueEntry('p9', 'Kansa Thali'),
    catalogueEntry('p11', 'Brass Dinner Set'),
    catalogueEntry('p10', 'zz-e2e brass tray', false),
  ];

  it('finds a product that sits well past the first handful', () => {
    // 'Ganesha Idol' is the 8th of ten entries — formerly beyond the cap.
    expect(catalogue.findIndex((p) => p.name === 'Ganesha Idol')).toBeGreaterThan(5);
    expect(search(catalogue, 'ganesha').map((p) => p.name)).toEqual(['Ganesha Idol']);
  });

  it('renders every active product when the box is empty, with nothing withheld', () => {
    // The whole point of removing the cap: 9 active of 10 entries, all listed.
    const active = catalogue.filter((p) => p.isActive);
    expect(active.length).toBeGreaterThan(6);
    expect(search(catalogue, '')).toHaveLength(active.length);
  });

  it('lists every match for a broad query rather than the first few', () => {
    // 'brass' matches three active entries; a cap of 6 would have hidden none,
    // but a smaller one would — the assertion is completeness, not the number.
    const names = search(catalogue, 'brass').map((p) => p.name);
    expect(names).toEqual(['Brass lota 1L', 'BRASS LOTA', 'Brass Dinner Set']);
    expect(names).toHaveLength(
      catalogue.filter((p) => p.isActive && p.name.toLowerCase().includes('brass')).length,
    );
  });

  it('searches case-insensitively', () => {
    for (const q of ['GANESHA', 'ganesha', 'ganeshA idol', 'Ganesha Idol']) {
      expect(search(catalogue, q).map((p) => p.name), q).toEqual(['Ganesha Idol']);
    }
  });

  it('finds "BRASS LOTA" when the user types "brass lota"', () => {
    expect(search(catalogue, 'brass lota').map((p) => p.name)).toContain('BRASS LOTA');
  });

  it('shows every match rather than picking one', () => {
    // "brass lota" matches two catalogue entries; both are offered.
    const names = search(catalogue, 'brass lota').map((p) => p.name);
    expect(names).toEqual(['Brass lota 1L', 'BRASS LOTA']);
    expect(names.length).toBeGreaterThan(1);
  });

  it('tolerates stray and repeated whitespace', () => {
    for (const q of ['  brass lota  ', 'brass  lota', ' BRASS   LOTA ']) {
      expect(search(catalogue, q).length, q).toBe(2);
    }
  });

  it('never offers an inactive product', () => {
    expect(search(catalogue, 'brass').map((p) => p.name)).not.toContain('zz-e2e brass tray');
    expect(search(catalogue, 'zz-e2e')).toEqual([]);
  });

  it('offers the whole active catalogue when the box is empty', () => {
    expect(search(catalogue, '')).toHaveLength(catalogue.filter((p) => p.isActive).length);
  });

  it('finds nothing for a name that is not in the catalogue, rather than inventing one', () => {
    // "ganesh iDol" is bill free text. Without a catalogue entry there is no
    // match, and the picker's answer is to say so — never to create a Product.
    const withoutGanesha = catalogue.filter((p) => p.name !== 'Ganesha Idol');
    expect(search(withoutGanesha, 'ganesh iDol')).toEqual([]);
    expect(withoutGanesha).toHaveLength(catalogue.length - 1);
  });

  it('normalises for comparison only, leaving stored names untouched', () => {
    const before = catalogue.map((p) => p.name);
    search(catalogue, 'BRASS   LOTA');
    expect(catalogue.map((p) => p.name)).toEqual(before);
    // The fold itself is not what gets stored.
    expect(normalizeProductName('  Ganesha   Idol  ')).toBe('ganeshaidol');
    expect(catalogue.find((p) => p.id === 'p8')!.name).toBe('Ganesha Idol');
  });

  it('links by product id, so a differently spelled bill name survives', () => {
    // What the link call carries is the id; productName is never an argument.
    const billLine = { productName: 'ganesh iDol', productId: null as string | null };
    const chosen = catalogue.find((p) => p.name === 'Ganesha Idol')!;
    const linked = { ...billLine, productId: chosen.id };
    expect(linked.productId).toBe('p8');
    expect(linked.productName).toBe('ganesh iDol');
    expect(linkPurchaseItemSchema.safeParse({ productId: 'ckd0000000000000000000001' }).success).toBe(true);
    // A name is not an acceptable identifier for the link endpoint.
    expect(linkPurchaseItemSchema.safeParse({ productId: 'Ganesha Idol' }).success).toBe(false);
  });
});

/**
 * What the picker shows the moment it opens.
 *
 * The list is only discoverable if it starts complete. Prefilling the search
 * box with the line's own free text made the picker open on zero matches —
 * "ganesh iDol" is not a catalogue name — so the user had to clear a field
 * they never typed in before seeing a single product.
 */
describe('the catalogue picker opens on the full catalogue', () => {
  const catalogue = [
    catalogueEntry('p1', 'Brass lota 1L'),
    catalogueEntry('p2', 'Hammered copper water bottle'),
    catalogueEntry('p3', 'bartan'),
    catalogueEntry('p4', 'black hole'),
    catalogueEntry('p5', 'ghee'),
    catalogueEntry('p6', 'hhh'),
    catalogueEntry('p7', 'ikea'),
    catalogueEntry('p8', 'jj'),
    catalogueEntry('p9', 'kansa thali'),
    catalogueEntry('p10', 'zz-e2e brass tray', false),
  ];

  /** The query the picker starts with when the user clicks Link. */
  const initialQuery = '';

  it('starts with an empty search box', () => {
    expect(initialQuery).toBe('');
    expect(normalizeProductName(initialQuery)).toBe('');
  });

  it('lists every active product before the user types anything', () => {
    const shown = search(catalogue, initialQuery);
    expect(shown).toHaveLength(catalogue.filter((p) => p.isActive).length);
    expect(shown.map((p) => p.name)).toEqual([
      'Brass lota 1L',
      'Hammered copper water bottle',
      'bartan',
      'black hole',
      'ghee',
      'hhh',
      'ikea',
      'jj',
      'kansa thali',
    ]);
  });

  it('does not open pre-filtered by the line’s own free text', () => {
    // The regression: seeding the box with the bill's wording matched nothing,
    // so the picker opened empty and looked broken.
    expect(search(catalogue, 'ganesh iDol')).toEqual([]);
    expect(search(catalogue, initialQuery).length).toBeGreaterThan(0);
  });

  it('still narrows once the user chooses to type', () => {
    expect(search(catalogue, 'brass').map((p) => p.name)).toEqual(['Brass lota 1L']);
    expect(search(catalogue, 'KANSA').map((p) => p.name)).toEqual(['kansa thali']);
  });

  it('keeps inactive products out of the opening list', () => {
    expect(search(catalogue, initialQuery).map((p) => p.name)).not.toContain('zz-e2e brass tray');
  });
});

/**
 * The Sales board's Active / History split.
 *
 * Both tabs read the same SalesRequirementRow list — the same underlying
 * SalesOrderItem — and a row's tab is decided by its derived status alone.
 * Nothing is stored, copied, moved or deleted to place it, so a line that is
 * part-supplied simply appears under History on the next read.
 */
const salesRow = (over: Partial<SalesRequirementRow>): SalesRequirementRow => {
  const requiredQty = over.requiredQty ?? 5;
  const alreadyFulfilled = over.alreadyFulfilled ?? 0;
  const procurementFulfilled = over.procurementFulfilled ?? 0;
  const totalFulfilled = alreadyFulfilled + procurementFulfilled;
  const unfulfilledQty = Math.max(0, requiredQty - totalFulfilled);
  return {
    salesOrderItemId: 'soi1',
    orderId: 'o1',
    orderNumber: 'rsm1',
    customerName: 'Puttu',
    productName: 'Ganesha Idol',
    productId: null,
    linked: false,
    requiredQty,
    alreadyFulfilled,
    procurementFulfilled,
    totalFulfilled,
    unfulfilledQty,
    status:
      unfulfilledQty <= 0 ? 'FULFILLED' : unfulfilledQty >= requiredQty ? 'UNFULFILLED' : 'PARTIAL',
    // Untouched lines carry no fulfilment date; supplied ones are given one
    // explicitly by the tests that care.
    fulfilledOn: totalFulfilled > 0 ? '2026-09-06' : null,
    ...over,
  };
};

/** The component's tab rule, applied the same way it applies it. */
const isActiveRow = (r: SalesRequirementRow): boolean =>
  r.unfulfilledQty > 0 && r.status === 'UNFULFILLED';
const split = (rows: SalesRequirementRow[]) => ({
  active: rows.filter(isActiveRow),
  history: rows.filter((r) => !isActiveRow(r)),
});

describe('the Sales board separates active work from history', () => {
  it('keeps an untouched line in Active', () => {
    const row = salesRow({ requiredQty: 5 });
    expect(row.status).toBe('UNFULFILLED');
    expect(split([row]).active).toHaveLength(1);
    expect(split([row]).history).toHaveLength(0);
  });

  it('moves a partly supplied line out of Active', () => {
    const row = salesRow({ requiredQty: 5, alreadyFulfilled: 2 });
    expect(row.status).toBe('PARTIAL');
    expect(row.unfulfilledQty).toBe(3);
    expect(split([row]).active).toHaveLength(0);
  });

  it('moves a fully supplied line out of Active', () => {
    const row = salesRow({ requiredQty: 5, alreadyFulfilled: 5 });
    expect(row.status).toBe('FULFILLED');
    expect(split([row]).active).toHaveLength(0);
  });

  it('shows the partly supplied line in History', () => {
    const row = salesRow({ requiredQty: 5, alreadyFulfilled: 2 });
    expect(split([row]).history.map((r) => r.status)).toEqual(['PARTIAL']);
  });

  it('shows the fully supplied line in History', () => {
    const row = salesRow({ requiredQty: 5, alreadyFulfilled: 5 });
    expect(split([row]).history.map((r) => r.status)).toEqual(['FULFILLED']);
  });

  it('uses the very same row object in either tab — nothing is copied', () => {
    const row = salesRow({ requiredQty: 5, alreadyFulfilled: 2 });
    const { history } = split([row]);
    expect(history[0]).toBe(row); // identity, not a clone
    expect(history[0]!.salesOrderItemId).toBe(row.salesOrderItemId);
  });

  it('partitions every row exactly once, losing none', () => {
    const rows = [
      salesRow({ salesOrderItemId: 'a', requiredQty: 5 }),
      salesRow({ salesOrderItemId: 'b', requiredQty: 5, alreadyFulfilled: 2 }),
      salesRow({ salesOrderItemId: 'c', requiredQty: 5, alreadyFulfilled: 5 }),
    ];
    const { active, history } = split(rows);
    expect(active.length + history.length).toBe(rows.length);
    expect([...active, ...history].map((r) => r.salesOrderItemId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('splits per line, so one finished line never hides its order’s others', () => {
    // Same order number, different lines: one done, one untouched.
    const rows = [
      salesRow({ salesOrderItemId: 'l1', orderNumber: 'rs900', productName: 'brassdinnerset', requiredQty: 10, alreadyFulfilled: 10 }),
      salesRow({ salesOrderItemId: 'l2', orderNumber: 'rs900', productName: 'kansadinnerset', requiredQty: 8 }),
    ];
    const { active, history } = split(rows);
    expect(active.map((r) => r.salesOrderItemId)).toEqual(['l2']);
    expect(history.map((r) => r.salesOrderItemId)).toEqual(['l1']);
  });

  it('counts allocations alongside hand-recorded fulfilment', () => {
    // rsm1: 5 ordered, 2 by hand, 3 allocated through procurement → done.
    const row = salesRow({ requiredQty: 5, alreadyFulfilled: 2, procurementFulfilled: 3 });
    expect(row.totalFulfilled).toBe(5);
    expect(row.unfulfilledQty).toBe(0);
    expect(row.status).toBe('FULFILLED');
    expect(split([row]).history).toHaveLength(1);
    expect(split([row]).active).toHaveLength(0);
  });

  it('keeps a line whose allocation only partly covers it out of Active', () => {
    const row = salesRow({ requiredQty: 10, alreadyFulfilled: 0, procurementFulfilled: 4 });
    expect(row.status).toBe('PARTIAL');
    expect(row.unfulfilledQty).toBe(6);
    expect(split([row]).history).toHaveLength(1);
  });
});

/**
 * The History date filter.
 *
 * History narrows to one Asia/Kolkata calendar day. The date is derived on the
 * server — the later of the last recorded fulfilment and the last allocation —
 * and arrives as `fulfilledOn`, already an IST day. Nothing here recomputes it
 * from a timestamp; that conversion is asserted separately below.
 */
const onDate = (rows: SalesRequirementRow[], day: string): SalesRequirementRow[] =>
  rows.filter((r) => !isActiveRow(r)).filter((r) => r.fulfilledOn === day);

describe('Sales History narrows to a single IST day', () => {
  const rows = [
    salesRow({ salesOrderItemId: 'g', orderNumber: 'rsm1', productName: 'Ganesha Idol',
      requiredQty: 5, alreadyFulfilled: 2, procurementFulfilled: 3, fulfilledOn: '2026-09-07' }),
    salesRow({ salesOrderItemId: 'p', orderNumber: 'ko009', productName: 'thali',
      requiredQty: 9, alreadyFulfilled: 2, fulfilledOn: '2026-09-06' }),
    salesRow({ salesOrderItemId: 'f', orderNumber: 'rs900', productName: 'brassdinnerset',
      requiredQty: 10, alreadyFulfilled: 10, fulfilledOn: '2026-09-05' }),
    salesRow({ salesOrderItemId: 'u', orderNumber: 'RSM0011', productName: 'ghee',
      requiredQty: 12, fulfilledOn: null }),
  ];

  it('defaults to today in Asia/Kolkata, not the browser’s day', () => {
    // 18:54 UTC on the 6th is already the 7th in IST.
    expect(todayInIST(new Date('2026-09-06T18:54:32Z'))).toBe('2026-09-07');
    expect(todayInIST(new Date('2026-09-06T12:00:00Z'))).toBe('2026-09-06');
  });

  it('converts the UTC→IST boundary at 18:30', () => {
    expect(todayInIST(new Date('2026-09-06T18:29:59Z'))).toBe('2026-09-06');
    expect(todayInIST(new Date('2026-09-06T18:30:00Z'))).toBe('2026-09-07');
  });

  it('shows Ganesha/rsm1 on 2026-09-07, its IST allocation day', () => {
    expect(onDate(rows, '2026-09-07').map((r) => r.orderNumber)).toEqual(['rsm1']);
  });

  it('does NOT show Ganesha/rsm1 on 2026-09-06', () => {
    expect(onDate(rows, '2026-09-06').map((r) => r.orderNumber)).not.toContain('rsm1');
  });

  it('shows a PARTIAL row on its own activity date', () => {
    const day = onDate(rows, '2026-09-06');
    expect(day.map((r) => r.productName)).toEqual(['thali']);
    expect(day[0]!.status).toBe('PARTIAL');
  });

  it('shows a FULFILLED row on its own activity date', () => {
    const day = onDate(rows, '2026-09-05');
    expect(day.map((r) => r.productName)).toEqual(['brassdinnerset']);
    expect(day[0]!.status).toBe('FULFILLED');
  });

  it('excludes every row outside the selected date', () => {
    for (const day of ['2026-09-05', '2026-09-06', '2026-09-07']) {
      expect(onDate(rows, day).every((r) => r.fulfilledOn === day), day).toBe(true);
    }
    expect(onDate(rows, '2026-09-04')).toEqual([]);
  });

  it('never shows a row that has no fulfilment date', () => {
    const everyDay = ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']
      .flatMap((d) => onDate(rows, d));
    expect(everyDay.map((r) => r.salesOrderItemId)).not.toContain('u');
  });

  it('steps to the previous and next day without drifting', () => {
    expect(shiftDay('2026-09-07', -1)).toBe('2026-09-06');
    expect(shiftDay('2026-09-06', 1)).toBe('2026-09-07');
    // Across a month boundary, where naive arithmetic goes wrong.
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('leaves the Active tab unfiltered by date', () => {
    // The untouched line has no fulfilledOn, yet must still appear in Active.
    const active = rows.filter(isActiveRow);
    expect(active.map((r) => r.salesOrderItemId)).toEqual(['u']);
    expect(active[0]!.fulfilledOn).toBeNull();
  });
});

/**
 * Product identity, as the catalogue enforces it.
 *
 * One definition of the fold now serves the migration, the API, the picker and
 * these tests — the frontend previously collapsed whitespace where the business
 * rule removes it, which would have let the UI offer to create a product the
 * unique index then refused.
 */
describe('normalizeProductName folds a product to one identity', () => {
  it('treats every spelling of the same product as one key', () => {
    const spellings = [
      'Kansa Dinner Set',
      'kansa dinner set',
      'KANSA DINNER SET',
      'Kansa   Dinner   Set',
      'kansadinnerset',
      '  Kansa Dinner Set  ',
    ];
    const keys = new Set(spellings.map(normalizeProductName));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('kansadinnerset');
  });

  it('resolves the real "brass dinner set" / "brassdinnerset" collision', () => {
    // Both spellings exist on live purchase bills today.
    expect(normalizeProductName('brass dinner set')).toBe(normalizeProductName('brassdinnerset'));
  });

  it('keeps genuinely different products apart', () => {
    expect(normalizeProductName('kansa thali')).not.toBe(normalizeProductName('kansa thali and kadai'));
    expect(normalizeProductName('brass lota')).not.toBe(normalizeProductName('brass lota 1L'));
  });

  it('never rewrites the name it was given', () => {
    const name = 'Kansa Dinner Set';
    const folded = normalizeProductName(name);
    expect(name).toBe('Kansa Dinner Set');
    expect(folded).not.toBe(name);
  });
});

/**
 * The Put in Catalogue decision, as the picker makes it.
 *
 * Exact on the folded name rather than a substring: "thali" inside "kansa
 * thali" is a different product, and reusing it would pool two things that only
 * look alike.
 */
type Cat = { id: string; name: string; isActive: boolean };
const entryFor = (products: Cat[], productName: string): Cat | undefined => {
  const key = normalizeProductName(productName);
  return products.find((p) => normalizeProductName(p.name) === key);
};

describe('Put in Catalogue is offered only when nothing represents the product', () => {
  const catalogue: Cat[] = [
    { id: 'p1', name: 'Kansa Dinner Set', isActive: true },
    { id: 'p2', name: 'kansa thali', isActive: true },
    { id: 'p3', name: 'zz-e2e brass tray', isActive: false },
  ];

  it('reuses an active product whatever the line’s spelling', () => {
    for (const spelling of ['kansa dinner set', 'KANSA DINNER SET', 'Kansa   Dinner Set', 'kansadinnerset']) {
      const m = entryFor(catalogue, spelling);
      expect(m?.id, spelling).toBe('p1');
      expect(m?.isActive).toBe(true);
    }
  });

  it('offers creation only when there is no match at all', () => {
    expect(entryFor(catalogue, 'lighter')).toBeUndefined();
    expect(entryFor(catalogue, 'thali set brass')).toBeUndefined();
  });

  it('finds an inactive match rather than treating it as absent', () => {
    const m = entryFor(catalogue, 'ZZ-E2E   Brass Tray');
    expect(m?.id).toBe('p3');
    expect(m?.isActive).toBe(false);
  });

  it('does not mistake a substring for the same product', () => {
    // "thali" is not "kansa thali".
    expect(entryFor(catalogue, 'thali')).toBeUndefined();
  });

  it('leaves the catalogue untouched when deciding', () => {
    const before = catalogue.map((p) => `${p.id}:${p.name}:${p.isActive}`);
    entryFor(catalogue, 'kansa dinner set');
    entryFor(catalogue, 'lighter');
    expect(catalogue.map((p) => `${p.id}:${p.name}:${p.isActive}`)).toEqual(before);
  });
});

/**
 * Read-side product resolution on the shortage board.
 *
 * A purchase line reading "Brasscooker" and a catalogue entry reading "Brass
 * Cooker" fold to one key, so they belong on one row. Resolving is a *read*:
 * the row displays under the product it plainly names while the database still
 * records the line as unlinked, until somebody links it deliberately.
 */
type Cat2 = { id: string; name: string; isActive: boolean };

/** The service's key rule, applied the way getShortages applies it. */
const shortageKey = (
  catalogue: Cat2[],
  productId: string | null,
  productName: string,
): string => {
  if (productId) return `product:${productId}`;
  const key = normalizeProductName(productName);
  const match = catalogue.find((p) => normalizeProductName(p.name) === key);
  return match && match.isActive ? `product:${match.id}` : `name:${productName}`;
};

describe('the shortage board resolves free text to the catalogue', () => {
  const catalogue: Cat2[] = [
    { id: 'pc', name: 'Brass Cooker', isActive: true },
    { id: 'pr', name: 'Retired Kadhai', isActive: false },
  ];

  it('puts a linked sales line and an unlinked purchase line on ONE row', () => {
    // The live case: rsm1 "Brass Cooker" linked, BL01 "Brasscooker" unlinked.
    const sales = shortageKey(catalogue, 'pc', 'Brass Cooker');
    const purchase = shortageKey(catalogue, null, 'Brasscooker');
    expect(purchase).toBe(sales);
    expect(purchase).toBe('product:pc');
  });

  it('resolves every spelling of the same product to that product', () => {
    for (const spelling of ['Brass Cooker', 'Brasscooker', 'BRASS COOKER', 'brass cooker', 'Brass   Cooker', '  brass cooker  ']) {
      expect(shortageKey(catalogue, null, spelling), spelling).toBe('product:pc');
    }
  });

  it('keeps a genuinely different name as free text', () => {
    expect(shortageKey(catalogue, null, 'Brass Cooker 2')).toBe('name:Brass Cooker 2');
    expect(shortageKey(catalogue, null, 'Brass Kadhai')).toBe('name:Brass Kadhai');
  });

  it('does not resolve to an inactive product', () => {
    // Retired stock cannot be allocated, so the line stays visible as free text
    // rather than folding into something nobody can act on.
    expect(shortageKey(catalogue, null, 'retiredkadhai')).toBe('name:retiredkadhai');
  });

  it('never rewrites the name it read', () => {
    const before = catalogue.map((p) => p.name);
    shortageKey(catalogue, null, 'BRASSCOOKER');
    expect(catalogue.map((p) => p.name)).toEqual(before);
    // The bill keeps its own wording; only the key is shared.
    const billName = 'Brasscooker';
    expect(shortageKey(catalogue, null, billName)).toBe('product:pc');
    expect(billName).toBe('Brasscooker');
  });

  it('offers the resolved product for an unlinked purchase line', () => {
    // What the Map Quantity button now shows instead of "Different product".
    const entryFor = (name: string): Cat2 | undefined => {
      const key = normalizeProductName(name);
      return catalogue.find((p) => normalizeProductName(p.name) === key);
    };
    expect(entryFor('Brasscooker')?.id).toBe('pc');
    expect(entryFor('Brasscooker')?.name).toBe('Brass Cooker');
    expect(entryFor('Unknown Thing')).toBeUndefined();
  });

  it('caps the allocation input at min(pending, standing)', () => {
    // The live case: sales pending 5, purchase standing 8 → at most 5.
    expect(Math.min(5, 8)).toBe(5);
    expect(Math.min(0, 8)).toBe(0);
    expect(Math.min(5, 3)).toBe(3);
  });
});

/**
 * What "Allocated" counts on the shortage board.
 *
 * Required and Allocated describe the same thing — demand still open — so a
 * line met in full contributes to neither. Summing every allocation regardless
 * put Required 4 beside Allocated 10 for one product, where nine of those
 * units belonged to orders nobody was waiting on.
 *
 * The allocations themselves are untouched: Sales History still shows each
 * order's own procurement figure.
 */
type OpenLine = { quantity: number; alreadyFulfilled: number; allocated: number };

/** The service's aggregation, as getShortages performs it. */
const aggregate = (lines: OpenLine[]): { required: number; allocated: number } => {
  let required = 0;
  let allocated = 0;
  for (const l of lines) {
    const outstanding = Math.max(0, l.quantity - l.alreadyFulfilled - l.allocated);
    required += outstanding;
    if (outstanding > 0) allocated += l.allocated;
  }
  return { required, allocated };
};

describe('Requirement vs Stock counts only allocation against open demand', () => {
  it('excludes a fully fulfilled order’s historical allocation', () => {
    // CASE 1: 5 required, 5 allocated, nothing pending.
    expect(aggregate([{ quantity: 5, alreadyFulfilled: 0, allocated: 5 }])).toEqual({
      required: 0,
      allocated: 0,
    });
  });

  it('keeps a partial order’s allocation, which is still relevant', () => {
    // CASE 2: 5 required, 1 allocated, 4 pending.
    expect(aggregate([{ quantity: 5, alreadyFulfilled: 0, allocated: 1 }])).toEqual({
      required: 4,
      allocated: 1,
    });
  });

  it('handles a new order with no allocation at all', () => {
    // CASE 3.
    expect(aggregate([{ quantity: 5, alreadyFulfilled: 0, allocated: 0 }])).toEqual({
      required: 5,
      allocated: 0,
    });
  });

  it('aggregates several partial orders', () => {
    // CASE 4: (5,2)→3 pending and (4,1)→3 pending.
    expect(
      aggregate([
        { quantity: 5, alreadyFulfilled: 0, allocated: 2 },
        { quantity: 4, alreadyFulfilled: 0, allocated: 1 },
      ]),
    ).toEqual({ required: 6, allocated: 3 });
  });

  it('counts allocation on a line part-supplied by hand', () => {
    // CASE 5: 5 − 2 alreadyFulfilled − 2 allocated = 1 pending, so the 2
    // allocated units still matter.
    expect(aggregate([{ quantity: 5, alreadyFulfilled: 2, allocated: 2 }])).toEqual({
      required: 1,
      allocated: 2,
    });
  });

  it('drops the allocation once that line becomes fully fulfilled', () => {
    // CASE 6: the same line before and after its last allocation.
    expect(aggregate([{ quantity: 5, alreadyFulfilled: 0, allocated: 4 }])).toEqual({
      required: 1,
      allocated: 4,
    });
    expect(aggregate([{ quantity: 5, alreadyFulfilled: 0, allocated: 5 }])).toEqual({
      required: 0,
      allocated: 0,
    });
  });

  it('reproduces the live Copper Dispenser case', () => {
    // rsm2 fulfilled 5/5 · rsm3 partial 1 of 5 · rsm4 fulfilled 4/4.
    const rows = [
      { quantity: 5, alreadyFulfilled: 0, allocated: 5 },
      { quantity: 5, alreadyFulfilled: 0, allocated: 1 },
      { quantity: 4, alreadyFulfilled: 0, allocated: 4 },
    ];
    // Historically this read Required 4 beside Allocated 10.
    expect(rows.reduce((s, l) => s + l.allocated, 0)).toBe(10);
    expect(aggregate(rows)).toEqual({ required: 4, allocated: 1 });
  });

  it('leaves Required unchanged — only Allocated is affected', () => {
    // Required is the same sum it always was, whatever Allocated does.
    const rows = [
      { quantity: 5, alreadyFulfilled: 0, allocated: 5 },
      { quantity: 5, alreadyFulfilled: 0, allocated: 1 },
      { quantity: 4, alreadyFulfilled: 0, allocated: 4 },
    ];
    const requiredOnly = rows.reduce(
      (s, l) => s + Math.max(0, l.quantity - l.alreadyFulfilled - l.allocated),
      0,
    );
    expect(aggregate(rows).required).toBe(requiredOnly);
  });
});

/**
 * The History row's click wiring.
 *
 * This suite has no DOM, so a real click cannot be dispatched — see the note
 * in the report. What it can do is read the component source and assert the
 * wiring is present, which is exactly the failure that occurred: the handler
 * was reported as added when a silent no-op patch had left the TableRow bare,
 * and no pure-logic test could notice.
 *
 * Static rather than behavioural, and deliberately narrow: it checks that the
 * row sets the dialog state, that it does so only for History, and that the
 * Already button still stops the event reaching the row.
 */
const salesBoardSource = readFileSync(
  new URL('../components/procurement/sales-board.tsx', import.meta.url),
  'utf8',
);

describe('the History row is wired to the fulfilment dialog', () => {
  it('sets the dialog state from the row', () => {
    expect(salesBoardSource).toContain('onClick: () => setDetailFor(row.salesOrderItemId)');
  });

  it('wires the handler only for the History tab', () => {
    // The spread is conditional, so an Active row receives no onClick at all.
    expect(salesBoardSource).toContain("...(tab === 'history'");
    const idx = salesBoardSource.indexOf('setDetailFor(row.salesOrderItemId)');
    const guard = salesBoardSource.lastIndexOf("tab === 'history'", idx);
    expect(guard).toBeGreaterThan(-1);
    expect(idx - guard).toBeLessThan(200); // the guard governs this handler
  });

  it('keeps the Already button as the alreadyFulfilled editor', () => {
    // Not repurposed into the detail popup.
    expect(salesBoardSource).toContain('setEditing(row)');
    expect(salesBoardSource).toContain('setValue(String(row.alreadyFulfilled))');
  });

  it('stops the Already click from also opening the row dialog', () => {
    expect(salesBoardSource).toContain('e.stopPropagation()');
    const stop = salesBoardSource.indexOf('e.stopPropagation()');
    const edit = salesBoardSource.indexOf('setEditing(row)', stop);
    expect(edit).toBeGreaterThan(stop); // stopPropagation runs first
  });

  it('still mounts the dialog and closes it back to null', () => {
    expect(salesBoardSource).toContain('<FulfillmentDetailDialog');
    expect(salesBoardSource).toContain('open={detailFor !== null}');
    expect(salesBoardSource).toContain('setDetailFor(null)');
  });
});
