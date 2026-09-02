/**
 * §6 — user creation for v1.
 *
 * There is no public signup. Employees are created here, by hand, with bcrypt
 * hashes. The script is idempotent: it upserts by employeeId, so re-running it
 * updates the existing rows rather than creating duplicates.
 *
 * Passwords come from the environment, never from literals in this file —
 * the file is committed, the environment is not.
 *
 *   npm run db:seed
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import bcrypt from 'bcrypt';
import { PrismaClient, type Role } from '@prisma/client';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../.env') });

const prisma = new PrismaClient();

/** §53 — cost 12: comfortably above the 2026 baseline, still fast enough to log in. */
const BCRYPT_ROUNDS = 12;

type SeedUser = {
  employeeId: string;
  name: string;
  email: string;
  mobile: string;
  role: Role;
  passwordEnvVar: string;
};

/**
 * §1 — the three approved administrator accounts.
 *
 * These are the only ADMIN accounts the system has, and the only way one is
 * ever created: the user-management API has no role field, so an administrator
 * can only come from this list. Adding a fourth means editing this file and
 * supplying its password in the environment.
 *
 * Existing accounts are matched by email rather than employeeId, because the
 * email is the identity someone signs in with and is what §1 specifies.
 */
const USERS: SeedUser[] = [
  {
    employeeId: 'RS001',
    name: 'Kaartik',
    email: 'kaartikmishra074@gmail.com',
    mobile: '',
    role: 'ADMIN',
    passwordEnvVar: 'SEED_ADMIN_1_PASSWORD',
  },
  {
    employeeId: 'RS002',
    name: 'RoyalStuffs Tech',
    email: 'techroyalstuffs@gmail.com',
    mobile: '',
    role: 'ADMIN',
    passwordEnvVar: 'SEED_ADMIN_2_PASSWORD',
  },
  {
    employeeId: 'RS003',
    name: 'Ajay',
    email: 'ajaygpt07@gmail.com',
    mobile: '',
    role: 'ADMIN',
    passwordEnvVar: 'SEED_ADMIN_3_PASSWORD',
  },
];

/**
 * §59 — development fixtures only, so the UI has real rows to render instead of
 * hardcoded arrays in React. Never seeded in production.
 */
const DEV_VENDORS = [
  { name: 'ABC Handicrafts', contactPerson: 'Rakesh Sharma', city: 'Moradabad' },
  { name: 'Shree Brass Works', contactPerson: 'Meera Joshi', city: 'Jaipur' },
  { name: 'Copperline Exports', contactPerson: 'Imran Qureshi', city: 'Moradabad' },
  { name: 'Heritage Metal Crafts', contactPerson: 'Sunita Rao', city: 'Jodhpur' },
];

const DEV_CUSTOMERS = [
  { name: 'ABC Pvt Ltd', type: 'CORPORATE_GIFTING' as const, city: 'Delhi' },
  { name: 'Verma Wedding Planners', type: 'WEDDING_GIFTING' as const, city: 'Lucknow' },
  { name: 'Nandini Retail', type: 'RETAIL' as const, city: 'Pune' },
  { name: 'GiftHub Bulk Orders', type: 'BULK' as const, city: 'Ahmedabad' },
];

/**
 * §1/§13 — creates or repairs the three administrator accounts, and nothing
 * else. Re-running is safe: matching is by email, so a second run updates the
 * same three rows rather than adding more.
 *
 * §14 — existing users are never touched. Earlier revisions of this file seeded
 * RS001–RS003 as Kaartik/Devansh/Aparna, so those employee ids are already in
 * use by real accounts with different emails. Upserting on employeeId would
 * therefore rewrite a colleague's row into an administrator. Matching on email
 * and allocating a fresh employeeId when the preferred one is taken is what
 * keeps that from happening.
 */
async function seedUsers(): Promise<void> {
  for (const user of USERS) {
    const password = process.env[user.passwordEnvVar];

    if (!password) {
      throw new Error(
        `Missing ${user.passwordEnvVar}. Set it in .env before seeding — ` +
          'passwords are never hardcoded in this file.',
      );
    }

    if (password.length < 8) {
      throw new Error(`${user.passwordEnvVar} must be at least 8 characters.`);
    }

    // A '$' survives dotenv but is expanded by tools that do variable
    // substitution, which silently seeds a different password from the one in
    // .env. Refuse rather than create an account nobody can sign into.
    if (password.includes('$')) {
      throw new Error(
        `${user.passwordEnvVar} contains '$', which some env loaders expand. ` +
          'Use a password without it.',
      );
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const existing = await prisma.user.findUnique({
      where: { email: user.email },
      select: { id: true, employeeId: true },
    });

    if (existing) {
      // Re-running rotates the password, restores access and guarantees the
      // ADMIN role — but keeps the employeeId the account already had, which
      // other rows reference.
      await prisma.user.update({
        where: { id: existing.id },
        data: { name: user.name, passwordHash, role: user.role, isActive: true },
      });
      console.log(`  user   ${existing.employeeId}  ${user.name} (${user.role}) — updated`);
      continue;
    }

    // The preferred employeeId may belong to a pre-existing colleague; if so,
    // take the next free RS number rather than colliding or overwriting them.
    const employeeId = (await prisma.user.findUnique({
      where: { employeeId: user.employeeId },
      select: { id: true },
    }))
      ? await nextEmployeeId()
      : user.employeeId;

    await prisma.user.create({
      data: {
        employeeId,
        name: user.name,
        email: user.email,
        mobile: user.mobile || null,
        passwordHash,
        role: user.role,
      },
    });

    console.log(`  user   ${employeeId}  ${user.name} (${user.role}) — created`);
  }

  // §13 — administrators get every module from the role defaults, so they need
  // no permission rows at all. A leftover row would be read as a restriction.
  const cleared = await prisma.userModulePermission.deleteMany({
    where: { user: { email: { in: USERS.map((u) => u.email) } } },
  });
  if (cleared.count > 0) {
    console.log(`  perms  cleared ${cleared.count} override row(s) from administrators`);
  }
}

/** The next free RS-prefixed employee id. */
async function nextEmployeeId(): Promise<string> {
  const rows = await prisma.user.findMany({
    where: { employeeId: { startsWith: 'RS' } },
    select: { employeeId: true },
  });

  const highest = rows.reduce((max, row) => {
    const digits = /^RS(\d+)$/.exec(row.employeeId);
    return digits ? Math.max(max, Number(digits[1])) : max;
  }, 0);

  return `RS${String(highest + 1).padStart(3, '0')}`;
}

async function seedDevelopmentFixtures(): Promise<void> {
  for (const vendor of DEV_VENDORS) {
    await prisma.vendor.upsert({
      where: { name: vendor.name },
      update: {},
      create: vendor,
    });
    console.log(`  vendor ${vendor.name}`);
  }

  for (const customer of DEV_CUSTOMERS) {
    const existing = await prisma.customer.findFirst({
      where: { name: customer.name },
      select: { id: true },
    });

    if (!existing) {
      await prisma.customer.create({
        data: { name: customer.name, type: customer.type },
      });
    }
    console.log(`  cust.  ${customer.name}`);
  }
}

async function main(): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';

  console.log(`\nSeeding RoyalStuffs CRM (${isProduction ? 'production' : 'development'})\n`);

  await seedUsers();

  if (!isProduction) {
    await seedDevelopmentFixtures();
  }

  console.log('\nDone.\n');
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
