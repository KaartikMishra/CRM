/**
 * Every newly recorded purchase bill needs an administrator's sign-off.
 *
 * Recording a bill is procurement work; trusting it is not. The rule under test:
 *
 *   recorded          →  approvalStatus PENDING, stock NOT allocatable
 *   approved          →  stock allocatable
 *   rejected          →  stock never allocatable
 *
 * Two claims are worth proving rather than asserting from the UI. First, that
 * allocation actually refuses an unapproved bill — hiding the button would leave
 * the API open. Second, that nobody signs off their own bill, which no
 * permission grant can lift: holding approval rights means being trusted to
 * check other people's paperwork, not to wave through your own.
 *
 * Deliberately separate from the product-change approval suite next door. That
 * decides one proposed edit to one line; this decides the bill itself, and the
 * two must not be conflated.
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
  cleanup,
  makeCustomer,
  makeRsProduct,
  makeUser,
  makeVendor,
  mapOrderLineToRsProduct,
  purchaseBillPayload,
  residualTestRows,
  salesOrderPayload,
  trackPurchaseBill,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let recorder: TestUser;
let approver: TestUser;
let recorderToken: string;
let approverToken: string;
let vendor: { id: string; name: string };
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();

  /*
    Two distinct people, and that separation is the subject.

    `recorder` holds VIEW/CREATE/EDIT — enough to record a bill and map its
    lines — but not ASSIGN. `approver` is the administrator who signs off. A
    single-user suite could not tell "refused because of the capability" apart
    from "refused because it is your own bill", which are different rules.
  */
  recorder = await makeUser('USER');
  approver = await makeUser('ADMIN');
  recorderToken = await mintToken(recorder.id, { role: 'USER' });
  approverToken = await mintToken(approver.id, { role: 'ADMIN' });
  vendor = await makeVendor();
  customer = await makeCustomer();

  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
      userId: recorder.id,
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

type Bill = {
  id: string;
  approvalStatus: string;
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  status: string;
  billTotal: string;
  items: { id: string; orderedQty: number; receivedQty: number; rate: string }[];
};

/** A bill recorded by `recorder`, mapped to `rsProductId`. */
async function recordBill(rsProductId: string, token = recorderToken): Promise<Bill> {
  const res = await api('POST', '/api/procurement/bills', {
    token,
    body: purchaseBillPayload(vendor.id, rsProductId),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const bill = (res.body.data as { bill: Bill }).bill;
  trackPurchaseBill(bill.id);
  return bill;
}

/** An order line for the same product, so allocation has somewhere to go. */
async function orderLineFor(rsProductId: string, quantity: number): Promise<string> {
  const res = await api('POST', '/api/sales', {
    token: approverToken,
    body: salesOrderPayload(customer.id, {
      items: [{ productName: 'zz-test line', quantity, price: '100.00' }],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = (res.body.data as { order: { id: string; items: { id: string }[] } }).order;
  trackSalesOrder(order.id);
  await mapOrderLineToRsProduct(order.items[0]!.id, rsProductId);
  return order.items[0]!.id;
}

const allocate = (billId: string, itemId: string, salesOrderItemId: string, quantity: number) =>
  api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
    token: approverToken,
    body: { salesOrderItemId, quantity },
  });

const decide = (billId: string, d: 'approve' | 'reject', token: string, note?: string) =>
  api('POST', `/api/procurement/bills/${billId}/${d}`, {
    token,
    body: note ? { note } : {},
  });

describe('a newly recorded bill starts pending', () => {
  it('reports PENDING on creation', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    expect(bill.approvalStatus).toBe('PENDING');
    expect(bill.reviewedBy).toBeNull();
    expect(bill.reviewedAt).toBeNull();
  });

  it('keeps every figure it was recorded with', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    // Approval gates what a bill can do, not what it says. Quantities, rate and
    // the derived total are untouched by the new column.
    expect(bill.items).toHaveLength(1);
    expect(bill.items[0]!.orderedQty).toBe(10);
    expect(bill.items[0]!.receivedQty).toBe(10);
    expect(bill.items[0]!.rate).toBe('100.00');
    expect(bill.billTotal).toBe('1000.00');
  });

  it('can still be received against while pending', async () => {
    // Receiving records what physically arrived. Blocking it would lose a fact
    // rather than protect anything — approval gates committing stock, not
    // observing it.
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    const res = await api(
      'POST',
      `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/receive`,
      { token: recorderToken, body: { receivedQty: 6 } },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('is listable as a pending queue', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    const res = await api('GET', '/api/procurement/bills?approvalStatus=PENDING&limit=50', {
      token: approverToken,
    });
    expect(res.status).toBe(200);
    const ids = (res.body.data as { bills: { id: string }[] }).bills.map((b) => b.id);
    expect(ids).toContain(bill.id);
  });
});

describe('a pending bill is not a usable bill', () => {
  it('refuses to allocate its stock', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);
    const lineId = await orderLineFor(rs.id, 5);

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 3);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BILL_NOT_APPROVED');
    expect(await prisma.purchaseAllocation.count({ where: { salesOrderItemId: lineId } })).toBe(0);
  });

  it('refuses an administrator too — approval is the gate, not the role', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id, approverToken);
    const lineId = await orderLineFor(rs.id, 5);

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 3);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BILL_NOT_APPROVED');
  });

  it('allocates once approved', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);
    const lineId = await orderLineFor(rs.id, 5);

    expect((await decide(bill.id, 'approve', approverToken)).status).toBe(200);

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 3);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await prisma.purchaseAllocation.count({ where: { salesOrderItemId: lineId } })).toBe(1);
  });

  it('never allocates a rejected bill, and says so distinctly', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);
    const lineId = await orderLineFor(rs.id, 5);

    await decide(bill.id, 'reject', approverToken, 'Vendor billed the wrong goods.');

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 3);
    expect(res.status).toBe(409);
    // A different code from PENDING: "nobody has looked at this" and "somebody
    // looked and said no" lead to different next actions.
    expect(res.body.code).toBe('BILL_REJECTED');
  });
});

describe('only approval rights can decide a bill', () => {
  it('refuses the recorder, who holds EDIT but not ASSIGN', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    // The bypass a hand-crafted client would attempt: skip the UI, call the
    // endpoint directly.
    const res = await decide(bill.id, 'approve', recorderToken);
    expect(res.status).toBe(403);

    const stored = await prisma.purchaseBill.findUnique({
      where: { id: bill.id },
      select: { approvalStatus: true },
    });
    expect(stored?.approvalStatus).toBe('PENDING');
  });

  it('refuses an unauthenticated caller', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);
    const res = await api('POST', `/api/procurement/bills/${bill.id}/approve`, { body: {} });
    expect(res.status).toBe(401);
  });

  it('refuses self-approval even from an administrator', async () => {
    // The rule no capability can lift. This bill is recorded BY the approver.
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id, approverToken);

    const res = await decide(bill.id, 'approve', approverToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_APPROVAL_NOT_ALLOWED');

    const stored = await prisma.purchaseBill.findUnique({
      where: { id: bill.id },
      select: { approvalStatus: true },
    });
    expect(stored?.approvalStatus).toBe('PENDING');
  });

  it('refuses self-rejection on the same grounds', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id, approverToken);

    const res = await decide(bill.id, 'reject', approverToken, 'Changed my mind.');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
  });
});

describe('a decision is recorded once and stays recorded', () => {
  it('stores who approved, when, and any note', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    const res = await decide(bill.id, 'approve', approverToken, 'Checked against the document.');
    expect(res.status).toBe(200);

    const returned = (res.body.data as { bill: Bill }).bill;
    expect(returned.approvalStatus).toBe('APPROVED');
    expect(returned.reviewedBy?.id).toBe(approver.id);
    expect(returned.reviewedAt).not.toBeNull();
    expect(returned.reviewNote).toBe('Checked against the document.');
  });

  it('stores a rejection the same way', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    const res = await decide(bill.id, 'reject', approverToken, 'Totals do not match the paper.');
    const returned = (res.body.data as { bill: Bill }).bill;

    expect(returned.approvalStatus).toBe('REJECTED');
    expect(returned.reviewedBy?.id).toBe(approver.id);
    expect(returned.reviewNote).toBe('Totals do not match the paper.');
  });

  it('refuses to decide the same bill twice', async () => {
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    expect((await decide(bill.id, 'approve', approverToken)).status).toBe(200);

    const second = await decide(bill.id, 'reject', approverToken);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('BILL_ALREADY_REVIEWED');
  });

  it('leaves the receipt lifecycle untouched, and vice versa', async () => {
    /*
      The two axes stay independent, which is the reason approval is its own
      column rather than a PurchaseBillStatus value.

      `status` is derived from the lines by `receiveItem` and is not computed at
      creation — a bill recorded as fully received still reads OPEN until a
      receipt is posted against it. So this receives first, to reach the state
      that actually matters: RECEIVED goods on a bill nobody has approved. A
      single enum could not have held both of those at once.
    */
    const rs = await makeRsProduct();
    const bill = await recordBill(rs.id);

    const received = await api(
      'POST',
      `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/receive`,
      { token: recorderToken, body: { receivedQty: 10 } },
    );
    expect(received.status, JSON.stringify(received.body)).toBe(200);

    const before = await prisma.purchaseBill.findUniqueOrThrow({
      where: { id: bill.id },
      select: { status: true, approvalStatus: true },
    });
    // Fully arrived, still untrusted.
    expect(before.status).toBe('RECEIVED');
    expect(before.approvalStatus).toBe('PENDING');

    await decide(bill.id, 'approve', approverToken);

    const after = await prisma.purchaseBill.findUniqueOrThrow({
      where: { id: bill.id },
      select: { status: true, approvalStatus: true },
    });
    // Approving moved the approval axis and nothing else.
    expect(after.status).toBe('RECEIVED');
    expect(after.approvalStatus).toBe('APPROVED');
  });

  it('refuses a bill that does not exist', async () => {
    const res = await decide('ckd0000000000000000000001', 'approve', approverToken);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PURCHASE_BILL_NOT_FOUND');
  });
});
