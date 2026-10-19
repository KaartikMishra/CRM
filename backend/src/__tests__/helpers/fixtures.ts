/**
 * Test fixtures against the real database.
 *
 * HTTP-level tests cannot roll back — the server holds its own connections — so
 * everything created is tracked and removed in `cleanup()`. Deletion order
 * follows the foreign keys: enquiries first (their products, vendor responses,
 * events and delay records cascade), then the masters, then the users.
 *
 * Every record is named with a recognisable prefix so anything that does escape
 * is obvious in the database rather than looking like real business data.
 */

import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import type { CustomerType, Role } from '@rs/shared';

import { prisma } from '../../config/database.js';
import { reconcileLineStock } from '../../modules/procurement/procurement.service.js';

/**
 * The marker that says "this row is a test fixture".
 *
 * Every fixture name in this file begins with it, so anything that escapes is
 * obviously debris rather than looking like real business data — and so the
 * sweep below has something to recognise test-owned rows by.
 */
export const TEST_PREFIX = 'zz-test';

/**
 * This run's own marker, and the mechanism that makes cleanup safe.
 *
 * ### The problem two mechanisms could not solve on their own
 *
 * Cleanup has to satisfy two requirements that pull in opposite directions:
 *
 *   1. A run must never delete a *concurrent* run's fixtures. Tearing down
 *      somebody else's rows mid-test shows up as an inexplicable flake.
 *   2. An orphan from a run that already ended must not survive, because
 *      `residualTestRows()` counts test rows *globally* and fails the `afterAll`
 *      of every later suite on rows it never created.
 *
 * A bare `{ name: { startsWith: 'zz-test' } }` delete satisfies (2) and violates
 * (1): it reaches every run's rows. Bounding that delete by age instead satisfies
 * (1) and violates (2): an orphan younger than the threshold is skipped by the
 * sweep and then fails every subsequent suite's residual check until it ages out.
 * Age cannot distinguish "young because a concurrent run just made it" from
 * "young because a run died a minute ago", because the two are the same
 * observation.
 *
 * ### Ownership, not timing
 *
 * So ownership is written into the name. Every fixture is called
 * `zz-test-r<runId>-…`, where runId is unique to this process. That turns an
 * unanswerable timing question into a decidable one:
 *
 *   - `zz-test-r<thisRun>-…`   mine. Delete unconditionally, at any age.
 *   - `zz-test-r<otherRun>-…`  another run's. Reclaim only once it is old enough
 *                              to be certain that run has ended.
 *   - no run marker at all     a fixture from before this scheme, or one built by
 *                              hand. Reclaimed on age, as before.
 *
 * Requirement (2) is met for the common case — a suite's own orphans, including
 * rows the API created whose ids were never tracked, carry this run's marker and
 * go immediately. Requirement (1) is met absolutely: a concurrent run's rows
 * carry a different marker and are unreachable while that run could still be
 * using them.
 *
 * The age bound survives, but only for rows this run demonstrably does not own.
 * It is no longer the ownership mechanism — it is the fallback for rows whose
 * owner cannot be identified.
 *
 * ### Why the process id is part of it
 *
 * `randomUUID` alone would be enough for uniqueness. The pid is included because
 * it makes an escaped row traceable: `zz-test-r4e91c2-42317-customer-…` names the
 * process that made it, which is what somebody looking at a stray row in the
 * database actually wants to know.
 */
export const TEST_RUN_ID = `${randomUUID().replace(/-/g, '').slice(0, 6)}-${process.pid}`;

/**
 * The prefix every fixture in this run is named with.
 *
 * Keeps TEST_PREFIX as its own leading segment, so the global "is this a test
 * row" checks in `residualTestRows()` and the sweep keep working unchanged.
 */
export const RUN_PREFIX = `${TEST_PREFIX}-r${TEST_RUN_ID}`;

/** Matches any run's marker, so "some run owns this" is testable. */
const RUN_MARKER_PATTERN = /^zz-test-r[0-9a-f]{6}-\d+-/;

/** Whether a fixture name carries a run marker, and whether it is this run's. */
export function fixtureOwnership(name: string): 'mine' | 'other-run' | 'unmarked' {
  if (name.startsWith(`${RUN_PREFIX}-`)) return 'mine';
  return RUN_MARKER_PATTERN.test(name) ? 'other-run' : 'unmarked';
}

const created = {
  enquiryIds: [] as string[],
  salesOrderIds: [] as string[],
  userIds: [] as string[],
  customerIds: [] as string[],
  vendorIds: [] as string[],
  rsProductIds: [] as string[],
  purchaseBillIds: [] as string[],
  /**
   * Partial-dispatch requests this run caused, collected for their notices.
   *
   * These ids are never used to delete the requests themselves — those cascade
   * from their sales order like everything else. They exist because
   * `Notification.entityId` is a plain string with no foreign key, so a notice
   * about a request is NOT removed when the request is: the row survives,
   * pointing at an id that no longer resolves, in the inbox of whoever could
   * have decided it.
   *
   * That matters here more than for most fixtures. Partial-dispatch notices go
   * to everyone holding PROCUREMENT:ASSIGN, which in a real database means real
   * administrators — so an untidied test run leaves debris in colleagues'
   * notification bells rather than in a row nobody looks at.
   */
  partialDispatchRequestIds: [] as string[],
};

const short = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

export type TestUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  role: Role;
  token?: string;
};

export async function makeUser(role: Role = 'USER', isActive = true): Promise<TestUser> {
  const suffix = short();
  const user = await prisma.user.create({
    data: {
      employeeId: `ZZ${suffix.slice(0, 8).toUpperCase()}`,
      name: `${RUN_PREFIX}-${role.toLowerCase()}`,
      email: `${RUN_PREFIX}-${suffix}@test.invalid`,
      passwordHash: await bcrypt.hash(`pw-${suffix}`, 4),
      role,
      isActive,
    },
    select: { id: true, name: true, email: true, employeeId: true, role: true },
  });
  created.userIds.push(user.id);
  return user;
}

/**
 * A customer, optionally with contact details.
 *
 * Contact is opt-in so the existing suites keep exercising the "not recorded"
 * path, which is what most real rows look like today.
 */
export async function makeCustomer(
  type: CustomerType = 'RETAIL',
  contact: {
    companyName?: string;
    phone?: string;
    email?: string;
    address?: string;
    state?: string;
    country?: string;
    gstNumber?: string;
  } = {},
): Promise<{
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  country: string | null;
  gstNumber: string | null;
}> {
  const customer = await prisma.customer.create({
    data: {
      name: `${RUN_PREFIX}-customer-${short()}`,
      type,
      companyName: contact.companyName ?? null,
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      address: contact.address ?? null,
      state: contact.state ?? null,
      country: contact.country ?? null,
      gstNumber: contact.gstNumber ?? null,
    },
    select: {
      id: true,
      name: true,
      companyName: true,
      phone: true,
      email: true,
      address: true,
      state: true,
      country: true,
      gstNumber: true,
    },
  });
  created.customerIds.push(customer.id);
  return customer;
}

export async function makeVendor(isActive = true): Promise<{ id: string; name: string }> {
  const vendor = await prisma.vendor.create({
    data: { name: `${RUN_PREFIX}-vendor-${short()}`, isActive },
    select: { id: true, name: true },
  });
  created.vendorIds.push(vendor.id);
  return vendor;
}

/** Registers an enquiry created through the API so cleanup removes it. */
export function trackEnquiry(id: string): string {
  created.enquiryIds.push(id);
  return id;
}

/** Registers a sales order created through the API so cleanup removes it. */
export function trackSalesOrder(id: string): string {
  created.salesOrderIds.push(id);
  return id;
}

/**
 * Registers a partial-dispatch request so its notices are cleaned up too.
 *
 * Optional for a suite to call: `cleanup` discovers these itself from the
 * tracked sales orders (see `collectPartialDispatchRequests`). This exists for
 * a request whose order was never tracked, and is idempotent.
 */
export function trackPartialDispatchRequest(id: string): string {
  if (!created.partialDispatchRequestIds.includes(id)) {
    created.partialDispatchRequestIds.push(id);
  }
  return id;
}

/** Registers a purchase bill created through the API so cleanup removes it. */
export function trackPurchaseBill(id: string): string {
  created.purchaseBillIds.push(id);
  return id;
}

/**
 * Signs a test bill off, so its stock can be allocated.
 *
 * Every newly recorded bill starts PENDING and cannot be allocated from until
 * an administrator approves it. Suites whose subject is allocation arithmetic
 * need an approved bill to work with, and would otherwise all fail on a rule
 * they are not testing.
 *
 * A direct write rather than a call to the approve endpoint, and deliberately:
 * the endpoint refuses self-approval, so a suite whose bills and whose admin are
 * the same person could not use it. That refusal is a rule worth keeping intact
 * and is asserted properly in purchase-bill-approval.test.ts; here it would only
 * force every suite to invent a second user.
 *
 * `reviewedById` is left null, matching the shape the backfill migration used
 * for bills that predate the rule — and permitted by bill_decided_has_reviewer
 * for exactly that reason.
 *
 * The stock reconciliation is the service's OWN function, not a restatement of
 * it. Approval is where a bill's surplus enters CRM stock, so a fixture that
 * only flipped the status would leave every line claiming to owe stock it had
 * never contributed — and the next allocation would then deduct against nothing
 * and drive the product negative. Calling the real reconciler means this helper
 * cannot drift from the rule it is standing in for.
 */
export async function approvePurchaseBill(billId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.purchaseBill.update({
      where: { id: billId },
      data: { approvalStatus: 'APPROVED' },
    });

    const lines = await tx.purchaseBillItem.findMany({
      where: { billId },
      select: { id: true },
    });
    for (const line of lines) {
      await reconcileLineStock(tx, line.id);
    }
  });
}

/**
 * An RS Product — the CRM's one product identity — with one CRM-only variant.
 *
 * `MANUAL` rather than `SHOPIFY`, so nothing here pretends to have come from a
 * store and no sync could claim it. One variant because that is what the real
 * catalogue looks like: every one of its products has at least one, and CRM-only
 * products get exactly one rather than a special case.
 *
 * `crmStockQty` sits on the variant because that is the only place it exists.
 * Procurement reads the product-level sum of it and never the variant, which is
 * precisely what a fixture with a known per-variant figure lets a test assert.
 *
 * `sku` is a parameter, and deliberately so: two fixtures may share one, because
 * RS SKUs are not unique and a test needs to be able to build that situation.
 */
export async function makeRsProduct(
  options: {
    crmStockQty?: number;
    /**
     * Shopify's sellable quantity — RS Product Stock.
     *
     * Separate from `crmStockQty` above and defaulted separately, so a test can
     * set the two to different values and prove they travel to the API as two
     * different numbers. A single knob driving both would make the one bug this
     * pair exists to catch — one figure being reported under the other's name —
     * invisible, because both columns would agree.
     */
    inventoryQty?: number;
    sku?: string | null;
    title?: string;
    /** A catalogue image, so image precedence can be proved end to end. */
    imageUrl?: string;
  } = {},
): Promise<{ id: string; title: string; sku: string | null; variantId: string }> {
  const title = options.title ?? `${RUN_PREFIX}-rs-${short()}`;
  const product = await prisma.rsProduct.create({
    data: {
      source: 'MANUAL',
      title,
      status: 'ACTIVE',
      ...(options.imageUrl
        ? { images: { create: { url: options.imageUrl, altText: 'catalogue', position: 1 } } }
        : {}),
      variants: {
        create: {
          sku: options.sku ?? null,
          price: '100.00',
          crmStockQty: options.crmStockQty ?? 0,
          inventoryQty: options.inventoryQty ?? 0,
          position: 1,
        },
      },
    },
    select: { id: true, title: true, variants: { select: { id: true, sku: true } } },
  });
  created.rsProductIds.push(product.id);
  return {
    id: product.id,
    title: product.title,
    sku: product.variants[0]!.sku,
    variantId: product.variants[0]!.id,
  };
}

/** Sets a product's CRM stock directly, for arranging a scenario without the API. */
export async function setCrmStock(rsProductId: string, crmStockQty: number): Promise<void> {
  await prisma.shopifyVariant.updateMany({ where: { rsProductId }, data: { crmStockQty } });
}

/**
 * Maps a sales order line to an RS Product.
 *
 * Raw SQL on purpose: `sales_order_money_guard` is a deferred constraint
 * trigger that re-checks the parent order's payment invariants on any write to
 * a line. Going through Prisma would drag unrelated columns into the statement
 * on orders the fixtures deliberately leave part-paid.
 */
export async function mapOrderLineToRsProduct(
  salesOrderItemId: string,
  rsProductId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SalesOrderItem" SET "rsProductId" = ${rsProductId} WHERE "id" = ${salesOrderItemId}`;
}

/**
 * A purchase bill payload with one line, as the create endpoint expects it.
 *
 * `rsProductId` is optional: a bill is recorded from a piece of paper and a
 * line may legitimately name nothing yet. Pass an empty string for a line that
 * should be left unmapped.
 */
export function purchaseBillPayload(
  vendorId: string,
  rsProductId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    billNumber: `${RUN_PREFIX}-BILL-${short()}`.toUpperCase(),
    vendorId,
    billType: 'CREDIT',
    billDate: new Date().toISOString(),
    items: [
      {
        productName: `${RUN_PREFIX}-bill-line`,
        ...(rsProductId ? { rsProductId } : {}),
        orderedQty: 10,
        receivedQty: 10,
        rate: '100.00',
      },
    ],
    ...overrides,
  };
}

/**
 * A unique order id per test run.
 *
 * SalesOrder.orderId is unique across the whole table, so a fixed literal would
 * collide the second time a suite runs against the same database.
 */
export const salesOrderId = (): string => `${RUN_PREFIX}-SO-${short()}`.toUpperCase();

/** One product line, as the create endpoint expects it. */
export function salesItemPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    productName: `${RUN_PREFIX}-product`,
    quantity: 12,
    price: '1250.50',
    ...overrides,
  };
}

/** An ADD change-request payload. */
export function addRequestPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'ADD', productName: `${RUN_PREFIX}-added`, quantity: 2, price: '50.00', ...overrides };
}

/** An EDIT change-request payload against a given line. */
export function editRequestPayload(
  itemId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'EDIT', itemId,
    productName: `${RUN_PREFIX}-edited`, quantity: 3, price: '100.00',
    ...overrides,
  };
}

/** A REMOVE change-request payload against a given line. */
export const removeRequestPayload = (itemId: string): Record<string, unknown> => ({
  type: 'REMOVE', itemId,
});

/**
 * Builds a valid create-sales-order payload.
 *
 * One line by default, so the many tests that only care about an order having
 * *a* value stay readable; pass `items` to build a multi-line order.
 */
export function salesOrderPayload(
  customerId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const orderDate = new Date();
  const toBeDispatchedBy = new Date(orderDate.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    orderId: salesOrderId(),
    customerId,
    items: [salesItemPayload()],
    paidAmount: '0',
    orderDate: orderDate.toISOString(),
    toBeDispatchedBy: toBeDispatchedBy.toISOString(),
    ...overrides,
  };
}

/**
 * Moves a sales order's dispatch deadline into the past so a DELAYED verdict can
 * be tested without waiting days. Only the test suite does this — no application
 * path can rewrite the deadline of an order once it is dispatched.
 */
export async function backdateDispatchDeadline(id: string, daysAgo: number): Promise<void> {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await prisma.salesOrder.update({
    where: { id },
    data: { orderDate: past, toBeDispatchedBy: past },
  });
}

/** Builds a valid create-enquiry payload with `count` products. */
export function enquiryPayload(
  customerId: string,
  assignedToId: string,
  count = 1,
): Record<string, unknown> {
  return {
    customer: { customerId },
    source: 'CALL',
    assignedToId,
    products: Array.from({ length: count }, (_, i) => ({
      name: `${RUN_PREFIX}-product-${i + 1}`,
      quantity: 10 * (i + 1),
      similarOptionNeeded: i % 2 === 0,
      weight: { value: 1.5, unit: 'KG' },
      dimension: { length: 10, width: 5, height: 3, unit: 'CM' },
    })),
  };
}

export function vendorResponsePayload(vendorId: string): Record<string, unknown> {
  return {
    vendorId,
    matchType: 'SIMILAR_PRODUCT',
    ratePerUnit: '850.00',
    deliveryWithinDays: 7,
    weight: { value: 1.4, unit: 'KG' },
  };
}

/**
 * Backdates an enquiry's clock so a breach can be tested without waiting
 * fifteen real minutes. Only the test suite does this — no application code
 * path can move createdAt or slaDeadlineAt.
 */
export async function backdateEnquiry(id: string, minutesAgo: number): Promise<void> {
  const enquiry = await prisma.productEnquiry.findUniqueOrThrow({
    where: { id },
    select: { slaMinutes: true },
  });
  const createdAt = new Date(Date.now() - minutesAgo * 60_000);
  await prisma.productEnquiry.update({
    where: { id },
    data: {
      createdAt,
      slaDeadlineAt: new Date(createdAt.getTime() + enquiry.slaMinutes * 60_000),
    },
  });
}

/**
 * Runs one cleanup step, remembering a failure instead of abandoning the rest.
 *
 * `cleanup()` used to be a plain chain of awaits, so the first delete that threw
 * skipped every delete after it. A transient Neon drop during one suite's
 * teardown therefore left its customer, vendor and users behind — and because
 * `residualTestRows()` counts globally, every later suite failed its afterAll on
 * rows it never created. One connection blip became sixteen file failures.
 *
 * Collecting the error rather than propagating it immediately means teardown
 * always attempts everything it was going to attempt. The first failure is
 * re-thrown once the sweep is done, so a genuinely broken cleanup still fails
 * the suite loudly — it simply no longer takes the following suites with it.
 */
async function step(failures: unknown[], run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(error);
  }
}

/**
 * Removes anything still carrying the test prefix, whether or not it was tracked.
 *
 * Tracking happens *after* the create resolves:
 *
 *     const user = await prisma.user.create(...)   // may commit, then the
 *     created.userIds.push(user.id)                // connection dies here
 *
 * If the server commits the insert and the connection drops before the client
 * sees the result, the row exists and no id was ever recorded — so an id-based
 * cleanup cannot reach it, and it survives as a permanent orphan. The same
 * applies to rows the API creates when the response is lost in flight.
 *
 * The sweep closes that hole by asking the database what is test-owned instead
 * of trusting an in-memory list. Scope is deliberately narrow: only rows whose
 * name carries TEST_PREFIX, or rows belonging to one of those, are touched, so
 * real CRM data is unreachable from here by construction. Order follows the
 * foreign keys, exactly as the tracked deletes above do.
 *
 * ### How the sweep is scoped, and why a prefix alone will not do
 *
 * This is the one way this function could destroy work somebody cares about, so
 * the scope is worth being precise about.
 *
 * `{ name: { startsWith: 'zz-test' } }` matches every test-owned row in the
 * database, not merely this run's. One `prisma.user.deleteMany` with that filter
 * reaches the fixtures of any other run sharing the database — a colleague's
 * suite, a CI job against the same branch database, or a second terminal — and
 * tearing those out mid-test surfaces as an inexplicable flake.
 *
 * Bounding it purely by age does not work either, and that failure is the reason
 * this section exists: age cannot distinguish "young because a concurrent run
 * just created this" from "young because a run died a minute ago". Those are the
 * same observation. Treating both as untouchable leaves an orphan behind, and
 * because `residualTestRows()` counts test rows *globally*, that orphan then
 * fails the `afterAll` of every later suite until it ages out. This file shipped
 * exactly that regression once.
 *
 * So the scope is **ownership, read from the name** (see RUN_PREFIX above), with
 * age as a fallback only for rows whose owner cannot be identified:
 *
 *   mine       `zz-test-r<thisRun>-…`      deleted unconditionally, at any age
 *   other run  `zz-test-r<otherRun>-…`     only once older than SWEEP_MIN_AGE_MS
 *   unmarked   `zz-test-…`, no marker      only once older than SWEEP_MIN_AGE_MS
 *
 * That satisfies both requirements at once. A suite's own untracked orphans —
 * including rows the API created whose ids were never recorded, which is exactly
 * the hole described above — carry this run's marker and go immediately, leaving
 * nothing to poison the next suite. A concurrent run's rows carry a different
 * marker and are unreachable while that run could still be using them, whatever
 * their age.
 *
 * `vitest.config.ts` setting `fileParallelism: false` still keeps suites inside
 * one process from overlapping. The ownership marker is what makes the sweep safe
 * when that is not the only thing holding — a second process is a different run.
 */
/**
 * How old a row belonging to *another* run must be before it is reclaimed.
 *
 * Only ever applied to rows this run does not own. An hour is far longer than any
 * suite takes, so a run still in progress is never reached; and because this
 * run's own debris is deleted by marker rather than by age, waiting an hour costs
 * nothing that matters.
 */
const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

async function sweepTestOwnedRows(failures: unknown[]): Promise<void> {
  const staleBefore = new Date(Date.now() - SWEEP_MIN_AGE_MS);

  /*
    Test-owned AND (mine at any age OR somebody else's but demonstrably stale).

    Applied to the *owner* row in every filter below rather than to each child: a
    child is reached through its test-owned parent, so scoping the parent scopes
    the whole graph. A fresh child of an old orphaned parent is still debris and
    is still reached, because the parent qualifies.

    The outer `name: { startsWith: TEST_PREFIX }` is redundant against the first
    OR branch and essential to the second: it is what keeps real business data
    unreachable from here by construction, whatever the age clause admits.
  */
  const owned = {
    name: { startsWith: TEST_PREFIX },
    OR: [
      { name: { startsWith: `${RUN_PREFIX}-` } },
      { createdAt: { lt: staleBefore } },
    ],
  };
  const ownedName = { startsWith: TEST_PREFIX };

  // Enquiries first: their products, vendor responses, events and delay records
  // all cascade from them.
  await step(failures, () =>
    prisma.productEnquiry.deleteMany({
      where: { OR: [{ customer: owned }, { createdBy: owned }, { assignedTo: owned }] },
    }),
  );
  // Vendor -> VendorResponse is Restrict, so any response still pointing at a
  // test vendor has to go before the vendor itself can.
  await step(failures, () => prisma.vendorResponse.deleteMany({ where: { vendor: owned } }));
  /*
    Items, change requests and allocations cascade from the order.

    The third branch is the loosest filter in this function and needs its own
    scope. The first two reach an order through a test-owned customer or creator,
    which `owned` already scopes by ownership. This one reaches an order because a
    *line item* is named `zz-test…`, so it can match an order whose customer and
    creator are both real business records — there is no owner row to inherit a
    marker from.

    So it gets the same two-branch rule applied to the line name itself: a line
    this run named, at any age, or any test-named line on an order old enough that
    no run can still be using it.
  */
  await step(failures, () =>
    prisma.salesOrder.deleteMany({
      where: {
        OR: [
          { customer: owned },
          { createdBy: owned },
          { items: { some: { productName: { startsWith: `${RUN_PREFIX}-` } } } },
          {
            items: { some: { productName: ownedName } },
            createdAt: { lt: staleBefore },
          },
        ],
      },
    }),
  );
  // Bill items and their allocations cascade from the bill.
  await step(failures, () =>
    prisma.purchaseBill.deleteMany({ where: { OR: [{ vendor: owned }, { createdBy: owned }] } }),
  );
  await step(failures, () => prisma.auditLog.deleteMany({ where: { actor: owned } }));
  await step(failures, () => prisma.userModulePermission.deleteMany({ where: { user: owned } }));
  // MediaAsset -> uploadedBy is Restrict, so an asset a test user uploaded would
  // otherwise pin that user in place. Every image reference to it is SetNull.
  await step(failures, () => prisma.mediaAsset.deleteMany({ where: { uploadedBy: owned } }));
  /*
    Leads before customers: Lead -> Customer is Restrict, so a customer carrying
    a lead cannot be removed while it stands. Restrict is right for the business
    — a customer with leads against them is referenced history — and it means
    teardown has to take the lead first rather than relying on a cascade.
  */
  await step(failures, () => prisma.lead.deleteMany({ where: { customer: owned } }));
  await step(failures, () => prisma.lead.deleteMany({ where: { createdBy: owned } }));
  /*
    And any a fixture user owns or allocated. Lead -> User is Restrict on both
    `associate` and `allocatedBy`, so a user who was assigned a lead cannot be
    removed while it stands — even one raised against a customer this run did
    not create. Activities cascade from the lead, so they need no step of their
    own.
  */
  await step(failures, () => prisma.lead.deleteMany({ where: { associate: owned } }));
  await step(failures, () => prisma.lead.deleteMany({ where: { allocatedBy: owned } }));
  /*
    The cross-cutting foundation tables, for the same reason the tracked teardown
    removes them: ApprovalRequest and SecureDocument are Restrict on User, so an
    orphaned row holds its user here too. HRSetting is SetNull and pins nobody,
    but a stale row would collide on (module, key) with the next run's upsert.
  */
  await step(failures, () =>
    prisma.approvalRequest.deleteMany({
      where: { OR: [{ requestedBy: owned }, { decidedBy: owned }] },
    }),
  );
  await step(failures, () =>
    prisma.secureDocument.deleteMany({ where: { uploadedBy: owned } }),
  );
  await step(failures, () => prisma.hRSetting.deleteMany({ where: { updatedBy: owned } }));
  await step(failures, () => prisma.customer.deleteMany({ where: owned }));
  await step(failures, () => prisma.vendor.deleteMany({ where: owned }));
  await step(failures, () => prisma.user.deleteMany({ where: owned }));

  /*
    RS Products, which the sweep did not previously reach at all.

    They were cleaned only by tracked id, while `residualTestRows()` counts them
    globally by title — so an untracked one (a create whose response was lost, or
    one the API made) had nothing to reclaim it and would fail every later suite's
    residual check indefinitely. That is the same defect the run marker fixes
    elsewhere, so it is fixed the same way here.

    Scoped on `title` rather than `name` because that is the column RsProduct
    uses, and `owned` is a name filter. Variants and images cascade from the
    product.
  */
  await step(failures, () =>
    prisma.rsProduct.deleteMany({
      where: {
        title: { startsWith: TEST_PREFIX },
        OR: [
          { title: { startsWith: `${RUN_PREFIX}-` } },
          { createdAt: { lt: staleBefore } },
        ],
      },
    }),
  );
}

/**
 * Notes every partial-dispatch request belonging to this run's sales orders.
 *
 * MUST run before anything deletes those orders. `PartialDispatchRequest`
 * cascades from `SalesOrder`, so once the order goes the request goes with it —
 * and its id, which is the only thing linking a stranded notice back to this
 * test run, is gone with it too. Reading the ids first is what makes the notices
 * findable afterwards.
 *
 * Failures are collected rather than thrown: an unreadable request list must not
 * stop the rest of teardown.
 */
async function collectPartialDispatchRequests(failures: unknown[]): Promise<void> {
  if (created.salesOrderIds.length === 0) return;

  await step(failures, async () => {
    const rows = await prisma.partialDispatchRequest.findMany({
      where: { salesOrderId: { in: created.salesOrderIds } },
      select: { id: true },
    });
    for (const row of rows) trackPartialDispatchRequest(row.id);
  });
}

/**
 * Removes the notices raised about this run's partial-dispatch requests.
 *
 * Scoped by `entityId` against the tracked ids and by `entityType`, never by
 * notification type alone: the four PARTIAL_DISPATCH types are also produced by
 * real work, and deleting by type would take a real administrator's real notice
 * along with the test debris. An id that was never tracked is never matched, so
 * a notice this run did not cause cannot be removed by it.
 *
 * Idempotent — a second call matches nothing, because the rows are gone and the
 * id list has been cleared.
 */
async function deletePartialDispatchNotifications(failures: unknown[]): Promise<void> {
  if (created.partialDispatchRequestIds.length === 0) return;

  await step(failures, () =>
    prisma.notification.deleteMany({
      where: {
        entityType: 'PartialDispatchRequest',
        entityId: { in: created.partialDispatchRequestIds },
      },
    }),
  );
}

export async function cleanup(): Promise<void> {
  const failures: unknown[] = [];

  /*
    First, before any delete: the partial-dispatch requests cascade away with
    their sales orders below, taking with them the only link between a stranded
    notice and this run.
  */
  await collectPartialDispatchRequests(failures);

  if (created.enquiryIds.length) {
    await step(failures, () =>
      prisma.productEnquiry.deleteMany({ where: { id: { in: created.enquiryIds } } }),
    );
  }
  // Sales orders hold foreign keys to Customer and User, so they must go before
  // either of those or the deletes below fail on a constraint.
  if (created.salesOrderIds.length) {
    await step(failures, () =>
      prisma.salesOrder.deleteMany({ where: { id: { in: created.salesOrderIds } } }),
    );
  }
  // Anything the API created for these users that we did not track by id.
  if (created.userIds.length) {
    await step(failures, () =>
      prisma.productEnquiry.deleteMany({
        where: {
          OR: [{ createdById: { in: created.userIds } }, { assignedToId: { in: created.userIds } }],
        },
      }),
    );
    await step(failures, () =>
      prisma.salesOrder.deleteMany({
        where: {
          OR: [{ createdById: { in: created.userIds } }, { closedById: { in: created.userIds } }],
        },
      }),
    );
    await step(failures, () =>
      prisma.auditLog.deleteMany({ where: { actorId: { in: created.userIds } } }),
    );
    await step(failures, () =>
      prisma.userModulePermission.deleteMany({ where: { userId: { in: created.userIds } } }),
    );
    /*
      The cross-cutting foundation tables. All three hold Restrict foreign keys to
      User — deliberately, because a decision whose decider vanished is unreadable
      evidence — which means every one of them pins a fixture user in place until
      it goes. Without these three steps the user delete below fails on a
      constraint and the whole teardown reports a failure that has nothing to do
      with the test that ran.

      ApprovalRequest is reachable through either side, so both are named: a run
      that raised a request and a run that decided somebody else's leave both
      leave a row pointing at their user.
    */
    await step(failures, () =>
      prisma.approvalRequest.deleteMany({
        where: {
          OR: [
            { requestedById: { in: created.userIds } },
            { decidedById: { in: created.userIds } },
          ],
        },
      }),
    );
    await step(failures, () =>
      prisma.secureDocument.deleteMany({
        where: {
          OR: [
            { uploadedById: { in: created.userIds } },
            // A document filed against a fixture user, whoever uploaded it.
            { ownerType: 'User', ownerId: { in: created.userIds } },
          ],
        },
      }),
    );
    /*
      HRSetting is SetNull on its user rather than Restrict, so it does not pin
      anybody and a missed row cannot fail teardown. It is still removed, because
      a setting is unique on (module, key): one left behind by a previous run makes
      the next run's upsert of the same key update a stranger's row instead of
      creating its own, and the test that asserts "this is newly created" fails
      somewhere it cannot explain.
    */
    await step(failures, () =>
      prisma.hRSetting.deleteMany({ where: { updatedById: { in: created.userIds } } }),
    );
    /*
      HR Phase 1. EmployeeDocument.uploadedById is Restrict and EmployeeHistory
      cascades from its employee, so an employee this run created pins its uploader
      until both go. Employees are reached by their own tracked ids rather than by
      name, because `Employee` has no single name column — firstName/lastName are
      separate, so the run marker lives on `workEmail` instead.
    */
    /*
      HR Phase 2 — attendance and leave. Deleted before EmployeeDocument so the
      whole HR graph unwinds in foreign-key order, and before the employee itself
      because every one of these cascades from it.

      Ledger and balance go together: a balance with no ledger would be a number
      nobody could explain, and a test that left one behind would make the next
      run's allocation idempotency check fail for a reason it could not see.
    */
    await step(failures, () =>
      prisma.attendanceBreak.deleteMany({
        where: { attendanceRecord: { employee: { workEmail: { startsWith: RUN_PREFIX } } } },
      }),
    );
    await step(failures, () =>
      prisma.attendanceCorrectionRequest.deleteMany({
        where: {
          OR: [
            { decidedById: { in: created.userIds } },
            { employee: { workEmail: { startsWith: RUN_PREFIX } } },
          ],
        },
      }),
    );
    await step(failures, () =>
      prisma.attendanceRecord.deleteMany({
        where: { employee: { workEmail: { startsWith: RUN_PREFIX } } },
      }),
    );
    await step(failures, () =>
      prisma.overtimeRecord.deleteMany({
        where: {
          OR: [
            { decidedById: { in: created.userIds } },
            { employee: { workEmail: { startsWith: RUN_PREFIX } } },
          ],
        },
      }),
    );
    await step(failures, () =>
      prisma.leaveLedgerEntry.deleteMany({
        where: {
          OR: [
            { performedById: { in: created.userIds } },
            { employee: { workEmail: { startsWith: RUN_PREFIX } } },
          ],
        },
      }),
    );
    await step(failures, () =>
      prisma.leaveRequest.deleteMany({
        where: {
          OR: [
            { decidedById: { in: created.userIds } },
            { employee: { workEmail: { startsWith: RUN_PREFIX } } },
          ],
        },
      }),
    );
    await step(failures, () =>
      prisma.leaveBalance.deleteMany({
        where: { employee: { workEmail: { startsWith: RUN_PREFIX } } },
      }),
    );
    /*
      Configuration carries the run marker in its CODE rather than a name, because
      Holiday has no code column — it is matched on its ZZT-prefixed name instead,
      the same convention Phase 1's departments use.
    */
    await step(failures, () =>
      prisma.leavePolicy.deleteMany({ where: { leaveType: { code: { startsWith: 'ZZT' } } } }),
    );
    await step(failures, () =>
      prisma.leaveType.deleteMany({ where: { code: { startsWith: 'ZZT' } } }),
    );
    await step(failures, () =>
      prisma.attendancePolicy.deleteMany({ where: { code: { startsWith: 'ZZT' } } }),
    );
    await step(failures, () =>
      prisma.holiday.deleteMany({ where: { name: { startsWith: 'ZZT' } } }),
    );
    /*
      HR Phase 3 — recruitment, onboarding and probation.

      Deleted before the Employee rows below, because every one of these tables points
      at Employee (as recruiter, hiring manager, interviewer, panel member, assignee,
      reviewer or the employee on probation) and several of those links are Restrict
      rather than SetNull.

      Ownership is traced through the two run-marked columns Phase 3 creates:
      `Candidate.email` and `JobRequisition.code`, both of which carry the run prefix
      in the tests. Cascades do most of the work — an Application's interviews,
      assessments, offers, checks and stage history all go with it — but each table is
      named explicitly anyway, because relying on a cascade means a schema change that
      loosens one silently starts leaving rows behind.

      ProbationRecord is matched on the employee rather than on a candidate, because a
      probation belongs to somebody already employed: by the time it exists the
      candidate record is history and no longer the way to find it.
    */
    await step(failures, () =>
      prisma.probationReview.deleteMany({
        where: { probationRecord: { employee: { workEmail: { startsWith: RUN_PREFIX } } } },
      }),
    );
    await step(failures, () =>
      prisma.probationRecord.deleteMany({
        where: { employee: { workEmail: { startsWith: RUN_PREFIX } } },
      }),
    );
    await step(failures, () =>
      prisma.onboardingTask.deleteMany({
        where: {
          onboardingRecord: {
            application: { candidate: { email: { startsWith: RUN_PREFIX } } },
          },
        },
      }),
    );
    await step(failures, () =>
      prisma.onboardingRecord.deleteMany({
        where: { application: { candidate: { email: { startsWith: RUN_PREFIX } } } },
      }),
    );
    await step(failures, () =>
      prisma.candidateDocument.deleteMany({
        where: { candidate: { email: { startsWith: RUN_PREFIX } } },
      }),
    );
    await step(failures, () =>
      prisma.backgroundCheck.deleteMany({
        where: { application: { candidate: { email: { startsWith: RUN_PREFIX } } } },
      }),
    );
    await step(failures, () =>
      prisma.offer.deleteMany({
        where: { application: { candidate: { email: { startsWith: RUN_PREFIX } } } },
      }),
    );
    await step(failures, () =>
      prisma.assessment.deleteMany({
        where: { application: { candidate: { email: { startsWith: RUN_PREFIX } } } },
      }),
    );
    await step(failures, () =>
      prisma.interviewFeedback.deleteMany({
        where: {
          interview: { application: { candidate: { email: { startsWith: RUN_PREFIX } } } },
        },
      }),
    );
    await step(failures, () =>
      prisma.interviewParticipant.deleteMany({
        where: {
          interview: { application: { candidate: { email: { startsWith: RUN_PREFIX } } } },
        },
      }),
    );
    await step(failures, () =>
      prisma.interview.deleteMany({
        where: { application: { candidate: { email: { startsWith: RUN_PREFIX } } } },
      }),
    );
    await step(failures, () =>
      prisma.applicationStageHistory.deleteMany({
        where: { application: { candidate: { email: { startsWith: RUN_PREFIX } } } },
      }),
    );
    await step(failures, () =>
      prisma.application.deleteMany({
        where: { candidate: { email: { startsWith: RUN_PREFIX } } },
      }),
    );
    /*
      Recruitment rows belonging to a *stale* run, not just this one.

      The two deletes below used to be scoped to this run alone — candidates by
      `RUN_PREFIX` email, requisitions by `created.userIds`. That paired a
      run-scoped delete with a user delete that is **stale-scoped**
      (`sweepTestOwnedRows` removes any `zz-test` user older than
      SWEEP_MIN_AGE_MS), so every run left recruitment rows pinning a previous
      run's users. Those users could then never be reclaimed:
      `JobRequisition.createdById`, `Candidate.createdById`, `Interview`,
      `Offer` and `OnboardingRecord.createdById` are all **Restrict**, and the
      sweep failed on `JobRequisition_createdById_fkey` — which `step()`
      re-throws, so a green suite still exited 1.

      Verified against pg_constraint before widening anything:

        - every FK *below* these tables is CASCADE — 5 of 5 with Candidate,
          Interview, Offer or OnboardingRecord as parent, 0 Restrict. So an
          owned candidate takes its applications, documents, interviews,
          feedback, participants, offers, onboarding records and tasks with it.
        - 5 Restrict FKs on User actually held rows: Candidate (24),
          JobRequisition (13), Interview (5), Offer (4), OnboardingRecord (1).
          Candidate is the biggest and is **not** reachable by cascading a
          requisition — it is Application's parent, not its child — which is why
          it needs its own ownership test and must go first.

      Ownership is the same two-branch rule the rest of this function uses:
      **mine at any age, another run's only once older than SWEEP_MIN_AGE_MS.**
      On top of that, a stale row is only reachable through a creator that is
      *both* named `zz-test…` *and* on `@test.invalid` — two independent gates a
      real account satisfies neither of. `@test.invalid` is reserved by RFC 2606
      and can never belong to a real candidate.
    */
    const recruitmentOwnedCreator = {
      AND: [
        { name: { startsWith: TEST_PREFIX } },
        { email: { endsWith: '@test.invalid' } },
      ],
      OR: [
        { name: { startsWith: RUN_PREFIX } },
        { createdAt: { lt: new Date(Date.now() - SWEEP_MIN_AGE_MS) } },
      ],
    };

    /*
      Candidates before requisitions, and now on their own ownership test.

      The outer `email endsWith '@test.invalid'` is what keeps real data
      unreachable whatever the OR admits: a real candidate cannot hold a reserved
      address. Within that, either this run's own email prefix, or a row whose
      creator is a reclaimable test user.
    */
    await step(failures, () =>
      prisma.candidate.deleteMany({
        where: {
          email: { endsWith: '@test.invalid' },
          OR: [
            { email: { startsWith: RUN_PREFIX } },
            { createdBy: recruitmentOwnedCreator },
          ],
        },
      }),
    );
    /*
      Requisitions after the candidate side, because an application reached
      through a candidate may sit on a requisition this run did not create.

      Matched on the creator, NOT on a code prefix. That was a real leak: an
      earlier version matched `code: startsWith 'ZZT'`, but the service allocates
      requisition codes itself as `JOB-<year>-<n>` — the ZZT prefix is on the
      *department* code and never reaches the requisition. Every test requisition
      survived teardown, and 142 had accumulated before a live count caught it.

      `createdBy` carries both identity gates and the staleness bound, so this
      cannot sweep a concurrent run's rows and cannot touch a real requisition —
      a real one was created by a real account.
    */
    await step(failures, () =>
      prisma.jobRequisition.deleteMany({
        where: { createdBy: recruitmentOwnedCreator },
      }),
    );
    /*
      The counters are keyed by series and period ("JOB-2026"), not by run — they are
      shared infrastructure rather than fixtures, and a test run bumping one is the
      intended behaviour. Deliberately NOT deleted: removing the row would reset the
      sequence and let a later run reissue a reference an earlier one already used,
      which is precisely what the counter exists to prevent.
    */
    await step(failures, () =>
      prisma.employeeDocument.deleteMany({
        where: {
          OR: [
            { uploadedById: { in: created.userIds } },
            { verifiedById: { in: created.userIds } },
            { employee: { workEmail: { startsWith: RUN_PREFIX } } },
          ],
        },
      }),
    );
    await step(failures, () =>
      prisma.employeeHistory.deleteMany({
        where: {
          OR: [
            { performedById: { in: created.userIds } },
            { employee: { workEmail: { startsWith: RUN_PREFIX } } },
          ],
        },
      }),
    );
    /*
      Phase 6 — payroll, before the employees it points at.

      Order matters here more than elsewhere in this function, because payroll
      deliberately uses `Restrict` on the two links that explain a historical
      figure: `PayrollItem.salaryAssignmentId` and `EmployeeSalary.structureId`.
      A salary that explains a payslip must not be deletable from under it, so
      the sweep unwinds the reverse of that dependency order — items, then
      assignments, then structures and components.

      `PayrollPeriod` rows are reached through their items rather than by name: a
      period carries no `zz-test` marker because its identity is `(year, month)`.
      The payroll suite instead takes a per-run base year far in the future, so a
      period it created cannot collide with a real one or with another run's, and
      emptied periods are removed here by that same year bound.
    */
    /*
      Ownership, applied to payroll exactly as the broad sweep applies it
      elsewhere in this file: **mine at any age, another run's only once stale.**

      The first version of this block scoped the item and adjustment deletes to
      `RUN_PREFIX` but scoped the *period* delete to the year band alone. That
      combination is what broke teardown:

        - items belonging to earlier runs were (correctly) not matched, so their
          periods never became empty;
        - the period delete nonetheless targeted those other runs' periods,
          because a year band is not an ownership test;
        - `prisma.user.deleteMany` then SetNull'd their `calculatedById` while
          `calculatedAt` stayed set, and
          `payroll_period_calculation_stamp_consistency` —
          `(calculatedAt IS NULL) = (calculatedById IS NULL)` — correctly
          rejected the row.

      The CHECK was right; the sweep was wrong. Observed concretely: 336 items
      across two earlier run markers survived while 56 periods in the band could
      not be removed.

      So every payroll delete below now carries the same two-branch ownership
      clause the rest of this function uses. A concurrent run's rows stay
      unreachable until they are older than SWEEP_MIN_AGE_MS, and this run's own
      debris still goes immediately.
    */
    const payrollOwnedEmployee = {
      workEmail: { startsWith: TEST_PREFIX },
      OR: [
        { workEmail: { startsWith: RUN_PREFIX } },
        { createdAt: { lt: new Date(Date.now() - SWEEP_MIN_AGE_MS) } },
      ],
    };

    await step(failures, () =>
      prisma.payrollItem.deleteMany({ where: { employee: payrollOwnedEmployee } }),
    );
    await step(failures, () =>
      prisma.payrollAdjustment.deleteMany({ where: { employee: payrollOwnedEmployee } }),
    );
    await step(failures, () =>
      prisma.employeeSalary.deleteMany({ where: { employee: payrollOwnedEmployee } }),
    );
    /*
      Periods last, and only ones that are **both** empty and owned.

      `items: { none: {} }` keeps a period belonging to a live concurrent run
      safe even if the year band overlaps, and `createdBy` carries the ownership
      test — a period created by this run's user, or by any test user old enough
      to be reclaimable. The year band stays as an outer bound so nothing outside
      the far-future test range is reachable from here at all.
    */
    await step(failures, () =>
      prisma.payrollPeriod.deleteMany({
        where: {
          year: { gte: 2100, lte: 2199 },
          items: { none: {} },
          OR: [
            { createdBy: { name: { startsWith: TEST_PREFIX } } },
            { createdById: null },
          ],
        },
      }),
    );
    await step(failures, () =>
      prisma.salaryStructure.deleteMany({
        where: { code: { startsWith: 'STD_' }, assignments: { none: {} } },
      }),
    );
    await step(failures, () =>
      prisma.salaryComponent.deleteMany({
        where: {
          OR: [
            { code: { startsWith: 'BASIC_' } },
            { code: { startsWith: 'HRA_' } },
            { code: { startsWith: 'SPECIAL_' } },
            { code: { startsWith: 'PF_EMP_' } },
            { code: { startsWith: 'PF_ER_' } },
            { code: { startsWith: 'BADPCT' } },
            { code: { startsWith: 'BADBASE' } },
            { code: { startsWith: 'BADRATE' } },
          ],
          structureComponents: { none: {} },
          salaryOverrides: { none: {} },
        },
      }),
    );

    /*
      Managers before reports, and heads before departments: Employee.managerId and
      Department.headId both point at Employee. Clearing the links first means the
      deletes below cannot fail on a self-referencing row.
    */
    await step(failures, () =>
      prisma.department.updateMany({
        where: { head: { workEmail: { startsWith: RUN_PREFIX } } },
        data: { headId: null },
      }),
    );
    await step(failures, () =>
      prisma.employee.updateMany({
        where: { manager: { workEmail: { startsWith: RUN_PREFIX } } },
        data: { managerId: null },
      }),
    );
    await step(failures, () =>
      prisma.employee.deleteMany({ where: { workEmail: { startsWith: RUN_PREFIX } } }),
    );
    await step(failures, () =>
      prisma.designation.deleteMany({ where: { code: { startsWith: 'ZZT' } } }),
    );
    await step(failures, () =>
      prisma.department.deleteMany({ where: { code: { startsWith: 'ZZT' } } }),
    );
  }
  // Purchase bills hold foreign keys to Vendor, Product and User, and their
  // allocations to SalesOrderItem — so they must go before any of those.
  if (created.purchaseBillIds.length) {
    await step(failures, () =>
      prisma.purchaseBill.deleteMany({ where: { id: { in: created.purchaseBillIds } } }),
    );
  }
  if (created.userIds.length) {
    await step(failures, () =>
      prisma.purchaseBill.deleteMany({ where: { createdById: { in: created.userIds } } }),
    );
  }
  // Before the legacy products: an RsProduct may hold the bridge to one, and
  // Product -> RsProduct.productId is SetNull rather than Cascade, so the
  // legacy row cannot go while the reference is still there.
  if (created.rsProductIds.length) {
    // Bill items reference these with SetNull, so any that survived the bills
    // above simply lose the mapping rather than blocking the delete. Variants
    // and images cascade from the product.
    await step(failures, () =>
      prisma.rsProduct.deleteMany({ where: { id: { in: created.rsProductIds } } }),
    );
  }
  if (created.customerIds.length) {
    // Lead -> Customer is Restrict, so any lead raised against these customers
    // has to go first — see the note in sweepTestOwnedRows.
    await step(failures, () =>
      prisma.lead.deleteMany({ where: { customerId: { in: created.customerIds } } }),
    );
    await step(failures, () =>
      prisma.customer.deleteMany({ where: { id: { in: created.customerIds } } }),
    );
  }
  if (created.userIds.length) {
    // And any raised BY a fixture user against a customer this run did not make.
    await step(failures, () =>
      prisma.lead.deleteMany({ where: { createdById: { in: created.userIds } } }),
    );
    // Restrict on both, so these must go before the users do.
    await step(failures, () =>
      prisma.lead.deleteMany({ where: { associateId: { in: created.userIds } } }),
    );
    await step(failures, () =>
      prisma.lead.deleteMany({ where: { allocatedById: { in: created.userIds } } }),
    );
  }
  if (created.vendorIds.length) {
    // Vendor -> VendorResponse is Restrict, so a vendor still referenced by any
    // response cannot be removed. Clear those responses first; they belong to
    // enquiries this suite created, which are already gone or going.
    await step(failures, () =>
      prisma.vendorResponse.deleteMany({ where: { vendorId: { in: created.vendorIds } } }),
    );
    await step(failures, () =>
      prisma.vendor.deleteMany({ where: { id: { in: created.vendorIds } } }),
    );
  }
  if (created.userIds.length) {
    await step(failures, () => prisma.user.deleteMany({ where: { id: { in: created.userIds } } }));
  }

  // Catches whatever the id lists never learned about — a row that committed
  // while its create call was failing, or one the API made for a lost response.
  await sweepTestOwnedRows(failures);

  /*
    Last, once the requests themselves are gone: their notices outlive them,
    because `Notification.entityId` carries no foreign key. Deleting the test
    users above already removed any notice addressed TO a fixture user; this
    removes the ones addressed to real people about a test request — which is
    the whole point, since partial-dispatch notices go to everyone holding
    PROCUREMENT:ASSIGN.
  */
  await deletePartialDispatchNotifications(failures);

  created.enquiryIds.length = 0;
  created.salesOrderIds.length = 0;
  created.userIds.length = 0;
  created.customerIds.length = 0;
  created.vendorIds.length = 0;
  created.rsProductIds.length = 0;
  created.purchaseBillIds.length = 0;
  /*
    Deliberately NOT cleared. `residualTestRows` runs after this and asserts
    these notices are gone; clearing the list would leave it nothing to look at,
    making a check that can never fail. The ids are a few strings per suite and
    the process ends with it.
  */

  // Teardown attempted everything; now report. Surfacing the first failure keeps
  // a broken cleanup as visible as it was before, while the suites that follow
  // start from a database this one actually finished tidying.
  if (failures.length) {
    throw failures[0];
  }
}

/**
 * Guards against fixtures escaping — asserted at the end of each suite.
 *
 * ### Why this counts only this run's rows
 *
 * It used to count every `zz-test` row in the database. That made the check
 * strictly stronger and, in practice, wrong: it holds each suite responsible for
 * rows it never created. A single orphan the sweep could not reclaim therefore
 * failed the `afterAll` of every suite that ran afterwards, so one stray
 * customer became dozens of file failures with nothing wrong in any of them.
 * The docblock on `step()` describes the same cascade from a transient Neon drop.
 *
 * Counting by run marker keeps the check doing its actual job — proving *this*
 * suite tidied up after itself — while making it immune to debris it has no way
 * to clean. Another run's leftovers are that run's business, and the sweep
 * reclaims them on age once their owner has certainly ended.
 *
 * This is deliberately not a weakening. A fixture that escapes this run is still
 * caught, at any age, including rows the API created whose ids were never
 * tracked — those carry the marker too, which is precisely what makes counting
 * by marker sufficient.
 */
export async function residualTestRows(): Promise<number> {
  /*
    Partial-dispatch notices are checked separately, and only against the ids
    this run tracked. There is no prefix to search on — a notice carries an
    entity id, not a name — so a global count would sweep in real notices about
    real requests and fail a suite for somebody else's data.
  */
  const strandedNotices = created.partialDispatchRequestIds.length
    ? await prisma.notification.count({
        where: {
          entityType: 'PartialDispatchRequest',
          entityId: { in: created.partialDispatchRequestIds },
        },
      })
    : 0;

  /** This run's rows only — see the note above. */
  const mine = { startsWith: `${RUN_PREFIX}-` };

  const [
    users,
    customers,
    vendors,
    salesOrders,
    rsProducts,
    employees,
    candidates,
    requisitions,
  ] = await Promise.all([
      prisma.user.count({ where: { name: mine } }),
      prisma.customer.count({ where: { name: mine } }),
      prisma.vendor.count({ where: { name: mine } }),
      // The product name lives on the line now, so an escaped order is found
      // through the lines it owns.
      prisma.salesOrder.count({ where: { items: { some: { productName: mine } } } }),
      // The real catalogue holds hundreds of rows, so only this run's count — an
      // escaped fixture must not be hidden among them.
      prisma.rsProduct.count({ where: { title: mine } }),
      /*
        HR. Both are matched on their run-marked email rather than on a name, because
        that is the column the HR suites put the marker in — an employee's `workEmail`
        and a candidate's `email`.

        Counted by marker and never by a broad prefix, for the reason the whole
        ownership mechanism exists: an unmarked or another run's row must not fail this
        suite. These two are the roots of the Phase 1–3 HR graph, so an escaped
        employee or candidate is what would strand everything hanging off it.
      */
      prisma.employee.count({ where: { workEmail: mine } }),
      prisma.candidate.count({ where: { email: mine } }),
      /*
        Requisitions, traced through the creating user rather than a name or code.

        Added after a real leak: teardown matched a `ZZT` code prefix the service never
        writes — it allocates `JOB-<year>-<n>` itself — so every test requisition
        survived, and the only reason it was caught was a manual row count against the
        live database. This closes that gap: had it been here, the first run would have
        failed its own teardown assertion instead of quietly accumulating 142 rows.

        `created.userIds` is this run's users only, so another run's rows cannot fail
        this suite.
      */
      created.userIds.length
        ? prisma.jobRequisition.count({ where: { createdById: { in: created.userIds } } })
        : Promise.resolve(0),
    ]);
  return (
    users +
    customers +
    vendors +
    salesOrders +
    rsProducts +
    employees +
    candidates +
    requisitions +
    strandedNotices
  );
}
