/**
 * One-off backfill: give every existing order and enquiry line a catalogue entry.
 *
 * Products were free text until Purchase & Procurement arrived, so this walks
 * the rows that already exist and creates one Product per *exact* name. Exact,
 * not normalised: "brass lota" and "Brass lota 1L" are plausibly the same item
 * and plausibly two sizes, and merging them would silently pool their stock.
 * A wrong merge is unrecoverable; two products that later turn out to be one
 * is a five-second fix. The audit that preceded this found no two names
 * differing only by case or whitespace, so nothing is being split by accident
 * either.
 *
 * Idempotent: re-running links anything still unlinked and creates nothing
 * twice. Existing Sales and Product Enquiry rows are never otherwise modified.
 *
 *   npx tsx database/prisma/backfill-products.ts [--apply]
 *
 * Without --apply it prints what it would do and writes nothing.
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../.env') });

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Test-fixture rows: catalogued for completeness, but never sellable. */
const isFixture = (name: string): boolean => /^zz-/i.test(name.trim());

async function main(): Promise<void> {
  const [salesItems, enquiryProducts] = await Promise.all([
    prisma.salesOrderItem.findMany({ select: { id: true, productName: true, productId: true } }),
    prisma.enquiryProduct.findMany({ select: { id: true, name: true, productId: true } }),
  ]);

  const names = new Set<string>();
  for (const s of salesItems) names.add(s.productName);
  for (const e of enquiryProducts) names.add(e.name);

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${names.size} distinct product names\n`);

  const blocked: string[] = [];
  let created = 0;
  let linkedSales = 0;
  let linkedEnquiry = 0;

  for (const name of [...names].sort()) {
    const fixture = isFixture(name);

    let product = await prisma.product.findUnique({ where: { name }, select: { id: true } });
    if (!product) {
      if (APPLY) {
        product = await prisma.product.create({
          // Fixtures are catalogued but inactive, so they never appear in a
          // picker. Real products start active with zero stock — a count
          // nobody has taken yet is zero, not a guess.
          data: { name, isActive: !fixture, inventory: { create: { onHand: 0 } } },
          select: { id: true },
        });
      }
      created += 1;
      console.log(`  create  "${name}"${fixture ? '  (inactive: test fixture)' : ''}`);
    }

    if (!APPLY) continue;

    // Raw UPDATE, and skipping orders that cannot be touched at all.
    //
    // `sales_order_money_guard` is a deferred constraint trigger that fires on
    // ANY insert, update or delete of a SalesOrderItem and re-evaluates the
    // parent order's payment invariants at commit. One historical order
    // (rsm002 — closed while part-paid) predates that rule and can never
    // satisfy it, so *any* write touching its lines aborts, however unrelated
    // the column.
    //
    // Those lines are therefore left unlinked rather than reached for by
    // disabling the trigger or rewriting someone's payment history to suit a
    // catalogue migration. productId is nullable precisely so a line without a
    // catalogue entry keeps working; procurement simply cannot allocate
    // against that one legacy order until its payment record is corrected by
    // hand. Everything else links normally.
    let s = 0;
    try {
      s = await prisma.$executeRaw`
        UPDATE "SalesOrderItem" SET "productId" = ${product!.id}
        WHERE "productName" = ${name} AND "productId" IS NULL`;
    } catch (error) {
      // Only the money guard is tolerated here; anything else is a real fault.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('sales_closed_fully_paid') && !message.includes('sales_paid_within_total')) {
        throw error;
      }
      blocked.push(name);
      console.log(`  skip    "${name}" — parent order predates the payment rule`);
    }
    const e = await prisma.$executeRaw`
      UPDATE "EnquiryProduct" SET "productId" = ${product!.id}
      WHERE "name" = ${name} AND "productId" IS NULL`;
    linkedSales += s;
    linkedEnquiry += e;
  }

  console.log(
    `\n${APPLY ? 'Created' : 'Would create'} ${created} products` +
      (APPLY ? `; linked ${linkedSales} sales lines and ${linkedEnquiry} enquiry lines.` : '.'),
  );
  if (!APPLY) console.log('Re-run with --apply to write.\n');

  if (blocked.length) {
    console.log(
      `\n${blocked.length} name(s) left unlinked on at least one order whose ` +
        'payment record predates the settlement rule:\n  ' + blocked.join('\n  ') +
        '\nThese lines keep working; productId is nullable. Correct the order\'s ' +
        'paidAmount by hand and re-run to link them.',
    );
  }

  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error('Backfill failed:', error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
