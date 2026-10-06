/**
 * All Prisma access for Create Lead / Deal.
 *
 * Two things this file deliberately never does:
 *
 *   - **It never writes a Customer.** A lead points at the existing master by
 *     foreign key. Creating one goes through the Customer module's own service,
 *     so there is exactly one place that decides what a customer is.
 *
 *   - **It never matches a phone in SQL.** Postgres has no digits-only
 *     comparison that can use an index here, and the stored values are written
 *     a dozen different ways. Matching happens in `lead.service.ts` through the
 *     shared `normalizePhone`, so the frontend, the backend and the tests all
 *     agree on what "the same number" means.
 *
 * Selects are explicit rather than bare `include`, so nothing can accidentally
 * return a password hash.
 */

import { Prisma } from '@rs/database';
import type { LeadChannel } from '@rs/shared';
import { prisma } from '../../config/database.js';

const userRef = { id: true, name: true, employeeId: true, role: true } as const;

const customerView = {
  id: true,
  name: true,
  companyName: true,
  type: true,
  phone: true,
  email: true,
  address: true,
  state: true,
  country: true,
  gstNumber: true,
  createdAt: true,
} as const;

/** One expected action, with everything promptness and the timeline need. */
export const leadActivitySelect = {
  id: true,
  kind: true,
  dueAt: true,
  completedAt: true,
  note: true,
  createdAt: true,
  performedBy: { select: userRef },
} satisfies Prisma.LeadActivitySelect;

export type LeadActivityRecord = Prisma.LeadActivityGetPayload<{
  select: typeof leadActivitySelect;
}>;

/**
 * One requirement line, with everything the UI draws already attached.
 *
 * The two relations are the point. A requirement names a photo and a catalogue
 * product, and a page showing five of them would otherwise issue ten follow-up
 * queries — so both travel inline, selected down to the few display fields the
 * contract exposes rather than `include`d whole. The catalogue's cost price, its
 * Shopify ids and its stock are nobody's business on a lead detail page.
 *
 * `variants` takes exactly one row, ordered by position: SKU lives on the
 * variant, a product has many, and the first is the one a picker shows. `take: 1`
 * rather than all of them because the alternative is pulling a hundred variants
 * to read one string from each product.
 */
export const leadRequirementSelect = {
  id: true,
  lineNo: true,
  productName: true,
  matchKind: true,
  quantity: true,
  weightValue: true,
  weightUnit: true,
  weightInGrams: true,
  lengthValue: true,
  widthValue: true,
  heightValue: true,
  dimensionUnit: true,
  productValue: true,
  createdAt: true,
  updatedAt: true,
  image: { select: { id: true, secureUrl: true, publicId: true } },
  rsProduct: {
    select: {
      id: true,
      title: true,
      variants: { select: { sku: true }, orderBy: { position: 'asc' as const }, take: 1 },
      images: { select: { url: true }, orderBy: { position: 'asc' as const }, take: 1 },
    },
  },
} satisfies Prisma.LeadProductRequirementSelect;

export type LeadRequirementRecord = Prisma.LeadProductRequirementGetPayload<{
  select: typeof leadRequirementSelect;
}>;

/**
 * Exactly what Sales' `toMoney` consumes, and nothing more.
 *
 * Shared by the detail read and the analytics list so the two cannot drift: both
 * derive Order Value through the same function, which needs these lines, charges
 * and the customer's region to decide the GST treatment. There is no stored
 * total to read instead — deliberately, so a charge changing on the order cannot
 * leave a stale figure on the lead.
 */
const orderMoneySelect = {
  select: {
    id: true,
    paidAmount: true,
    paymentMethod: true,
    status: true,
    customer: { select: { state: true, country: true } },
    refunds: { select: { amount: true, status: true } },
    items: {
      select: {
        quantity: true,
        cancelledQty: true,
        price: true,
        gstRate: true,
        gstMode: true,
        status: true,
      },
    },
    charges: { select: { type: true, amount: true } },
  },
} satisfies Prisma.Lead$salesOrderArgs;

export const leadSelect = {
  id: true,
  leadSource: true,
  leadSourceOther: true,
  sourceDetails: true,
  sourceAt: true,
  requirementType: true,
  channel: true,
  channelOther: true,
  dealStatus: true,
  associateId: true,
  allocatedById: true,
  salesOrderId: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: customerView },
  createdBy: { select: userRef },
  associate: { select: userRef },
  allocatedBy: { select: userRef },
  /*
    Included on the detail read, in dueAt order, because promptness is derived
    from them and a detail page shows the timeline anyway — one query rather
    than a second round trip for data the same request already needs.
  */
  activities: { select: leadActivitySelect, orderBy: { dueAt: 'asc' as const } },
  /*
    Complete the Ideal, on the same read. The requirement's photo and its matched
    catalogue product come with it — see `leadRequirementSelect` — so a lead
    showing five requirements is still one query rather than eleven.
  */
  requirements: { select: leadRequirementSelect, orderBy: { lineNo: 'asc' as const } },
  /*
    The linked order's money, so the detail page can report Order Value the same
    way the board does. Null for a lead that never became an order, which is
    every lead until a conversion flow exists — and null is the honest answer
    there, not zero.
  */
  salesOrder: orderMoneySelect,
} satisfies Prisma.LeadSelect;

export type LeadRecord = Prisma.LeadGetPayload<{ select: typeof leadSelect }>;

export type CustomerRecord = Prisma.CustomerGetPayload<{ select: typeof customerView }>;

export function findLead(id: string): Promise<LeadRecord | null> {
  return prisma.lead.findUnique({ where: { id }, select: leadSelect });
}

export function createLead(
  tx: Prisma.TransactionClient,
  data: {
    leadSource: LeadRecord['leadSource'];
    leadSourceOther: string | null;
    sourceDetails: string | null;
    sourceAt: Date;
    requirementType: LeadRecord['requirementType'];
    customerId: string;
    channel: LeadChannel;
    channelOther: string | null;
    createdById: string;
  },
): Promise<{ id: string }> {
  return tx.lead.create({ data, select: { id: true } });
}

/**
 * Every customer carrying a phone number at all.
 *
 * Read in full and filtered in the service rather than matched in SQL, because
 * the comparison is on digits with every separator removed and the column
 * stores whatever the person typed. A `LIKE` would miss `+91-85288-85250` when
 * the query was `+91 85288 85250`, and a `regexp_replace` on the column cannot
 * use an index either — so the honest version does the fold once, in one place,
 * with the same helper the frontend uses.
 *
 * The Customer master is a few thousand rows at most; if it ever grows past
 * that, the fix is a stored normalized column with its own index, which is an
 * additive change this design does not block.
 */
export function findCustomersWithPhone(): Promise<CustomerRecord[]> {
  return prisma.customer.findMany({
    where: { phone: { not: null } },
    select: customerView,
    orderBy: { createdAt: 'asc' },
  });
}

export function findCustomerById(id: string): Promise<CustomerRecord | null> {
  return prisma.customer.findUnique({ where: { id }, select: customerView });
}

// ---------------------------------------------------------------------------
//  Deal status and assignment
// ---------------------------------------------------------------------------

export function updateLead(
  id: string,
  data: Prisma.LeadUpdateInput,
): Promise<{ id: string }> {
  return prisma.lead.update({ where: { id }, data, select: { id: true } });
}

/** Does this user exist and is their account live? Assignment needs both. */
export function findActiveUser(id: string): Promise<{ id: string } | null> {
  return prisma.user.findFirst({ where: { id, isActive: true }, select: { id: true } });
}

// ---------------------------------------------------------------------------
//  Activities
// ---------------------------------------------------------------------------

export function createActivity(data: {
  leadId: string;
  kind: LeadActivityRecord['kind'];
  dueAt: Date;
  completedAt: Date | null;
  performedById: string | null;
  note: string | null;
}): Promise<{ id: string }> {
  return prisma.leadActivity.create({ data, select: { id: true } });
}

/**
 * One activity, scoped to its lead.
 *
 * The `leadId` in the WHERE clause is the authorisation, not a convenience:
 * without it, an activity id from one lead could be edited through another
 * lead's URL. `findFirst` rather than `findUnique` because the pair is not a
 * unique index — the scoping is what matters, not the lookup shape.
 */
export function findActivityForLead(
  leadId: string,
  activityId: string,
): Promise<LeadActivityRecord | null> {
  return prisma.leadActivity.findFirst({
    where: { id: activityId, leadId },
    select: leadActivitySelect,
  });
}

export async function updateActivityForLead(
  leadId: string,
  activityId: string,
  data: Prisma.LeadActivityUpdateInput,
): Promise<number> {
  // Scoped by leadId for the same reason as above, and reported as a count so
  // the caller can tell "not this lead's activity" from "updated".
  const { count } = await prisma.leadActivity.updateMany({
    where: { id: activityId, leadId },
    data,
  });
  return count;
}

/**
 * Every activity for a set of leads, in one query.
 *
 * The batched reader the analytics list will use. Promptness is derived per
 * lead, so the obvious implementation asks for one lead's activities at a time —
 * which is an N+1 the moment the table shows fifty rows. This fetches them all
 * at once and the caller groups by `leadId`.
 *
 * Exists now, in Phase 4D, rather than later: building the list endpoint on top
 * of a per-lead read and then discovering the problem is how the N+1 in
 * `listPending` got written.
 */
export function findActivitiesForLeads(
  leadIds: string[],
): Promise<(LeadActivityRecord & { leadId: string })[]> {
  if (leadIds.length === 0) return Promise.resolve([]);
  return prisma.leadActivity.findMany({
    where: { leadId: { in: leadIds } },
    select: { ...leadActivitySelect, leadId: true },
    orderBy: { dueAt: 'asc' },
  });
}

// ---------------------------------------------------------------------------
//  Requirements — Complete the Ideal
// ---------------------------------------------------------------------------

/**
 * Does this lead exist?
 *
 * Just the id. A requirement write needs to know the lead is real before it
 * allocates a line number, and `findLead` would fetch the customer, both users,
 * the whole activity timeline and every requirement to answer that.
 */
export function findLeadExists(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string } | null> {
  return tx.lead.findUnique({ where: { id }, select: { id: true } });
}

export function findRequirements(leadId: string): Promise<LeadRequirementRecord[]> {
  return prisma.leadProductRequirement.findMany({
    where: { leadId },
    select: leadRequirementSelect,
    orderBy: { lineNo: 'asc' },
  });
}

/**
 * One requirement, scoped to its lead.
 *
 * The `leadId` in the WHERE clause is the authorisation, exactly as it is for
 * activities: without it, a requirement id from one lead could be read or edited
 * through another lead's URL.
 */
export function findRequirementForLead(
  leadId: string,
  requirementId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; imageId: string | null } | null> {
  return tx.leadProductRequirement.findFirst({
    where: { id: requirementId, leadId },
    select: { id: true, imageId: true },
  });
}

/** One requirement in full, scoped to its lead — what a write returns. */
export function findRequirementView(
  leadId: string,
  requirementId: string,
): Promise<LeadRequirementRecord | null> {
  return prisma.leadProductRequirement.findFirst({
    where: { id: requirementId, leadId },
    select: leadRequirementSelect,
  });
}

/**
 * The fields a patch has to merge against, and only those.
 *
 * An update decides what the row will hold by combining what was sent with what
 * is already there — the match-kind pairing and the measurement normalisation
 * both need the stored side. Numbers rather than Decimals, because the merged
 * figures go straight into arithmetic.
 */
export async function findRequirementState(
  leadId: string,
  requirementId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  rsProductId: string | null;
  matchKind: LeadRequirementRecord['matchKind'];
  weightValue: number | null;
  weightUnit: LeadRequirementRecord['weightUnit'];
  lengthValue: number | null;
  widthValue: number | null;
  heightValue: number | null;
  dimensionUnit: LeadRequirementRecord['dimensionUnit'];
} | null> {
  const row = await tx.leadProductRequirement.findFirst({
    where: { id: requirementId, leadId },
    select: {
      rsProductId: true,
      matchKind: true,
      weightValue: true,
      weightUnit: true,
      lengthValue: true,
      widthValue: true,
      heightValue: true,
      dimensionUnit: true,
    },
  });
  if (!row) return null;

  const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d));

  return {
    rsProductId: row.rsProductId,
    matchKind: row.matchKind,
    weightValue: num(row.weightValue),
    weightUnit: row.weightUnit,
    lengthValue: num(row.lengthValue),
    widthValue: num(row.widthValue),
    heightValue: num(row.heightValue),
    dimensionUnit: row.dimensionUnit,
  };
}

/**
 * Queues concurrent adds on the lead row.
 *
 * `SELECT … FOR UPDATE` on the parent, the same mechanism `lockEnquiry` uses
 * before allocating an enquiry line number. Two simultaneous requests would
 * otherwise both read the same `_max(lineNo)` and the second would collide with
 * the unique index — this makes the second wait and read the first's line.
 */
export async function lockLead(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Lead" WHERE "id" = ${id} FOR UPDATE`;
}

export async function nextRequirementLineNo(
  tx: Prisma.TransactionClient,
  leadId: string,
): Promise<number> {
  const highest = await tx.leadProductRequirement.aggregate({
    where: { leadId },
    _max: { lineNo: true },
  });
  return (highest._max.lineNo ?? 0) + 1;
}

export function createRequirement(
  tx: Prisma.TransactionClient,
  data: Prisma.LeadProductRequirementUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.leadProductRequirement.create({ data, select: { id: true } });
}

/**
 * Edits one requirement, scoped by lead and reported as a count.
 *
 * A count rather than the row, so the caller can tell "no such requirement on
 * this lead" from "updated" without a second read — the same shape
 * `updateActivityForLead` uses.
 */
export async function updateRequirementForLead(
  leadId: string,
  requirementId: string,
  data: Prisma.LeadProductRequirementUncheckedUpdateInput,
): Promise<number> {
  const { count } = await prisma.leadProductRequirement.updateMany({
    where: { id: requirementId, leadId },
    data,
  });
  return count;
}

/**
 * Removes one requirement, scoped by lead.
 *
 * The MediaAsset the row pointed at is deliberately left alone. Media in this
 * CRM is an independently retained record — it carries its own uploader and
 * timestamps, several tables reference it, and the schema says SetNull rather
 * than Cascade on every one of them. Deleting the Cloudinary asset here would
 * also be irreversible and could strip an image still shown elsewhere, so
 * nothing in this module deletes media.
 */
export async function deleteRequirementForLead(
  leadId: string,
  requirementId: string,
): Promise<number> {
  const { count } = await prisma.leadProductRequirement.deleteMany({
    where: { id: requirementId, leadId },
  });
  return count;
}

/** Does this catalogue product exist? A requirement may not name a missing one. */
export function findRsProduct(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string } | null> {
  return tx.rsProduct.findUnique({ where: { id }, select: { id: true } });
}

/** Does this media asset exist? Mirrors the check vendor responses already make. */
export function findMediaAsset(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string } | null> {
  return tx.mediaAsset.findUnique({ where: { id }, select: { id: true } });
}

// ---------------------------------------------------------------------------
//  The analytics list
// ---------------------------------------------------------------------------

/**
 * One lead as the analytics table needs it.
 *
 * Narrower than `leadSelect` on purpose — no activity timeline, no full customer
 * record — and wider in one place: the linked order's lines, charges and
 * customer region, because Order Value is computed from those through Sales'
 * own `toMoney`. There is no stored total to read instead.
 */
export const leadListSelect = {
  id: true,
  dealStatus: true,
  channel: true,
  channelOther: true,
  sourceAt: true,
  createdAt: true,
  associateId: true,
  allocatedById: true,
  salesOrderId: true,
  customer: { select: { id: true, name: true, phone: true, email: true } },
  associate: { select: userRef },
  allocatedBy: { select: userRef },
  /*
    Exactly what `toMoney` consumes. Selected inline so the whole page's order
    values come back with the leads — one query rather than one per row, which
    is the difference between a table that scales and one that does not.
  */
  salesOrder: orderMoneySelect,
  /*
    The requirement values only — not the whole Complete the Ideal payload. The
    board reports a derived requirement total, which needs this column and
    nothing else; pulling the photos and matched products for fifty rows to sum
    one figure each would be the N+1 this list exists to avoid.
  */
  requirements: { select: { productValue: true } },
} satisfies Prisma.LeadSelect;

export type LeadListRecord = Prisma.LeadGetPayload<{ select: typeof leadListSelect }>;

/** The filters Postgres can actually apply. See the service for the rest. */
export type LeadListFilters = {
  q?: string | undefined;
  dealStatus?: LeadListRecord['dealStatus'] | undefined;
  associateId?: string | undefined;
  channel?: string | undefined;
};

/**
 * The orderings the table offers, as a lookup rather than a built string.
 *
 * An allowlist keyed by the shared `LEAD_SORTS` enum: a client cannot reach an
 * ORDER BY clause, because nothing it sends is ever interpolated — an unknown
 * key simply has no entry here and the schema rejected it long before.
 *
 * Every ordering ends with `id` so a page boundary is deterministic. Without
 * that tiebreak, two leads sharing a `sourceAt` could swap places between
 * pages and one would be skipped.
 */
function orderFor(
  sort: 'initiatedAt' | 'dealStatus' | 'createdAt',
  direction: 'asc' | 'desc',
): Prisma.LeadOrderByWithRelationInput[] {
  const d = direction;
  switch (sort) {
    case 'dealStatus':
      return [{ dealStatus: d }, { sourceAt: 'desc' }, { id: 'asc' }];
    case 'createdAt':
      return [{ createdAt: d }, { id: 'asc' }];
    case 'initiatedAt':
    default:
      // `sourceAt` is when the enquiry happened, which is the business's own
      // notion of when a lead was initiated.
      return [{ sourceAt: d }, { id: 'asc' }];
  }
}

/**
 * A page of leads for the analytics table.
 *
 * Takes `limit + 1` so the caller can tell whether another page exists without
 * a second count query — the same trick every other list in the CRM uses.
 */
export function listLeads(query: {
  limit: number;
  cursor?: string | undefined;
  sort: 'initiatedAt' | 'dealStatus' | 'createdAt';
  direction: 'asc' | 'desc';
  filters: LeadListFilters;
}): Promise<LeadListRecord[]> {
  const { q, dealStatus, associateId, channel } = query.filters;

  const where: Prisma.LeadWhereInput = {
    ...(dealStatus ? { dealStatus } : {}),
    ...(associateId ? { associateId } : {}),
    ...(channel ? { channel } : {}),
    /*
      Search spans the customer and the lead's own note, because those are what
      somebody has to hand when they go looking: a name, a number they were
      called from, or a phrase they remember typing. Case-insensitive, and
      `contains` rather than a prefix match — a phone number is remembered from
      its tail as often as its head.
    */
    ...(q
      ? {
          OR: [
            { customer: { name: { contains: q, mode: 'insensitive' as const } } },
            { customer: { phone: { contains: q, mode: 'insensitive' as const } } },
            { customer: { email: { contains: q, mode: 'insensitive' as const } } },
            { sourceDetails: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  return prisma.lead.findMany({
    where,
    orderBy: orderFor(query.sort, query.direction),
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: leadListSelect,
  });
}
