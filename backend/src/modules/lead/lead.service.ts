/**
 * Create Lead / Deal — Phase 1 business logic.
 *
 * A lead records four things: where an enquiry came from, when it happened,
 * what kind of business it is, and who it is from. That is the whole of Phase 1.
 * There is no status, no owner, no follow-up, no products and no pipeline
 * stage, because those rules have not been specified — and a field invented now
 * is one the business has to work around later.
 *
 * ### The customer rule
 *
 * A lead never creates a second customer by accident. It either points at an
 * existing row or creates one through the Customer module's own service, in the
 * same transaction, so a lead that fails validation cannot leave a stray
 * customer behind. There is no third path.
 */

import type { Request } from 'express';
import type {
  AssignLeadInput,
  CreateLeadInput,
  CustomerView,
  LeadActivityInput,
  LeadActivityView,
  LeadAnalyticsPage,
  LeadAnalyticsRow,
  LeadChannel,
  LeadListQuery,
  UpdateLeadActivityInput,
  UpdateLeadInput,
  LeadCustomerLookupResult,
  LeadView,
} from '@rs/shared';
import { normalizePhone } from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import * as repo from './lead.repository.js';
import { toRequirementView } from './lead-requirement.service.js';
import { toMoney } from '../sales/sales.repository.js';
import {
  allocationKind,
  firstContactAt,
  lastFollowUpAt,
  nextFollowUpAt,
  promptness,
  requirementValue,
  type PromptnessInput,
} from './lead.calc.js';

const leadNotFound = (): AppError =>
  AppError.notFound('LEAD_NOT_FOUND', 'That lead could not be found.');

/**
 * How much wider to scan when a derived filter is in play.
 *
 * Four pages' worth, capped at 200 rows. Enough that a page usually fills even
 * when most rows are filtered out, small enough that the query stays bounded
 * however large the table grows.
 */
const DERIVED_SCAN_FACTOR = 4;

/** Neon is a network hop away; the same budget the rest of the CRM uses. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

const toCustomerView = (row: repo.CustomerRecord): CustomerView => ({
  id: row.id,
  name: row.name,
  companyName: row.companyName,
  type: row.type,
  phone: row.phone,
  email: row.email,
  address: row.address,
  state: row.state,
  country: row.country,
  gstNumber: row.gstNumber,
  createdAt: row.createdAt.toISOString(),
});

const toActivityView = (row: repo.LeadActivityRecord): LeadActivityView => ({
  id: row.id,
  kind: row.kind,
  dueAt: row.dueAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null,
  performedBy: row.performedBy,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
});

/**
 * One lead, with everything derived from its activities computed here.
 *
 * `now` is passed in rather than read from this process's clock, so a caller
 * holding many leads scores them all against one instant — and so that instant
 * can come from the database, as it does in every other timing decision in the
 * CRM.
 */
function toView(row: repo.LeadRecord, now: Date): LeadView {
  const activities: PromptnessInput[] = row.activities.map((a) => ({
    kind: a.kind,
    dueAt: a.dueAt,
    completedAt: a.completedAt,
  }));

  const last = lastFollowUpAt(activities);
  const next = nextFollowUpAt(activities, now);

  return {
    id: row.id,
    leadSource: row.leadSource,
    leadSourceOther: row.leadSourceOther,
    sourceDetails: row.sourceDetails,
    sourceAt: row.sourceAt.toISOString(),
    requirementType: row.requirementType,
    customer: toCustomerView(row.customer),
    // Narrowed from the plain String column: the shared z.enum is what
    // guarantees only a permitted channel was ever written.
    channel: row.channel as LeadChannel,
    channelOther: row.channelOther,
    dealStatus: row.dealStatus,
    associate: row.associate,
    allocatedBy: row.allocatedBy,
    // Derived from the two ids above, never a stored column.
    allocation: allocationKind(row.associateId, row.allocatedById),
    salesOrderId: row.salesOrderId,
    /*
      Two different facts, reported separately and never substituted for one
      another. Order Value is what a real order is worth and is null when there
      is no order; Requirement Value is what the customer asked for, as the
      associate priced it. A lead can carry one, both or neither.
    */
    orderValue: row.salesOrder
      ? toMoney(row.salesOrder, row.salesOrder.items, row.salesOrder.charges).total
      : null,
    requirementValue: requirementValue(row.requirements),
    promptness: promptness(activities, now, row.associateId !== null),
    firstContactAt: firstContactAt(activities)?.toISOString() ?? null,
    lastFollowUpAt: last?.toISOString() ?? null,
    nextFollowUpAt: next?.toISOString() ?? null,
    activities: row.activities.map(toActivityView),
    // Complete the Ideal, mapped through the requirement service's own mapper so
    // a requirement looks the same here as it does on its own endpoint. Already
    // fetched by `leadSelect`, with its image and product inline — no query.
    requirements: row.requirements.map(toRequirementView),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
//  Finding the customer
// ---------------------------------------------------------------------------

/**
 * Every customer whose number is this number.
 *
 * Returns a list, and the plural is the point. A phone is meant to identify one
 * customer, but the live data carries duplicates from dummy and historical
 * rows, so returning "the" customer would mean silently picking one and linking
 * a lead to possibly the wrong person. The caller is handed all of them and has
 * to choose.
 *
 * Matching is digits-only and exact — see `normalizePhone`. A query with no
 * digits at all matches nothing rather than everything.
 */
export async function lookupCustomersByPhone(
  phone: string,
): Promise<LeadCustomerLookupResult> {
  const wanted = normalizePhone(phone);
  if (wanted === '') return { normalizedPhone: '', customers: [] };

  const rows = await repo.findCustomersWithPhone();
  const matches = rows.filter((row) => normalizePhone(row.phone) === wanted);

  return { normalizedPhone: wanted, customers: matches.map(toCustomerView) };
}

// ---------------------------------------------------------------------------
//  Creating the lead
// ---------------------------------------------------------------------------

/**
 * Records a lead.
 *
 * The customer is resolved inside the transaction: an id is checked to exist,
 * and a new customer is written through the Customer module's own service so
 * there is one definition of what a customer is. Either way the lead and the
 * customer commit together or not at all.
 *
 * The OTHER/free-text pairing is validated by the shared schema before this
 * runs, and again by the table's CHECK constraints — so this function does not
 * restate it. It enforces the one thing neither of those can see: that the
 * customer being pointed at is real.
 */
export async function createLead(
  req: Request,
  actor: AuthenticatedUser,
  input: CreateLeadInput,
): Promise<LeadView> {
  const id = await prisma.$transaction(async (tx) => {
    const customerId = await resolveCustomer(tx, input);

    const created = await repo.createLead(tx, {
      leadSource: input.leadSource,
      leadSourceOther: input.leadSourceOther ?? null,
      sourceDetails: input.sourceDetails ?? null,
      sourceAt: new Date(input.sourceAt),
      requirementType: input.requirementType,
      customerId,
      channel: input.channel,
      channelOther: input.channelOther ?? null,
      createdById: actor.id,
    });

    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'lead.created',
    entityType: 'Lead',
    entityId: id,
    actorId: actor.id,
    newValue: {
      leadSource: input.leadSource,
      requirementType: input.requirementType,
      channel: input.channel,
      // Whether the lead reused a customer or made one, which is the question
      // somebody reading this trail is most likely to be asking.
      customer: input.customer.customerId ? 'existing' : 'created',
    },
  });

  return loadView(id);
}

/**
 * The existing customer, or a newly created one — never a duplicate.
 *
 * A supplied id is verified rather than trusted: a lead pointing at a customer
 * that was removed between the screen and the button would otherwise fail on a
 * foreign key with a message nobody can act on.
 */
async function resolveCustomer(
  tx: Parameters<typeof repo.createLead>[0],
  input: CreateLeadInput,
): Promise<string> {
  if (input.customer.customerId) {
    const existing = await tx.customer.findUnique({
      where: { id: input.customer.customerId },
      select: { id: true },
    });

    if (!existing) {
      throw AppError.notFound('CUSTOMER_NOT_FOUND', 'That customer could not be found.');
    }

    return existing.id;
  }

  const details = input.customer.newCustomer;
  if (!details) {
    // Unreachable through the schema, which requires exactly one of the two.
    throw AppError.badRequest(
      'CUSTOMER_REQUIRED',
      'Choose an existing customer or add a new one.',
    );
  }

  const created = await tx.customer.create({
    data: {
      name: details.name,
      companyName: details.companyName ?? null,
      type: details.type,
      phone: details.phone ?? null,
      email: details.email ?? null,
      // Blank optional fields are stored as NULL, never as an empty string, so
      // "not recorded" has exactly one representation — the same rule the
      // Customer service applies.
      address: details.address ?? null,
      state: details.state ?? null,
      country: details.country ?? null,
      gstNumber: details.gstNumber ?? null,
    },
    select: { id: true },
  });

  return created.id;
}

// ---------------------------------------------------------------------------
//  Reads
// ---------------------------------------------------------------------------

export async function getLead(id: string): Promise<LeadView> {
  return loadView(id);
}

// ---------------------------------------------------------------------------
//  Deal status
// ---------------------------------------------------------------------------

/**
 * Records where the deal ended up.
 *
 * Status and assignment are separate operations behind separate permissions, so
 * this accepts only the status — a caller cannot reassign a lead by including an
 * extra key, and the route table states which capability each needs rather than
 * the service inferring it from a body.
 */
export async function updateLead(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: UpdateLeadInput,
): Promise<LeadView> {
  const existing = await repo.findLead(id);
  if (!existing) throw leadNotFound();

  await repo.updateLead(id, { dealStatus: input.dealStatus });

  await recordAudit(req, {
    action: 'lead.status.changed',
    entityType: 'Lead',
    entityId: id,
    actorId: actor.id,
    oldValue: { dealStatus: existing.dealStatus },
    newValue: { dealStatus: input.dealStatus },
  });

  return loadView(id);
}

// ---------------------------------------------------------------------------
//  Assignment
// ---------------------------------------------------------------------------

/**
 * Gives a lead to an associate, or takes it back.
 *
 * `allocatedById` is always the authenticated actor and never read from the
 * body: who made an allocation is a fact about who called this, and accepting it
 * from the client would let somebody record a colleague as having decided.
 *
 * SELF and OTHER USER are not written anywhere. They are
 * `allocatedById === associateId`, computed on read — see `allocationKind` in
 * lead.calc.ts.
 *
 * Unassigning clears BOTH ids. Keeping an allocator beside a null associate
 * would describe an allocation that no longer exists, and `allocationKind` would
 * have to invent an answer for it; the audit trail is where "who unassigned
 * this" is recorded, which is the right home for it.
 */
export async function assignLead(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: AssignLeadInput,
): Promise<LeadView> {
  const existing = await repo.findLead(id);
  if (!existing) throw leadNotFound();

  if (input.associateId !== null) {
    // An inactive or missing user cannot own work. Checked here rather than left
    // to the foreign key, so the caller gets a sentence instead of a 500.
    const target = await repo.findActiveUser(input.associateId);
    if (!target) {
      throw AppError.badRequest(
        'ASSOCIATE_NOT_FOUND',
        'That user could not be found, or their account is not active.',
      );
    }
  }

  await repo.updateLead(id, {
    associate: input.associateId
      ? { connect: { id: input.associateId } }
      : { disconnect: true },
    allocatedBy: input.associateId ? { connect: { id: actor.id } } : { disconnect: true },
  });

  await recordAudit(req, {
    action: input.associateId ? 'lead.assigned' : 'lead.unassigned',
    entityType: 'Lead',
    entityId: id,
    actorId: actor.id,
    oldValue: {
      associateId: existing.associateId,
      allocatedById: existing.allocatedById,
    },
    newValue: {
      associateId: input.associateId,
      allocatedById: input.associateId ? actor.id : null,
      // Recorded because it is the thing a reader of the trail actually wants,
      // and deriving it later from two ids in a JSON blob is awkward.
      allocation: allocationKind(input.associateId, input.associateId ? actor.id : null),
    },
  });

  return loadView(id);
}

// ---------------------------------------------------------------------------
//  Activities
// ---------------------------------------------------------------------------

/**
 * Records an expected action, and whether it has happened.
 *
 * `completedAt` is optional and may fall either side of `dueAt`: early is the
 * good case, late is the case promptness exists to measure, and absent means
 * still outstanding. Nothing here compares the two — that is the calc module's
 * job, on read.
 *
 * `performedById` is the actor when the activity arrives already complete, and
 * null otherwise: somebody scheduling a follow-up has not performed it.
 */
export async function createActivity(
  req: Request,
  actor: AuthenticatedUser,
  leadId: string,
  input: LeadActivityInput,
): Promise<LeadView> {
  const lead = await repo.findLead(leadId);
  if (!lead) throw leadNotFound();

  const completedAt = input.completedAt ? new Date(input.completedAt) : null;

  const created = await repo.createActivity({
    leadId,
    kind: input.kind,
    dueAt: new Date(input.dueAt),
    completedAt,
    performedById: completedAt ? actor.id : null,
    note: input.note ?? null,
  });

  await recordAudit(req, {
    action: 'lead.activity.created',
    entityType: 'LeadActivity',
    entityId: created.id,
    actorId: actor.id,
    newValue: { leadId, kind: input.kind, dueAt: input.dueAt, completed: completedAt !== null },
  });

  return loadView(leadId);
}

/**
 * Changes one activity.
 *
 * Scoped to the lead in the URL at the repository level, so an activity id from
 * another lead cannot be edited through this route — that is authorisation, not
 * tidiness.
 *
 * `kind` is deliberately not editable: what sort of action a row records is what
 * it is, and rewriting it would change history rather than correct it.
 */
export async function updateActivity(
  req: Request,
  actor: AuthenticatedUser,
  leadId: string,
  activityId: string,
  input: UpdateLeadActivityInput,
): Promise<LeadView> {
  const existing = await repo.findActivityForLead(leadId, activityId);
  if (!existing) {
    throw AppError.notFound(
      'LEAD_ACTIVITY_NOT_FOUND',
      'That activity could not be found on this lead.',
    );
  }

  const completing = input.completedAt !== undefined && input.completedAt !== null;

  const count = await repo.updateActivityForLead(leadId, activityId, {
    ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt) } : {}),
    ...(input.completedAt !== undefined
      ? { completedAt: input.completedAt === null ? null : new Date(input.completedAt) }
      : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    /*
      Who performed it follows the completion. Clearing the completion clears the
      performer too: an action that did not happen was not performed by anybody.

      The scalar FK rather than relation syntax, because `updateMany` accepts
      only scalars — the lead-scoped WHERE is what makes this an updateMany, and
      that scoping is the authorisation, so the column is written directly.
    */
    ...(completing ? { performedById: actor.id } : {}),
    ...(input.completedAt === null ? { performedById: null } : {}),
  });

  if (count === 0) {
    throw AppError.notFound(
      'LEAD_ACTIVITY_NOT_FOUND',
      'That activity could not be found on this lead.',
    );
  }

  await recordAudit(req, {
    action: 'lead.activity.updated',
    entityType: 'LeadActivity',
    entityId: activityId,
    actorId: actor.id,
    oldValue: {
      dueAt: existing.dueAt.toISOString(),
      completedAt: existing.completedAt?.toISOString() ?? null,
    },
    newValue: { ...input },
  });

  return loadView(leadId);
}

async function loadView(id: string): Promise<LeadView> {
  const [row, now] = await Promise.all([repo.findLead(id), databaseNow()]);
  if (!row) throw leadNotFound();
  return toView(row, now);
}

// ---------------------------------------------------------------------------
//  The analytics list
// ---------------------------------------------------------------------------

/**
 * The Lead/Deal analytics table.
 *
 * ### How this avoids an N+1
 *
 * Three queries for a whole page, regardless of its size:
 *
 *   1. the page of leads, with each linked order's lines and charges inline;
 *   2. every activity for those leads, in one batched call;
 *   3. one `now()` from the database.
 *
 * Promptness, the follow-up summary and the order value are then computed in
 * memory from what those returned. Nothing in this function queries per row —
 * the moment it did, a fifty-row table would issue fifty-one queries, which is
 * the defect this shape exists to prevent.
 *
 * ### Why the derived filters are handled separately
 *
 * Promptness, allocation and follow-up state are computed, not columns, so
 * Postgres cannot filter or order by them. They are applied after calculation,
 * over a bounded over-fetch, and the response says so through
 * `narrowedByDerivedFilter` — because a page narrowed this way may hold fewer
 * rows than the limit without the list having ended, and reporting that as a
 * final page would quietly hide leads.
 */
export async function listLeads(query: LeadListQuery): Promise<LeadAnalyticsPage> {
  const derivedFilter =
    query.promptness !== undefined ||
    query.allocation !== undefined ||
    query.followUp !== undefined;

  /*
    With a derived filter in play, scan a wider window so a page is still
    likely to fill: the rows that survive are a subset of what SQL returned.
    Bounded — never "fetch everything" — so the query stays predictable however
    large the table grows.
  */
  const scan = derivedFilter ? Math.min(query.limit * DERIVED_SCAN_FACTOR, 200) : query.limit;

  const [rows, now] = await Promise.all([
    repo.listLeads({
      limit: scan,
      cursor: query.cursor,
      sort: query.sort,
      direction: query.direction,
      filters: {
        q: query.q,
        dealStatus: query.dealStatus,
        associateId: query.associateId,
        channel: query.channel,
      },
    }),
    databaseNow(),
  ]);

  const hasMore = rows.length > scan;
  const page = hasMore ? rows.slice(0, scan) : rows;

  // ONE query for every activity on the page. See the note above.
  const activities = await repo.findActivitiesForLeads(page.map((lead) => lead.id));

  const byLead = new Map<string, PromptnessInput[]>();
  for (const activity of activities) {
    const list = byLead.get(activity.leadId) ?? [];
    list.push({ kind: activity.kind, dueAt: activity.dueAt, completedAt: activity.completedAt });
    byLead.set(activity.leadId, list);
  }

  let leads = page.map((lead) => toAnalyticsRow(lead, byLead.get(lead.id) ?? [], now));

  if (query.promptness) {
    leads = leads.filter((lead) => lead.promptness.rating === query.promptness);
  }
  if (query.allocation) {
    leads = leads.filter((lead) => lead.allocation === query.allocation);
  }
  if (query.followUp === 'upcoming') {
    leads = leads.filter((lead) => lead.nextFollowUpAt !== null);
  }
  if (query.followUp === 'overdue') {
    leads = leads.filter((lead) => lead.promptness.overdue > 0);
  }

  /*
    The cursor is the last row SQL returned, not the last that survived the
    derived filter — otherwise the next page would restart inside the window
    just scanned and repeat rows.
  */
  const cursorSource = hasMore ? page.at(-1)?.id : null;

  return {
    leads: derivedFilter ? leads.slice(0, query.limit) : leads,
    nextCursor: cursorSource ?? null,
    narrowedByDerivedFilter: derivedFilter,
  };
}

/**
 * One row of the table, with every derived figure computed here.
 *
 * Order Value goes through Sales' own `toMoney` rather than a sum of its own.
 * That function is where GST mode, cancelled quantities, charges and discounts
 * are reconciled, and a second arithmetic here would be a second answer to
 * "what is this order worth" — free to disagree with the invoice.
 *
 * Null when no order is linked, and never 0: an order totalling nothing is a
 * real fact, and showing it as "—" would hide it.
 */
function toAnalyticsRow(
  lead: repo.LeadListRecord,
  activities: PromptnessInput[],
  now: Date,
): LeadAnalyticsRow {
  const p = promptness(activities, now, lead.associateId !== null);
  const last = lastFollowUpAt(activities);
  const next = nextFollowUpAt(activities, now);
  const first = firstContactAt(activities);

  const orderValue = lead.salesOrder
    ? toMoney(lead.salesOrder, lead.salesOrder.items, lead.salesOrder.charges).total
    : null;

  return {
    id: lead.id,
    customer: lead.customer,
    dealStatus: lead.dealStatus,
    channel: lead.channel as LeadChannel,
    channelOther: lead.channelOther,
    associate: lead.associate,
    allocatedBy: lead.allocatedBy,
    allocation: allocationKind(lead.associateId, lead.allocatedById),
    orderValue,
    // The pre-sales figure beside the actual one. Null when nobody has priced a
    // requirement yet, which is different from a requirement priced at zero.
    requirementValue: requirementValue(lead.requirements),
    salesOrderId: lead.salesOrderId,
    initiatedAt: lead.sourceAt.toISOString(),
    createdAt: lead.createdAt.toISOString(),
    firstContactAt: first?.toISOString() ?? null,
    lastFollowUpAt: last?.toISOString() ?? null,
    nextFollowUpAt: next?.toISOString() ?? null,
    promptness: p,
  };
}

// ---------------------------------------------------------------------------
//  Who a lead can be allocated to
// ---------------------------------------------------------------------------

/**
 * The users a lead may be assigned to.
 *
 * Active accounts only, four display fields, name order — the same shape and the
 * same rule as Product Enquiry's `listAssignees`, because it answers the same
 * question. An inactive account cannot own work, which `assignLead` enforces
 * again on the write; offering one here would be inviting a refusal.
 *
 * Its own endpoint rather than borrowing `GET /api/users`, which is
 * administrator-only: allocating a lead needs LEAD_DEAL:ASSIGN, and somebody
 * holding that is not necessarily an administrator. Without this they would meet
 * a 403 on their own allocation picker. Exposes no email, no password hash and
 * no permission rows — only what names a person in a dropdown.
 */
export async function listAssignees(): Promise<
  { id: string; name: string; employeeId: string; role: AuthenticatedUser['role'] }[]
> {
  return prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, employeeId: true, role: true },
    orderBy: { name: 'asc' },
  });
}
