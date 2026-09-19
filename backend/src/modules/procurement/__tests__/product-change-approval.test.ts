/**
 * Changing an already-mapped purchase line needs an administrator's approval.
 *
 * The asymmetry under test:
 *
 *   unmapped line  →  pick a product      →  applies immediately
 *   mapped line    →  request a change    →  applies only when approved
 *
 * The claim worth proving rather than asserting from the UI is that the second
 * path cannot be skipped. Anyone who can edit procurement data may file a
 * request; only PROCUREMENT ASSIGN decides one; and calling the direct mapping
 * endpoint with a different product on a mapped line is refused — which is
 * exactly the request a hand-crafted client would send to bypass the workflow.
 *
 * Also covered: that a rejection leaves the original mapping exactly as it was,
 * that the audit records who asked and who decided, and that the two stock
 * figures travel to the API as two different numbers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  approvePurchaseBill,
  cleanup,
  makeRsProduct,
  makeUser,
  makeVendor,
  purchaseBillPayload,
  residualTestRows,
  trackPurchaseBill,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let staff: TestUser;
let adminToken: string;
let staffToken: string;
let vendor: { id: string; name: string };

/** A product to map to, and a different one to try to move to. */
let productA: { id: string; title: string };
let productB: { id: string; title: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  staff = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  staffToken = await mintToken(staff.id, { role: 'USER' });
  vendor = await makeVendor();
  // Deliberately different CRM and RS quantities: equal ones would let a bug
  // that reports one figure under the other's name pass unnoticed.
  productA = await makeRsProduct({ crmStockQty: 4, inventoryQty: 9 });
  productB = await makeRsProduct({ crmStockQty: 1, inventoryQty: 2 });

  /*
    A staff user who can do ordinary procurement work but cannot approve.

    USER holds nothing on PROCUREMENT by default, so VIEW/CREATE/EDIT are
    granted explicitly and ASSIGN is left denied. That is precisely the person
    the workflow exists to constrain: able to record bills and map lines, not
    able to move a mapping that already exists.
  */
  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
      userId: staff.id,
      module: 'PROCUREMENT' as const,
      action,
      allowed: true,
    })),
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

type Item = {
  id: string;
  rsProduct: { id: string; title: string; crmStockQty: number; rsStockQty: number } | null;
  pendingProductChange: { id: string; toRsProduct: { id: string } } | null;
};

type BillBody = { data: { bill: { id: string; items: Item[] } } };
type ErrorBody = { code: string };

/** A bill with one line, mapped to `rsProductId` unless it is empty. */
async function billWithLine(
  rsProductId: string,
  token = staffToken,
): Promise<Item & { billId: string }> {
  const res = await api<BillBody>('POST', '/api/procurement/bills', {
    token,
    body: purchaseBillPayload(vendor.id, rsProductId),
  });
  expect(res.status).toBe(201);
  const bill = (res.body as unknown as BillBody).data.bill;
  trackPurchaseBill(bill.id);
  return { ...bill.items[0]!, billId: bill.id };
}

const mapTo = (line: { billId: string; id: string }, rsProductId: string, token: string) =>
  api('POST', `/api/procurement/bills/${line.billId}/items/${line.id}/rs-product`, {
    token,
    body: { rsProductId },
  });

const requestChange = (
  line: { billId: string; id: string },
  rsProductId: string,
  reason: string,
  token = staffToken,
) =>
  api('POST', `/api/procurement/bills/${line.billId}/items/${line.id}/product-change`, {
    token,
    body: { rsProductId, reason },
  });

const decide = (changeId: string, decision: 'approve' | 'reject', token: string, note?: string) =>
  api('POST', `/api/procurement/product-changes/${changeId}/${decision}`, {
    token,
    body: note ? { note } : {},
  });

const mappingOf = async (itemId: string): Promise<string | null> => {
  const row = await prisma.purchaseBillItem.findUnique({
    where: { id: itemId },
    select: { rsProductId: true },
  });
  return row?.rsProductId ?? null;
};

describe('a first mapping needs no approval', () => {
  it('maps an unmapped line directly', async () => {
    const line = await billWithLine('');
    expect(line.rsProduct).toBeNull();

    const res = await mapTo(line, productA.id, staffToken);
    expect(res.status).toBe(200);

    const item = (res.body as unknown as BillBody).data.bill.items[0]!;
    expect(item.rsProduct?.id).toBe(productA.id);
    // Applied at once: no request was created for it.
    expect(item.pendingProductChange).toBeNull();
  });

  it('creates no approval record for a first mapping', async () => {
    const line = await billWithLine('');
    await mapTo(line, productA.id, staffToken);
    expect(await prisma.purchaseItemProductChange.count({ where: { itemId: line.id } })).toBe(0);
  });
});

describe('changing an existing mapping cannot be done directly', () => {
  it('refuses a different product through the mapping endpoint', async () => {
    const line = await billWithLine(productA.id);
    const res = await mapTo(line, productB.id, staffToken);

    expect(res.status).toBe(409);
    expect((res.body as unknown as ErrorBody).code).toBe('PRODUCT_CHANGE_REQUIRES_APPROVAL');
  });

  it('leaves the mapping untouched when it refuses', async () => {
    const line = await billWithLine(productA.id);
    await mapTo(line, productB.id, staffToken);
    expect(await mappingOf(line.id)).toBe(productA.id);
  });

  it('refuses an administrator too — the workflow is the gate, not the route', async () => {
    // ADMIN holds every capability and still cannot skip the request: the rule
    // is about *how* a mapping moves, not about who may move it.
    const line = await billWithLine(productA.id, adminToken);
    const res = await mapTo(line, productB.id, adminToken);

    expect(res.status).toBe(409);
    expect((res.body as unknown as ErrorBody).code).toBe('PRODUCT_CHANGE_REQUIRES_APPROVAL');
    expect(await mappingOf(line.id)).toBe(productA.id);
  });

  it('accepts re-sending the product already mapped, as the no-op it is', async () => {
    const line = await billWithLine(productA.id);
    const res = await mapTo(line, productA.id, staffToken);

    // A double-submitted form must not report a conflict where nothing differs.
    expect(res.status).toBe(200);
    expect(await mappingOf(line.id)).toBe(productA.id);
  });
});

describe('a change request records the ask and changes nothing', () => {
  it('is filed by someone with edit rights, and leaves the mapping alone', async () => {
    const line = await billWithLine(productA.id);
    const res = await requestChange(
      line,
      productB.id,
      'The bill lists the 12 inch set, not the 10 inch.',
    );

    expect(res.status).toBe(200);
    const item = (res.body as unknown as BillBody).data.bill.items[0]!;
    // The live mapping is still A; only the pending request mentions B.
    expect(item.rsProduct?.id).toBe(productA.id);
    expect(item.pendingProductChange?.toRsProduct.id).toBe(productB.id);
    expect(await mappingOf(line.id)).toBe(productA.id);
  });

  it('refuses a second open request on the same line', async () => {
    const line = await billWithLine(productA.id);
    const reason = 'Mis-identified on the vendor document.';

    expect((await requestChange(line, productB.id, reason)).status).toBe(200);

    const second = await requestChange(line, productB.id, reason);
    expect(second.status).toBe(409);
    expect((second.body as unknown as ErrorBody).code).toBe('PRODUCT_CHANGE_ALREADY_PENDING');
  });

  it('refuses a request on an unmapped line — that is a first mapping', async () => {
    const line = await billWithLine('');
    const res = await requestChange(
      line,
      productB.id,
      'This line has never been mapped to anything.',
    );

    expect(res.status).toBe(400);
    expect((res.body as unknown as ErrorBody).code).toBe('PURCHASE_LINE_NOT_LINKED');
  });

  it('refuses a request proposing the product already mapped', async () => {
    const line = await billWithLine(productA.id);
    const res = await requestChange(
      line,
      productA.id,
      'No actual change is being proposed here at all.',
    );

    expect(res.status).toBe(400);
    expect((res.body as unknown as ErrorBody).code).toBe('PRODUCT_CHANGE_NO_OP');
  });

  it('requires a reason', async () => {
    const line = await billWithLine(productA.id);
    expect((await requestChange(line, productB.id, 'no')).status).toBe(422);
  });
});

describe('only approval rights can decide a request', () => {
  async function pendingRequest(): Promise<{ id: string; itemId: string }> {
    const line = await billWithLine(productA.id);
    const res = await requestChange(
      line,
      productB.id,
      'The goods delivered were the larger set.',
    );
    const item = (res.body as unknown as BillBody).data.bill.items[0]!;
    return { id: item.pendingProductChange!.id, itemId: line.id };
  }

  it('refuses a non-admin calling approve directly', async () => {
    const request = await pendingRequest();

    // The bypass a hand-crafted client would attempt: skip the UI, call the
    // endpoint. PROCUREMENT ASSIGN is denied to this person by role default.
    const res = await decide(request.id, 'approve', staffToken);

    expect(res.status).toBe(403);
    expect(await mappingOf(request.itemId)).toBe(productA.id);
  });

  it('refuses a non-admin calling reject directly', async () => {
    const request = await pendingRequest();
    expect((await decide(request.id, 'reject', staffToken)).status).toBe(403);

    // Still pending: a refused decision is not a decision.
    const stored = await prisma.purchaseItemProductChange.findUnique({
      where: { id: request.id },
      select: { status: true },
    });
    expect(stored?.status).toBe('PENDING');
  });

  it('applies the mapping when an approver approves', async () => {
    const request = await pendingRequest();

    const res = await decide(request.id, 'approve', adminToken, 'Checked against the document.');
    expect(res.status).toBe(200);
    expect(await mappingOf(request.itemId)).toBe(productB.id);
  });

  it('preserves the original mapping when an approver rejects', async () => {
    const request = await pendingRequest();

    const res = await decide(request.id, 'reject', adminToken, 'The original mapping was right.');
    expect(res.status).toBe(200);
    // The whole point of the workflow: a rejection is only ever a record.
    expect(await mappingOf(request.itemId)).toBe(productA.id);
  });

  it('refuses to decide the same request twice', async () => {
    const request = await pendingRequest();
    expect((await decide(request.id, 'approve', adminToken)).status).toBe(200);

    const second = await decide(request.id, 'reject', adminToken);
    expect(second.status).toBe(409);
    expect((second.body as unknown as ErrorBody).code).toBe('PRODUCT_CHANGE_NOT_PENDING');
  });

  it('stores the full audit of who asked, who decided, and why', async () => {
    const request = await pendingRequest();
    await decide(request.id, 'approve', adminToken, 'Confirmed with the vendor.');

    const stored = await prisma.purchaseItemProductChange.findUnique({
      where: { id: request.id },
    });

    expect(stored).toMatchObject({
      status: 'APPROVED',
      fromRsProductId: productA.id,
      toRsProductId: productB.id,
      requestedById: staff.id,
      reviewedById: admin.id,
      reviewNote: 'Confirmed with the vendor.',
    });
    // Both ends of the move survive the decision, so the record still says what
    // was asked rather than only where the line ended up.
    expect(stored!.reason.length).toBeGreaterThan(0);
    expect(stored!.requestedAt).toBeInstanceOf(Date);
    expect(stored!.reviewedAt).toBeInstanceOf(Date);
  });
});

describe('the two stock figures reach the API as two figures', () => {
  it('reports CRM stock and RS stock separately on a bill line', async () => {
    const line = await billWithLine(productA.id);
    expect(line.rsProduct).not.toBeNull();
    expect(line.rsProduct!.crmStockQty).toBe(4);
    expect(line.rsProduct!.rsStockQty).toBe(9);
  });

  it('keeps them apart for a second product too', async () => {
    const line = await billWithLine(productB.id);
    expect(line.rsProduct!.crmStockQty).toBe(1);
    expect(line.rsProduct!.rsStockQty).toBe(2);
  });

  it('does not move either figure when goods are received', async () => {
    const line = await billWithLine(productA.id);

    const res = await api('POST', `/api/procurement/bills/${line.billId}/items/${line.id}/receive`, {
      token: staffToken,
      body: { receivedQty: 7 },
    });
    expect(res.status).toBe(200);

    // Receiving records what arrived. It is not a stock movement in this
    // design, and no ledger exists to record one in.
    const variants = await prisma.shopifyVariant.findMany({
      where: { rsProductId: productA.id },
      select: { crmStockQty: true, inventoryQty: true },
    });
    expect(variants.every((v) => v.crmStockQty === 4)).toBe(true);
    expect(variants.every((v) => v.inventoryQty === 9)).toBe(true);
  });
});

/**
 * An approved product change carries the line's stock with it.
 *
 * The one mutation path the other suites do not reach. A change is only
 * permitted on a line with no allocations, but such a line can still hold
 * stock — an approved bill credits its whole receipt when nothing is committed
 * — so approving the change has to take that stock off the product it was
 * credited to and put it on the product the line now names.
 *
 * The ordering is what this pins. `reconcileLineStock` always works against the
 * line's CURRENT product, so releasing after the id changed would credit the new
 * product while leaving the old one holding stock no line accounts for. That
 * would not fail any existing assertion; it would just quietly inflate one
 * product's count and deflate nothing.
 *
 * Fresh products rather than the suite's shared productA/productB, which other
 * tests assert are exactly 4 and 1 — moving those would make this test's
 * position in the file part of its meaning.
 */
describe('approving a product change moves the stock with the mapping', () => {
  it('debits the old product, credits the new one, and conserves the total', async () => {
    const from = await makeRsProduct({ crmStockQty: 4 });
    const to = await makeRsProduct({ crmStockQty: 1 });

    const crmStock = async (rsProductId: string): Promise<number> => {
      const rows = await prisma.shopifyVariant.findMany({
        where: { rsProductId },
        select: { crmStockQty: true },
      });
      return rows.reduce((sum, v) => sum + v.crmStockQty, 0);
    };

    // A bill of 10, mapped to `from`, approved: nothing is committed, so all
    // ten units become free stock on `from`.
    const line = await billWithLine(from.id);
    await approvePurchaseBill(line.billId);

    expect(await crmStock(from.id)).toBe(14);
    expect(await crmStock(to.id)).toBe(1);
    const totalBefore = (await crmStock(from.id)) + (await crmStock(to.id));

    const requested = await requestChange(
      line,
      to.id,
      'The vendor document lists the other product entirely.',
    );
    expect(requested.status).toBe(200);

    // A pending request moves nothing.
    expect(await crmStock(from.id)).toBe(14);
    expect(await crmStock(to.id)).toBe(1);

    const changeId = (requested.body as unknown as BillBody).data.bill.items[0]!
      .pendingProductChange!.id;
    const approved = await decide(changeId, 'approve', adminToken);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    // The mapping moved...
    expect(await mappingOf(line.id)).toBe(to.id);

    // ...and so did the ten units: `from` is back to its hand-counted 4, and
    // `to` holds its own 1 plus the 10 that came across.
    expect(await crmStock(from.id)).toBe(4);
    expect(await crmStock(to.id)).toBe(11);

    // Nothing was created or lost on the way: no duplicate credit, no orphan
    // left behind on the old product.
    expect((await crmStock(from.id)) + (await crmStock(to.id))).toBe(totalBefore);

    // And the line stands for exactly what it put into the new product.
    const stored = await prisma.purchaseBillItem.findUniqueOrThrow({
      where: { id: line.id },
      select: { stockedQty: true },
    });
    expect(stored.stockedQty).toBe(10);
  });
});
