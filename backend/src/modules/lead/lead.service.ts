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
  CreateLeadInput,
  CustomerView,
  LeadChannel,
  LeadCustomerLookupResult,
  LeadView,
} from '@rs/shared';
import { normalizePhone } from '@rs/shared';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import * as repo from './lead.repository.js';

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

function toView(row: repo.LeadRecord): LeadView {
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

async function loadView(id: string): Promise<LeadView> {
  const row = await repo.findLead(id);
  if (!row) throw AppError.notFound('LEAD_NOT_FOUND', 'That lead could not be found.');
  return toView(row);
}
