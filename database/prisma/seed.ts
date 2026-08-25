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

const USERS: SeedUser[] = [
  {
    employeeId: 'RS001',
    name: 'Kaartik',
    email: 'kaartik@royalstuffs.com',
    mobile: '',
    role: 'ADMIN',
    passwordEnvVar: 'SEED_KAARTIK_PASSWORD',
  },
  {
    employeeId: 'RS002',
    name: 'Devansh',
    email: 'devansh@royalstuffs.com',
    mobile: '',
    role: 'USER',
    passwordEnvVar: 'SEED_DEVANSH_PASSWORD',
  },
  {
    employeeId: 'RS003',
    name: 'Aparna',
    email: 'aparna@royalstuffs.com',
    mobile: '',
    role: 'USER',
    passwordEnvVar: 'SEED_APARNA_PASSWORD',
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

    await prisma.user.upsert({
      where: { employeeId: user.employeeId },
      // Re-running the seed rotates the password and restores access, but never
      // silently changes someone's role.
      update: {
        name: user.name,
        email: user.email,
        passwordHash,
        isActive: true,
      },
      create: {
        employeeId: user.employeeId,
        name: user.name,
        email: user.email,
        mobile: user.mobile || null,
        passwordHash,
        role: user.role,
      },
    });

    console.log(`  user   ${user.employeeId}  ${user.name} (${user.role})`);
  }
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
