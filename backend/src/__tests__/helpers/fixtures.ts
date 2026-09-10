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
import { normalizeProductName } from '@rs/shared';
import { prisma } from '../../config/database.js';

export const TEST_PREFIX = 'zz-test';

const created = {
  enquiryIds: [] as string[],
  salesOrderIds: [] as string[],
  userIds: [] as string[],
  customerIds: [] as string[],
  vendorIds: [] as string[],
  productIds: [] as string[],
  purchaseBillIds: [] as string[],
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
      name: `${TEST_PREFIX}-${role.toLowerCase()}`,
      email: `${TEST_PREFIX}-${suffix}@test.invalid`,
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
  contact: { phone?: string; email?: string } = {},
): Promise<{ id: string; name: string; phone: string | null; email: string | null }> {
  const customer = await prisma.customer.create({
    data: {
      name: `${TEST_PREFIX}-customer-${short()}`,
      type,
      phone: contact.phone ?? null,
      email: contact.email ?? null,
    },
    select: { id: true, name: true, phone: true, email: true },
  });
  created.customerIds.push(customer.id);
  return customer;
}

export async function makeVendor(isActive = true): Promise<{ id: string; name: string }> {
  const vendor = await prisma.vendor.create({
    data: { name: `${TEST_PREFIX}-vendor-${short()}`, isActive },
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

/** Registers a product created through the API so cleanup removes it. */
export function trackProduct(id: string): string {
  created.productIds.push(id);
  return id;
}

/** Registers a purchase bill created through the API so cleanup removes it. */
export function trackPurchaseBill(id: string): string {
  created.purchaseBillIds.push(id);
  return id;
}

/**
 * A catalogue product with an opening stock level.
 *
 * Named with the shared prefix so an escaped row is obvious, and always given
 * an InventoryItem so nothing downstream has to cope with a product that has
 * no stock record.
 */
export async function makeProduct(onHand = 0): Promise<{ id: string; name: string }> {
  const name = `${TEST_PREFIX}-product-${short()}`;
  const product = await prisma.product.create({
    data: {
      name,
      // Folded the same way the API folds it, so a fixture can collide with a
      // catalogued product exactly as a real one would.
      normalizedName: normalizeProductName(name),
      inventory: { create: { onHand } },
    },
    select: { id: true, name: true },
  });
  created.productIds.push(product.id);
  return product;
}

/** Sets stock directly, for arranging a shortage without going through the API. */
export async function setInventory(productId: string, onHand: number): Promise<void> {
  await prisma.inventoryItem.upsert({
    where: { productId },
    update: { onHand },
    create: { productId, onHand },
  });
}

/**
 * Links a sales order line to a catalogue product.
 *
 * Raw SQL on purpose: `sales_order_money_guard` is a deferred constraint
 * trigger that re-checks the parent order's payment invariants on any write to
 * a line. Going through Prisma would drag unrelated columns into the statement
 * on orders the fixtures deliberately leave part-paid.
 */
export async function linkOrderLineToProduct(
  salesOrderItemId: string,
  productId: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SalesOrderItem" SET "productId" = ${productId} WHERE "id" = ${salesOrderItemId}`;
}

/** A purchase bill payload with one line, as the create endpoint expects it. */
export function purchaseBillPayload(
  vendorId: string,
  productId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    billNumber: `${TEST_PREFIX}-BILL-${short()}`.toUpperCase(),
    vendorId,
    billType: 'CREDIT',
    billDate: new Date().toISOString(),
    items: [{ productName: `${TEST_PREFIX}-bill-line`, productId, orderedQty: 10, receivedQty: 10, rate: '100.00' }],
    ...overrides,
  };
}

/**
 * A unique order id per test run.
 *
 * SalesOrder.orderId is unique across the whole table, so a fixed literal would
 * collide the second time a suite runs against the same database.
 */
export const salesOrderId = (): string => `${TEST_PREFIX}-SO-${short()}`.toUpperCase();

/** One product line, as the create endpoint expects it. */
export function salesItemPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    productName: `${TEST_PREFIX}-product`,
    quantity: 12,
    price: '1250.50',
    ...overrides,
  };
}

/** An ADD change-request payload. */
export function addRequestPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'ADD', productName: `${TEST_PREFIX}-added`, quantity: 2, price: '50.00', ...overrides };
}

/** An EDIT change-request payload against a given line. */
export function editRequestPayload(
  itemId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'EDIT', itemId,
    productName: `${TEST_PREFIX}-edited`, quantity: 3, price: '100.00',
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
      name: `${TEST_PREFIX}-product-${i + 1}`,
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
 * This is safe only because `vitest.config.ts` sets `fileParallelism: false` —
 * suites share one database and run one at a time, so no other suite's fixtures
 * can be in flight while this runs. Enabling parallelism would break that.
 */
async function sweepTestOwnedRows(failures: unknown[]): Promise<void> {
  const owned = { name: { startsWith: TEST_PREFIX } };
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
  // Items, change requests and allocations cascade from the order.
  await step(failures, () =>
    prisma.salesOrder.deleteMany({
      where: {
        OR: [
          { customer: owned },
          { createdBy: owned },
          { items: { some: { productName: ownedName } } },
        ],
      },
    }),
  );
  // Bill items and their allocations cascade from the bill.
  await step(failures, () =>
    prisma.purchaseBill.deleteMany({ where: { OR: [{ vendor: owned }, { createdBy: owned }] } }),
  );
  await step(failures, () => prisma.purchaseBillItem.deleteMany({ where: { product: owned } }));
  await step(failures, () => prisma.inventoryItem.deleteMany({ where: { product: owned } }));
  await step(failures, () => prisma.product.deleteMany({ where: owned }));
  await step(failures, () => prisma.auditLog.deleteMany({ where: { actor: owned } }));
  await step(failures, () => prisma.userModulePermission.deleteMany({ where: { user: owned } }));
  // MediaAsset -> uploadedBy is Restrict, so an asset a test user uploaded would
  // otherwise pin that user in place. Every image reference to it is SetNull.
  await step(failures, () => prisma.mediaAsset.deleteMany({ where: { uploadedBy: owned } }));
  await step(failures, () => prisma.customer.deleteMany({ where: owned }));
  await step(failures, () => prisma.vendor.deleteMany({ where: owned }));
  await step(failures, () => prisma.user.deleteMany({ where: owned }));
}

export async function cleanup(): Promise<void> {
  const failures: unknown[] = [];

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
  if (created.productIds.length) {
    // Allocations cascade from their bill item; anything still pointing at
    // these products is removed with the bills above.
    await step(failures, () =>
      prisma.purchaseBillItem.deleteMany({ where: { productId: { in: created.productIds } } }),
    );
    await step(failures, () =>
      prisma.inventoryItem.deleteMany({ where: { productId: { in: created.productIds } } }),
    );
    await step(failures, () =>
      prisma.product.deleteMany({ where: { id: { in: created.productIds } } }),
    );
  }
  if (created.customerIds.length) {
    await step(failures, () =>
      prisma.customer.deleteMany({ where: { id: { in: created.customerIds } } }),
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

  created.enquiryIds.length = 0;
  created.salesOrderIds.length = 0;
  created.userIds.length = 0;
  created.customerIds.length = 0;
  created.vendorIds.length = 0;
  created.productIds.length = 0;
  created.purchaseBillIds.length = 0;

  // Teardown attempted everything; now report. Surfacing the first failure keeps
  // a broken cleanup as visible as it was before, while the suites that follow
  // start from a database this one actually finished tidying.
  if (failures.length) {
    throw failures[0];
  }
}

/** Guards against fixtures escaping — asserted at the end of each suite. */
export async function residualTestRows(): Promise<number> {
  const [users, customers, vendors, salesOrders, products] = await Promise.all([
    prisma.user.count({ where: { name: { startsWith: TEST_PREFIX } } }),
    prisma.customer.count({ where: { name: { startsWith: TEST_PREFIX } } }),
    prisma.vendor.count({ where: { name: { startsWith: TEST_PREFIX } } }),
    // The product name lives on the line now, so an escaped order is found
    // through the lines it owns.
    prisma.salesOrder.count({
      where: { items: { some: { productName: { startsWith: TEST_PREFIX } } } },
    }),
    prisma.product.count({ where: { name: { startsWith: TEST_PREFIX } } }),
  ]);
  return users + customers + vendors + salesOrders + products;
}
