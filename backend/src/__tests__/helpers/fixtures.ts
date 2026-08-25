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

export const TEST_PREFIX = 'zz-test';

const created = {
  enquiryIds: [] as string[],
  userIds: [] as string[],
  customerIds: [] as string[],
  vendorIds: [] as string[],
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

export async function makeCustomer(type: CustomerType = 'RETAIL'): Promise<{ id: string }> {
  const customer = await prisma.customer.create({
    data: { name: `${TEST_PREFIX}-customer-${short()}`, type },
    select: { id: true },
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

export async function cleanup(): Promise<void> {
  if (created.enquiryIds.length) {
    await prisma.productEnquiry.deleteMany({ where: { id: { in: created.enquiryIds } } });
  }
  // Anything the API created for these users that we did not track by id.
  if (created.userIds.length) {
    await prisma.productEnquiry.deleteMany({
      where: { OR: [{ createdById: { in: created.userIds } }, { assignedToId: { in: created.userIds } }] },
    });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: created.userIds } } });
    await prisma.userModulePermission.deleteMany({ where: { userId: { in: created.userIds } } });
  }
  if (created.customerIds.length) {
    await prisma.customer.deleteMany({ where: { id: { in: created.customerIds } } });
  }
  if (created.vendorIds.length) {
    await prisma.vendor.deleteMany({ where: { id: { in: created.vendorIds } } });
  }
  if (created.userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  }

  created.enquiryIds.length = 0;
  created.userIds.length = 0;
  created.customerIds.length = 0;
  created.vendorIds.length = 0;
}

/** Guards against fixtures escaping — asserted at the end of each suite. */
export async function residualTestRows(): Promise<number> {
  const [users, customers, vendors] = await Promise.all([
    prisma.user.count({ where: { name: { startsWith: TEST_PREFIX } } }),
    prisma.customer.count({ where: { name: { startsWith: TEST_PREFIX } } }),
    prisma.vendor.count({ where: { name: { startsWith: TEST_PREFIX } } }),
  ]);
  return users + customers + vendors;
}
