/**
 * RS Products as the CRM's only product identity — the UI's half of the rules.
 *
 * Separate from procurement.test.ts because these assert a different kind of
 * thing: not the arithmetic the module renders, but that certain UI affordances
 * exist and certain others are gone. Several are static reads of component
 * source, in the same style as the History-row wiring suite next door, and for
 * the same reason — the failures being guarded against are a removed input
 * quietly returning and a button routing to the wrong endpoint, neither of
 * which any pure-logic test over schemas could notice.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPurchaseBillSchema, requestProductChangeSchema } from '@rs/shared';
import type { ShortageRow } from '@rs/shared';
import { NAV_ITEMS } from '@/components/layout/nav-items';

const source = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const createBillSource = source('../components/procurement/create-bill-form.tsx');
const procurementPageSource = source('../app/(app)/procurement/page.tsx');
const billItemSource = source('../components/procurement/bill-item-list.tsx');
const shortageBoardSource = source('../components/procurement/shortage-board.tsx');
const changeDialogSource = source('../components/procurement/change-rs-product-dialog.tsx');
const queueSource = source('../components/procurement/product-change-queue.tsx');

const rsProduct = (id: string, title: string): NonNullable<ShortageRow['rsProduct']> => ({
  id,
  title,
  sku: null,
  imageUrl: null,
  crmStockQty: 0,
  rsStockQty: 0,
});

const shortage = (over: Partial<ShortageRow>): ShortageRow => ({
  productName: 'Kansa Thali Set',
  rsProduct: null,
  linked: false,
  sku: null,
  totalRequired: 5,
  totalAllocated: 0,
  crmStockQty: null,
  rsStockQty: null,
  shortageQty: 5,
  standingQty: 0,
  ...over,
});

/**
 * The new-bill form has no free-text product-name input.
 *
 * The schema still accepts `productName` — a historical import sends one — so
 * only the component source can say that the UI stopped asking for it.
 */
describe('a new purchase bill names its products from the RS catalogue', () => {
  it('has no free-text product-name input', () => {
    expect(createBillSource).not.toContain('As written on the bill');
    expect(createBillSource).not.toContain('patch(item.key, { productName:');
  });

  it('does not keep a productName on the line draft at all', () => {
    // A retained field would be sent, and would become the identity again the
    // moment somebody re-added an input bound to it.
    expect(createBillSource).not.toMatch(/productName:\s*i\.productName/);
    expect(createBillSource).not.toMatch(/productName:\s*''/);
  });

  it('offers the shared RS Product picker as the product selection', () => {
    expect(createBillSource).toContain('<RsProductPicker');
    expect(createBillSource).toContain('placeholder="Select RS Product"');
  });

  it('sends only the picked id for the product', () => {
    expect(createBillSource).toContain('...(i.rsProduct ? { rsProductId: i.rsProduct.id } : {})');
  });

  it('requires a product on every line before it will submit', () => {
    expect(createBillSource).toContain('Choose the RS Product this line is for');
  });

  it('still captures quantity, rate and the derived totals', () => {
    // Removing the name field must not have disturbed the numbers beside it.
    expect(createBillSource).toContain('orderedQty: e.target.value');
    expect(createBillSource).toContain('rate: e.target.value');
    expect(createBillSource).toContain('lineTotal(item.rate, qty)');
  });
});

/**
 * Choosing a product says what the goods are, not what they cost.
 *
 * RS Products carries a selling price; a purchase bill records what this vendor
 * actually charged, which is negotiated as often as not. So picking a product
 * must never write the rate field. The picker makes that structural — its
 * `PickedProduct` carries no price to copy — and these assert both halves, so
 * neither adding a price to the picker nor wiring one into `onChange` can
 * reintroduce an auto-filled rate unnoticed.
 */
describe('rate is entered by hand and never taken from the catalogue', () => {
  const pickerSource = source('../components/products/rs-product-picker.tsx');

  it('exposes no price on the picked product', () => {
    const shape = pickerSource.slice(
      pickerSource.indexOf('export type PickedProduct'),
      pickerSource.indexOf('}', pickerSource.indexOf('export type PickedProduct')),
    );
    expect(shape).toContain('id');
    expect(shape).toContain('title');
    expect(shape).toContain('sku');
    expect(shape).not.toContain('price');
    expect(shape).not.toContain('cost');
  });

  it('writes only the product when a selection is made', () => {
    // The whole onChange payload. A rate written here is the one way a
    // selection could silently overwrite a typed figure.
    expect(createBillSource).toContain(
      'onChange={(product) => patch(item.key, { rsProduct: product })}',
    );
  });

  it('never patches rate from anywhere but the rate input', () => {
    const rateWrites = createBillSource.match(/patch\(item\.key, \{ rate:/g) ?? [];
    expect(rateWrites).toHaveLength(1);
    expect(createBillSource).toContain('patch(item.key, { rate: e.target.value })');
  });

  it('starts a new line with an empty rate rather than a default figure', () => {
    expect(createBillSource).toMatch(/rate:\s*''/);
  });

  it('keeps the rate field editable and the total read-only', () => {
    // The total is an <output>, which cannot be typed into at all — a stronger
    // guarantee than a disabled input, and it submits nothing.
    expect(createBillSource).toContain('value={item.rate}');
    expect(createBillSource).toContain('<output');
    expect(createBillSource).not.toContain('value={total}');
  });
});

/**
 * The product row cannot push the page sideways.
 *
 * The bug this guards: grid items default to `min-width: auto`, so an `fr`
 * track refuses to shrink below its content — and a formatted total such as
 * ₹1,50,006.00, or a long catalogue title, was wider than its share and forced
 * the whole row past the card. Fixed tracks for the figures and `min-w-0` on
 * the cells are what fix it, so both are asserted.
 */
describe('the product row stays inside the card at every width', () => {
  it('sizes the figure columns in fixed units, not fr', () => {
    expect(createBillSource).toContain(
      'lg:grid-cols-[minmax(240px,1fr)_96px_120px_150px_120px_auto]',
    );
    // The old all-fr template is what overflowed.
    expect(createBillSource).not.toContain('[2fr_0.7fr_0.9fr_1fr_0.8fr_auto]');
  });

  it('lets every cell shrink below its content', () => {
    // One per field cell plus the product cell; without these the fixed tracks
    // would still be widened from the inside.
    expect((createBillSource.match(/min-w-0/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('gives the product selector the widest track', () => {
    expect(createBillSource).toContain('minmax(240px,1fr)');
  });

  it('wraps the figures instead of stacking or overflowing when narrow', () => {
    expect(createBillSource).toContain('grid grid-cols-2 gap-3 sm:grid-cols-4 lg:contents');
  });

  it('keeps the SKU with the product it belongs to, and breakable', () => {
    const cell = createBillSource.slice(
      createBillSource.indexOf('<RsProductPicker'),
      createBillSource.indexOf('grid grid-cols-2'),
    );
    expect(cell).toContain('item.rsProduct.sku');
    // A SKU has no space to wrap at, so it needs an explicit break rule.
    expect(cell).toContain('break-all');
  });

  it('keeps the remove action reachable once the row stacks', () => {
    expect(createBillSource).toContain('aria-label="Remove line"');
    expect(createBillSource).toContain('flex items-start justify-end lg:justify-start');
  });
});

/** The schema's half of the same rule. */
describe('a bill line must carry a product identity', () => {
  const id = 'c'.repeat(25);
  const line = { orderedQty: 2, receivedQty: 2, rate: '100.00' };
  const bill = (items: unknown[]) => ({
    billNumber: 'INV-1',
    vendorId: id,
    billType: 'CREDIT' as const,
    billDate: '2026-09-19',
    items,
  });

  it('accepts a line carrying only an RS Product', () => {
    expect(createPurchaseBillSchema.safeParse(bill([{ ...line, rsProductId: id }])).success)
      .toBe(true);
  });

  it('still accepts a line carrying only a name, for historical imports', () => {
    expect(createPurchaseBillSchema.safeParse(bill([{ ...line, productName: 'PAN' }])).success)
      .toBe(true);
  });

  it('refuses a line carrying neither', () => {
    expect(createPurchaseBillSchema.safeParse(bill([line])).success).toBe(false);
  });

  it('never carries a variant id through to the server', () => {
    const parsed = createPurchaseBillSchema.safeParse(
      bill([{ ...line, rsProductId: id, variantId: id, shopifyVariantId: id }]),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items[0]).not.toHaveProperty('variantId');
      expect(parsed.data.items[0]).not.toHaveProperty('shopifyVariantId');
    }
  });

  it('never carries a SKU through as an identity', () => {
    const parsed = createPurchaseBillSchema.safeParse(
      bill([{ ...line, productName: 'PAN', sku: 'KAN-10' }]),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.items[0]).not.toHaveProperty('sku');
  });
});

/** The Procurement page shows procurement; the Sales module is untouched. */
describe('the Procurement page no longer carries a Sales section', () => {
  it('does not render the sales board', () => {
    expect(procurementPageSource).not.toContain('<SalesBoard');
    expect(procurementPageSource).not.toContain("components/procurement/sales-board");
  });

  it('does not fetch sales requirements for this page', () => {
    expect(procurementPageSource).not.toContain('fetchSalesRequirements');
  });

  it('keeps the things procurement is for', () => {
    expect(procurementPageSource).toContain('<ShortageBoard');
    expect(procurementPageSource).toContain('<PurchaseBillTable');
  });

  it('leaves the Sales module itself live in the navigation', () => {
    // Removing a section from one page is not removing a module.
    const sales = NAV_ITEMS.find((i) => i.href === '/sales');
    expect(sales).toBeDefined();
    expect(sales?.available).toBe(true);
  });
});

/**
 * CRM Stock and RS Product Stock are two numbers, and stay two numbers.
 *
 * The specific regression guarded against: the board used to read the CRM
 * figure and render it under a heading that said "RS stock", stating a fact
 * about the storefront that nothing had checked.
 */
describe('CRM stock and RS product stock are never conflated', () => {
  it('carries both figures on an RS Product reference', () => {
    const ref = rsProduct('ckp1', 'Kansa Thali Set');
    expect(ref).toHaveProperty('crmStockQty');
    expect(ref).toHaveProperty('rsStockQty');
  });

  it('carries both, separately nullable, on a shortage row', () => {
    const row = shortage({ crmStockQty: 3, rsStockQty: 11 });
    expect(row.crmStockQty).toBe(3);
    expect(row.rsStockQty).toBe(11);
    // Different values survive as different values: neither is overwritten by
    // the other on the way through.
    expect(row.crmStockQty).not.toBe(row.rsStockQty);
  });

  it('gives each its own column and its own label on the board', () => {
    expect(shortageBoardSource).toContain('>CRM stock<');
    expect(shortageBoardSource).toContain('>RS stock<');
    expect(shortageBoardSource).toContain('row.crmStockQty');
    expect(shortageBoardSource).toContain('row.rsStockQty');
  });

  it('gives each its own label on a purchase bill line', () => {
    expect(billItemSource).toContain('CRM stock');
    expect(billItemSource).toContain('item.rsProduct.crmStockQty');
    expect(billItemSource).toContain('item.rsProduct.rsStockQty');
  });

  it('shows a dash rather than a zero when nothing is mapped', () => {
    expect(shortageBoardSource).toContain('row.crmStockQty === null');
    expect(shortageBoardSource).toContain('row.rsStockQty === null');
  });

  it('shows the product SKU as its own column', () => {
    expect(shortageBoardSource).toContain('row.sku');
    expect(shortage({ sku: 'KAN-DIN-10' }).sku).toBe('KAN-DIN-10');
  });
});

/**
 * Changing an existing mapping is a request; making a first one is not.
 *
 * The UI half only. The server refuses a change through the mapping endpoint
 * whatever the UI does — the backend suite covers that — so these assert that a
 * person is offered the right one of the two and told which it is.
 */
describe('changing a mapped line goes through approval', () => {
  it('opens the request dialog for a mapped line and the map dialog otherwise', () => {
    expect(billItemSource).toContain('{canEdit && !item.rsProduct && (');
    expect(billItemSource).toContain('{canEdit && item.rsProduct && (');
    expect(billItemSource).toContain('<ChangeRsProductDialog');
    expect(billItemSource).toContain('<MapRsProductDialog');
  });

  it('labels the two acts differently', () => {
    expect(billItemSource).toContain("{item.rsProduct ? 'Change product' : 'Map product'}");
  });

  it('says plainly that nothing changes until an administrator approves', () => {
    expect(changeDialogSource).toContain('Request a product change');
    expect(changeDialogSource).toContain('requestProductChangeAction');
    expect(changeDialogSource).toMatch(/administrator/i);
  });

  it('requires a reason before it will submit', () => {
    expect(changeDialogSource).toContain('reason.trim().length < 10');
    expect(requestProductChangeSchema.safeParse({ rsProductId: 'c'.repeat(25), reason: 'no' }).success)
      .toBe(false);
  });

  it('refuses a request that proposes the product already mapped', () => {
    expect(changeDialogSource).toContain('product.id === current?.id');
  });

  it('offers no button while a request is already pending', () => {
    expect(billItemSource).toContain('{canEdit && !item.pendingProductChange && (');
    expect(billItemSource).toContain('Change pending approval');
  });

  it('never routes a change through the direct mapping action', () => {
    // The one client-side mistake that would look like it bypassed approval.
    expect(changeDialogSource).not.toContain('mapPurchaseItemAction');
  });

  it('shows the approver both products with both stock figures', () => {
    expect(queueSource).toContain('change.fromRsProduct');
    expect(queueSource).toContain('change.toRsProduct');
    expect(queueSource).toContain('product.crmStockQty');
    expect(queueSource).toContain('product.rsStockQty');
    expect(queueSource).toContain('change.reason');
  });

  it('blocks approval while the line has allocated stock, but still allows rejection', () => {
    expect(queueSource).toContain('change.allocatedQty > 0');
    expect(queueSource).toContain('disabled={pending || blocked}');
  });

  it('renders the queue only where the review capability is held', () => {
    expect(procurementPageSource).toContain("can(access.user, 'PROCUREMENT', 'ASSIGN')");
    expect(procurementPageSource).toContain('{canReview && <ProductChangeQueue');
    /*
      Never a role comparison in the gate itself. Matched against a `.role ===`
      expression rather than the bare string "role === 'ADMIN'", which also
      appears in the prose above the gate explaining why it is not used — an
      assertion that cannot tell code from the comment warning against it would
      fail on a correct file.
    */
    expect(procurementPageSource).not.toMatch(/user\.role\s*===/);
  });
});
