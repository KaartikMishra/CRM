/**
 * Post Sales & Grievance — Phase 1 business logic.
 *
 * A case records what a customer reported after a sale: who they are, which order
 * and lines it concerns, what went wrong, how urgent it is, who owns it, and
 * everything that has happened since. That is the whole of Phase 1.
 *
 * ### What this module deliberately does NOT do
 *
 *   - **It processes no refunds.** `caseType = REFUND` classifies a case; it does
 *     not move money. `SalesRefund` is untouched, and there is no payment gateway
 *     in this CRM — every settlement is a human recording a reference. A module
 *     that implied otherwise would be claiming a payment nobody made.
 *   - **It moves no goods and writes no stock.** No `crmStockQty`, no
 *     `inventoryQty`, no reservation, no return receipt.
 *   - **It creates no shipment.** A delivery case may *reference* a Dispatch;
 *     creating a replacement shipment is a later phase.
 *   - **It sends nothing.** A CUSTOMER_COMMUNICATION activity is a record of a
 *     conversation that already happened, written down afterwards. No WhatsApp,
 *     email or SMS integration exists and none is faked.
 *   - **It runs no clock.** No SLA, no deadline sweep, no automatic escalation.
 *
 * ### The security rules, stated once
 *
 * `raisedById`, `performedById` and `uploadedById` always come from the
 * authenticated actor and are never read from a body. Every child read and write
 * is scoped by its parent id, so an activity or attachment belonging to one case
 * is unreachable through another's URL. An affected line is checked against the
 * case's own order, so a case can never point at somebody else's purchase.
 */

import type { Request } from 'express';
import type {
  AssignPostSalesCaseInput,
  CreatePostSalesCaseInput,
  PostSalesActivityInput,
  PostSalesAttachmentInput,
  PostSalesCaseItemView,
  PostSalesCasePage,
  PostSalesCaseRow,
  PostSalesCaseStatus,
  PostSalesCaseStatusChangeInput,
  PostSalesCaseView,
  PostSalesListQuery,
  PostSalesOverview,
  UpdatePostSalesActivityInput,
  UpdatePostSalesCaseInput,
} from '@rs/shared';
import {
  POST_SALES_CASE_NUMBER_PAD,
  POST_SALES_CASE_PREFIX,
  POST_SALES_OPEN_STATUSES,
  canTransitionCase,
  nextCaseStatuses,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { toMoney } from '../sales/sales.repository.js';
import * as repo from './post-sales.repository.js';
import { notifyCaseAssigned, notifyCriticalCase, notifyCaseReopened } from './post-sales.notify.js';

/** Neon is a network hop away; the same budget the rest of the CRM uses. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/** How many of a customer's orders the picker offers, and how deep audit reads. */
const ORDER_PICKER_LIMIT = 50;
const AUDIT_LIMIT = 100;

const caseNotFound = (): AppError =>
  AppError.notFound('POST_SALES_CASE_NOT_FOUND', 'That case could not be found.');

const activityNotFound = (): AppError =>
  AppError.notFound(
    'POST_SALES_ACTIVITY_NOT_FOUND',
    'That activity could not be found on this case.',
  );

const attachmentNotFound = (): AppError =>
  AppError.notFound(
    'POST_SALES_ATTACHMENT_NOT_FOUND',
    'That attachment could not be found on this case.',
  );

// ---------------------------------------------------------------------------
//  Mappers
// ---------------------------------------------------------------------------

const iso = (d: Date): string => d.toISOString();

const toItemView = (row: repo.CaseRecord['items'][number]): PostSalesCaseItemView => ({
  id: row.id,
  affectedQty: row.affectedQty,
  salesOrderItem: {
    id: row.salesOrderItem.id,
    lineNo: row.salesOrderItem.lineNo,
    productName: row.salesOrderItem.productName,
    quantity: row.salesOrderItem.quantity,
    rsProduct: row.salesOrderItem.rsProduct
      ? {
          id: row.salesOrderItem.rsProduct.id,
          title: row.salesOrderItem.rsProduct.title,
          // SKU lives on the variant; the first is the one a picker shows.
          sku: row.salesOrderItem.rsProduct.variants[0]?.sku ?? null,
        }
      : null,
    image: row.salesOrderItem.productImage,
  },
});

const toActivityView = (row: repo.ActivityRecord) => ({
  id: row.id,
  kind: row.kind,
  note: row.note,
  channel: row.channel,
  direction: row.direction,
  dueAt: row.dueAt ? iso(row.dueAt) : null,
  completedAt: row.completedAt ? iso(row.completedAt) : null,
  performedBy: row.performedBy,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

/**
 * One case as the API reports it.
 *
 * The order's total is computed here through Sales' own `toMoney` rather than read
 * from a column, because no column holds it — the same rule Lead follows for Order
 * Value. A charge changing on the order cannot leave a stale figure on the case.
 */
function toCaseView(row: repo.CaseRecord): PostSalesCaseView {
  const order = row.salesOrder;

  return {
    id: row.id,
    caseNumber: row.caseNumber,
    customer: {
      ...row.customer,
      createdAt: iso(row.customer.createdAt),
    },
    order: order
      ? {
          id: order.id,
          orderId: order.orderId,
          status: order.status,
          orderDate: iso(order.orderDate),
          total: toMoney(order, order.items, order.charges).total,
          paidAmount: order.paidAmount.toString(),
        }
      : null,
    dispatch: row.dispatch,
    caseType: row.caseType,
    issueCategory: row.issueCategory,
    priority: row.priority,
    status: row.status,
    subject: row.subject,
    description: row.description,
    assignedTo: row.assignedTo,
    raisedBy: row.raisedBy,
    resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
    closedAt: row.closedAt ? iso(row.closedAt) : null,
    items: row.items.map(toItemView),
    activities: row.activities.map(toActivityView),
    attachments: row.attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      media: a.media,
      uploadedBy: a.uploadedBy,
      createdAt: iso(a.createdAt),
    })),
    // From the shared transition map, so the form offers exactly what the service
    // will accept rather than a second opinion about the lifecycle.
    nextStatuses: [...nextCaseStatuses(row.status)],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toRowView(row: repo.CaseRowRecord, lastActivityAt: Date | undefined): PostSalesCaseRow {
  const first = row.items[0];

  return {
    id: row.id,
    caseNumber: row.caseNumber,
    customer: row.customer,
    orderId: row.salesOrder?.orderId ?? null,
    caseType: row.caseType,
    issueCategory: row.issueCategory,
    priority: row.priority,
    status: row.status,
    assignedTo: row.assignedTo,
    product: first
      ? {
          name: first.salesOrderItem.productName,
          // How many beyond the one shown. The board draws "Brass thali +2".
          more: Math.max(0, row._count.items - 1),
        }
      : null,
    // The latest activity, falling back to when the case itself was raised: a
    // case with no timeline yet has still "last happened" at its creation.
    lastActivityAt: iso(lastActivityAt ?? row.createdAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
//  Case numbers
// ---------------------------------------------------------------------------

/** Calendar year, matching the business-facing `PS-2026-000001` shape. */
const periodFor = (now: Date): string => String(now.getUTCFullYear());

// ---------------------------------------------------------------------------
//  Creating a case
// ---------------------------------------------------------------------------

/**
 * Raises a case.
 *
 * Everything commits together or not at all: the case, its affected lines, the
 * opening timeline entry and the case number all live in one transaction, so a
 * failed validation cannot leave a half-built case or burn a number.
 *
 * The validation this does that no schema can:
 *
 *   - the customer exists
 *   - the order, if named, belongs to **that** customer
 *   - the dispatch, if named, belongs to **that** order
 *   - every affected line belongs to **that** order
 *   - the assignee, if named, is a live account
 */
export async function createCase(
  req: Request,
  actor: AuthenticatedUser,
  input: CreatePostSalesCaseInput,
): Promise<PostSalesCaseView> {
  const created = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);

    const customer = await repo.findCustomer(input.customerId, tx);
    if (!customer) {
      throw AppError.badRequest('CUSTOMER_NOT_FOUND', 'That customer could not be found.');
    }

    if (input.salesOrderId) {
      const order = await repo.findOrderForCase(input.salesOrderId, tx);
      if (!order) {
        throw AppError.badRequest('SALES_ORDER_NOT_FOUND', 'That order could not be found.');
      }
      /*
        The order must be this customer's. Without this a case could be filed
        against one customer while pointing at another's purchase — which would
        expose what somebody else bought.
      */
      if (order.customerId !== input.customerId) {
        throw AppError.badRequest(
          'ORDER_CUSTOMER_MISMATCH',
          'That order belongs to a different customer.',
        );
      }
    }

    if (input.dispatchId) {
      if (!input.salesOrderId) {
        throw AppError.badRequest(
          'DISPATCH_WITHOUT_ORDER',
          'Choose the order this shipment belongs to.',
        );
      }
      const dispatch = await repo.findDispatchForCase(input.dispatchId, tx);
      if (!dispatch) {
        throw AppError.badRequest('DISPATCH_NOT_FOUND', 'That shipment could not be found.');
      }
      if (dispatch.salesOrderId !== input.salesOrderId) {
        throw AppError.badRequest(
          'DISPATCH_ORDER_MISMATCH',
          'That shipment belongs to a different order.',
        );
      }
    }

    if (input.assignedToId) {
      const target = await repo.findActiveUser(input.assignedToId, tx);
      if (!target) {
        throw AppError.badRequest(
          'ASSIGNEE_NOT_FOUND',
          'That user could not be found, or their account is not active.',
        );
      }
    }

    // Affected lines, checked as a set against the case's own order.
    const items = input.items ?? [];
    if (items.length > 0) {
      const found = await repo.findOrderItems(
        items.map((i) => i.salesOrderItemId),
        tx,
      );

      if (found.length !== items.length) {
        throw AppError.badRequest(
          'ORDER_ITEM_NOT_FOUND',
          'One of those order lines could not be found.',
        );
      }

      const foreign = found.filter((f) => f.orderId !== input.salesOrderId);
      if (foreign.length > 0) {
        throw AppError.badRequest(
          'ORDER_ITEM_MISMATCH',
          'One of those lines belongs to a different order.',
        );
      }

      /*
        An affected quantity cannot exceed what was bought. A complaint about more
        units than the line carries is a typo, and storing it would make every
        downstream figure wrong.
      */
      const byId = new Map(found.map((f) => [f.id, f]));
      for (const item of items) {
        const line = byId.get(item.salesOrderItemId)!;
        if (item.affectedQty > line.quantity) {
          throw AppError.badRequest(
            'AFFECTED_QTY_TOO_HIGH',
            `That line has ${line.quantity} unit(s); the case names ${item.affectedQty}.`,
          );
        }
      }
    }

    const next = await repo.allocateCaseNumber(tx, periodFor(now));
    const caseNumber = `${POST_SALES_CASE_PREFIX}-${periodFor(now)}-${String(next).padStart(
      POST_SALES_CASE_NUMBER_PAD,
      '0',
    )}`;

    /*
      A case named an assignee at creation, so it starts ASSIGNED rather than NEW.
      The status and the assignment cannot disagree: NEW with an owner would be a
      lie about where the case stands.
    */
    const status: PostSalesCaseStatus = input.assignedToId ? 'ASSIGNED' : 'NEW';

    const row = await repo.createCase(tx, {
      caseNumber,
      customerId: input.customerId,
      salesOrderId: input.salesOrderId ?? null,
      dispatchId: input.dispatchId ?? null,
      caseType: input.caseType,
      issueCategory: input.issueCategory,
      priority: input.priority,
      status,
      subject: input.subject,
      description: input.description,
      assignedToId: input.assignedToId ?? null,
      // Never from the body. The authenticated actor raised this.
      raisedById: actor.id,
    });

    if (items.length > 0) {
      await repo.createCaseItems(
        tx,
        items.map((i) => ({
          caseId: row.id,
          salesOrderItemId: i.salesOrderItemId,
          affectedQty: i.affectedQty,
        })),
      );
    }

    // The opening timeline entry, written by the service rather than the caller —
    // which is why it has no performer.
    await repo.createActivity(
      {
        caseId: row.id,
        kind: 'SYSTEM',
        note: `Case ${caseNumber} raised.`,
        performedById: null,
      },
      tx,
    );

    return row;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'postSales.case.created',
    entityType: 'PostSalesCase',
    entityId: created.id,
    actorId: actor.id,
    newValue: {
      caseNumber: created.caseNumber,
      customerId: input.customerId,
      salesOrderId: input.salesOrderId ?? null,
      caseType: input.caseType,
      issueCategory: input.issueCategory,
      priority: input.priority,
      assignedToId: input.assignedToId ?? null,
      items: (input.items ?? []).length,
    },
  });

  /*
    Notifications after the commit, never inside it: a notification for a case
    that failed to save would be a notice about nothing, and a slow WebSocket
    write should not hold a database transaction open.
  */
  if (input.assignedToId && input.assignedToId !== actor.id) {
    await notifyCaseAssigned(created.id, created.caseNumber, input.assignedToId, actor);
  }
  if (input.priority === 'CRITICAL' || input.priority === 'HIGH') {
    await notifyCriticalCase(created.id, created.caseNumber, input.priority, actor);
  }

  return loadCase(created.id);
}

// ---------------------------------------------------------------------------
//  Reading
// ---------------------------------------------------------------------------

async function loadCase(id: string): Promise<PostSalesCaseView> {
  const row = await repo.findCase(id);
  if (!row) throw caseNotFound();
  return toCaseView(row);
}

export const getCase = (id: string): Promise<PostSalesCaseView> => loadCase(id);

/**
 * The case board.
 *
 * ### How this avoids an N+1
 *
 * Two queries for a whole page, regardless of its size: the page of cases with
 * each one's customer, order id, assignee and first affected line inline, then one
 * grouped query for every page row's latest activity. Nothing in this function
 * queries per row — the moment it did, a fifty-row board would issue fifty-one
 * queries.
 *
 * Every filter is applied in SQL, so a page is a page: there are no derived
 * filters here and therefore no over-fetch and no "narrowed" caveat.
 */
export async function listCases(
  actor: AuthenticatedUser,
  query: PostSalesListQuery,
): Promise<PostSalesCasePage> {
  /*
    `mine` resolves against the authenticated user rather than taking an id, so
    somebody cannot read "my cases" as somebody else. An explicit assignedToId
    filter still works — it is a board filter, not an impersonation.
  */
  const assignedToId = query.mine ? actor.id : query.assignedToId;

  const rows = await repo.listCases({
    limit: query.limit,
    cursor: query.cursor,
    sort: query.sort,
    direction: query.direction,
    filters: {
      q: query.q,
      caseType: query.caseType,
      issueCategory: query.issueCategory,
      priority: query.priority,
      status: query.status,
      assignedToId,
      // Only when no explicit status was asked for; the two would contradict.
      statusIn: query.openOnly && !query.status ? POST_SALES_OPEN_STATUSES : undefined,
      channel: query.channel,
      from: query.from,
      to: query.to,
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const lastActivity = await repo.lastActivityFor(page.map((r) => r.id));

  return {
    cases: page.map((row) => toRowView(row, lastActivity.get(row.id))),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * The overview counts.
 *
 * One grouped query for the status breakdown plus four narrow counts, rather than
 * eight separate tile queries. Only what the core case system can answer honestly:
 * no return rate, refund rate, SLA breach or CSAT, because Phase 1 holds none of
 * that data and a plausible-looking zero would be worse than an absent tile.
 */
export async function getOverview(actor: AuthenticatedUser): Promise<PostSalesOverview> {
  const now = await databaseNow();
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const [byStatus, newToday, assignedToMe, resolvedToday, unassigned] = await Promise.all([
    repo.countByStatus(),
    repo.countCases({ createdAt: { gte: startOfToday } }),
    repo.countCases({
      assignedToId: actor.id,
      status: { in: [...POST_SALES_OPEN_STATUSES] },
    }),
    repo.countCases({ resolvedAt: { gte: startOfToday } }),
    repo.countCases({
      assignedToId: null,
      status: { in: [...POST_SALES_OPEN_STATUSES] },
    }),
  ]);

  const count = (status: PostSalesCaseStatus): number =>
    byStatus.find((r) => r.status === status)?.count ?? 0;

  const total = byStatus.reduce((sum, r) => sum + r.count, 0);
  const open = POST_SALES_OPEN_STATUSES.reduce((sum, s) => sum + count(s), 0);

  return {
    total,
    open,
    newToday,
    assignedToMe,
    critical: await repo.countCases({
      priority: 'CRITICAL',
      status: { in: [...POST_SALES_OPEN_STATUSES] },
    }),
    resolvedToday,
    reopened: count('REOPENED'),
    unassigned,
  };
}

export async function listAssignees() {
  return repo.listAssignees();
}

/**
 * One customer's orders and their lines, for the create form's pickers.
 *
 * Scoped to the customer in the URL — which is the authorisation. Without it the
 * picker could list anybody's orders, exposing what other customers bought.
 */
export async function listCustomerOrders(customerId: string) {
  const customer = await repo.findCustomer(customerId);
  if (!customer) {
    throw AppError.notFound('CUSTOMER_NOT_FOUND', 'That customer could not be found.');
  }

  const orders = await repo.listCustomerOrders(customerId, ORDER_PICKER_LIMIT);
  return orders.map((o) => ({
    id: o.id,
    orderId: o.orderId,
    status: o.status,
    orderDate: iso(o.orderDate),
    items: o.items,
  }));
}

export async function getCaseAudit(id: string) {
  const existing = await repo.findCaseState(id);
  if (!existing) throw caseNotFound();

  const rows = await repo.findCaseAudit(id, AUDIT_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor: r.actor,
    oldValue: r.oldValue,
    newValue: r.newValue,
    createdAt: iso(r.createdAt),
  }));
}

// ---------------------------------------------------------------------------
//  Editing a case
// ---------------------------------------------------------------------------

/**
 * Edits a case's classification and description.
 *
 * Deliberately narrow: the customer and the order are what the case *is*, and
 * changing either would make it a different case. Status and assignment have
 * their own endpoints because each is validated or gated differently.
 */
export async function updateCase(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: UpdatePostSalesCaseInput,
): Promise<PostSalesCaseView> {
  const existing = await repo.findCaseState(id);
  if (!existing) throw caseNotFound();

  await repo.updateCase(id, { ...input });

  // A priority move is worth its own timeline entry; the rest are field edits the
  // audit trail already records.
  if (input.priority && input.priority !== existing.priority) {
    await repo.createActivity({
      caseId: id,
      kind: 'SYSTEM',
      note: `Priority changed from ${existing.priority} to ${input.priority}.`,
      performedById: actor.id,
    });
  }

  await recordAudit(req, {
    action: 'postSales.case.updated',
    entityType: 'PostSalesCase',
    entityId: id,
    actorId: actor.id,
    oldValue: { priority: existing.priority },
    newValue: { ...input },
  });

  if (input.priority === 'CRITICAL' && existing.priority !== 'CRITICAL') {
    await notifyCriticalCase(id, existing.caseNumber, 'CRITICAL', actor);
  }

  return loadCase(id);
}

/**
 * Moves a case through its lifecycle.
 *
 * The move is checked against the shared transition map — the same map the UI
 * builds its buttons from, so a legal-looking button cannot produce an illegal
 * move, and an illegal request is refused with the reason rather than silently
 * applied.
 *
 * `resolvedAt` and `closedAt` are stamped here and nowhere else, so neither can
 * disagree with the status it describes. Reaching CLOSED keeps the existing
 * `resolvedAt`: a case was resolved at one moment and closed at another, and
 * overwriting the first would lose when the work actually finished.
 */
export async function changeStatus(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: PostSalesCaseStatusChangeInput,
): Promise<PostSalesCaseView> {
  const existing = await repo.findCaseState(id);
  if (!existing) throw caseNotFound();

  if (!canTransitionCase(existing.status, input.status)) {
    throw AppError.badRequest(
      'INVALID_STATUS_TRANSITION',
      `A case cannot move from ${existing.status} to ${input.status}.`,
    );
  }

  const now = await databaseNow();

  const data: Record<string, unknown> = { status: input.status };

  if (input.status === 'RESOLVED') {
    data.resolvedAt = now;
  }
  if (input.status === 'CLOSED') {
    data.closedAt = now;
    // A direct RESOLVED -> CLOSED keeps its resolvedAt; this only fills a gap the
    // CHECK constraint would otherwise refuse.
    data.resolvedAt = undefined;
  }
  if (input.status === 'REOPENED') {
    // Reopening undoes the closure: a case that is open again was not resolved.
    data.resolvedAt = null;
    data.closedAt = null;
  }

  await repo.updateCase(id, data);

  await repo.createActivity({
    caseId: id,
    kind: 'STATUS_CHANGE',
    note: input.note
      ? `${existing.status} → ${input.status}. ${input.note}`
      : `${existing.status} → ${input.status}.`,
    performedById: actor.id,
  });

  await recordAudit(req, {
    action: 'postSales.case.statusChanged',
    entityType: 'PostSalesCase',
    entityId: id,
    actorId: actor.id,
    oldValue: { status: existing.status },
    newValue: { status: input.status, note: input.note ?? null },
  });

  if (input.status === 'REOPENED' && existing.assignedToId) {
    await notifyCaseReopened(id, existing.caseNumber, existing.assignedToId, actor);
  }

  return loadCase(id);
}

/**
 * Allocates a case, or clears the allocation.
 *
 * `assignedToId: null` unassigns. Who performed the allocation is the
 * authenticated actor and is never taken from the body — that is what makes the
 * audit trail trustworthy.
 *
 * Assignment history lives in `AuditLog`, which is why there is no assignment
 * table: the generic trail already records actor, old value, new value and
 * timestamp, and a second table would be a parallel history free to disagree.
 */
export async function assignCase(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: AssignPostSalesCaseInput,
): Promise<PostSalesCaseView> {
  const existing = await repo.findCaseState(id);
  if (!existing) throw caseNotFound();

  if (input.assignedToId !== null) {
    const target = await repo.findActiveUser(input.assignedToId);
    if (!target) {
      throw AppError.badRequest(
        'ASSIGNEE_NOT_FOUND',
        'That user could not be found, or their account is not active.',
      );
    }
  }

  /*
    A NEW case becoming owned becomes ASSIGNED, so status and assignment agree.
    Nothing further along is rewound — a case being worked stays IN_PROGRESS when
    it changes hands.
  */
  const status =
    input.assignedToId && existing.status === 'NEW' ? 'ASSIGNED' : existing.status;

  await repo.updateCase(id, { assignedToId: input.assignedToId, status });

  const who = input.assignedToId === null ? 'Unassigned.' : 'Assigned.';
  await repo.createActivity({
    caseId: id,
    kind: 'ASSIGNMENT_CHANGE',
    note: who,
    performedById: actor.id,
  });

  await recordAudit(req, {
    action: input.assignedToId ? 'postSales.case.assigned' : 'postSales.case.unassigned',
    entityType: 'PostSalesCase',
    entityId: id,
    actorId: actor.id,
    oldValue: { assignedToId: existing.assignedToId },
    newValue: { assignedToId: input.assignedToId },
  });

  // Not for a self-assignment: telling somebody what they just did is noise.
  if (input.assignedToId && input.assignedToId !== actor.id) {
    await notifyCaseAssigned(id, existing.caseNumber, input.assignedToId, actor);
  }

  return loadCase(id);
}

// ---------------------------------------------------------------------------
//  Activities
// ---------------------------------------------------------------------------

/**
 * Adds a timeline entry — a note, an internal note, a logged conversation or a
 * follow-up.
 *
 * The three system kinds are refused by the shared schema, so a caller cannot
 * forge a STATUS_CHANGE entry and falsify the history. `performedById` is the
 * authenticated actor, never the body.
 */
export async function addActivity(
  req: Request,
  actor: AuthenticatedUser,
  caseId: string,
  input: PostSalesActivityInput,
): Promise<PostSalesCaseView> {
  const existing = await repo.findCaseState(caseId);
  if (!existing) throw caseNotFound();

  const created = await repo.createActivity({
    caseId,
    kind: input.kind,
    note: input.note,
    channel: input.channel ?? null,
    direction: input.direction ?? null,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    completedAt: input.completedAt ? new Date(input.completedAt) : null,
    performedById: actor.id,
  });

  await recordAudit(req, {
    action: 'postSales.activity.added',
    entityType: 'PostSalesCase',
    entityId: caseId,
    actorId: actor.id,
    newValue: {
      activityId: created.id,
      kind: input.kind,
      channel: input.channel ?? null,
      direction: input.direction ?? null,
    },
  });

  return loadCase(caseId);
}

/**
 * Edits a timeline entry, or marks a follow-up done.
 *
 * Scoped by `caseId`, so an activity from another case is unreachable through this
 * URL. `kind` is absent from the contract and stays absent: turning a note into a
 * communication would rewrite what happened rather than correct it.
 */
export async function updateActivity(
  req: Request,
  actor: AuthenticatedUser,
  caseId: string,
  activityId: string,
  input: UpdatePostSalesActivityInput,
): Promise<PostSalesCaseView> {
  const existing = await repo.findActivityForCase(caseId, activityId);
  if (!existing) throw activityNotFound();

  const count = await repo.updateActivityForCase(caseId, activityId, {
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt) } : {}),
    ...(input.completedAt !== undefined
      ? { completedAt: input.completedAt === null ? null : new Date(input.completedAt) }
      : {}),
  });

  if (count === 0) throw activityNotFound();

  await recordAudit(req, {
    action: 'postSales.activity.updated',
    entityType: 'PostSalesCase',
    entityId: caseId,
    actorId: actor.id,
    newValue: { activityId, ...input },
  });

  return loadCase(caseId);
}

// ---------------------------------------------------------------------------
//  Attachments
// ---------------------------------------------------------------------------

/**
 * Attaches an already-uploaded image to a case.
 *
 * The bytes went through the existing Cloudinary upload route, which is the one
 * place binary data is handled in this CRM and which enforces the permitted image
 * types and the size cap. This records that the asset belongs to this case.
 *
 * Phase 1 accepts only what that uploader accepts — JPEG, PNG, WebP and GIF. PDF
 * and video are genuinely required by the business and genuinely unsupported
 * today; widening the shared upload path touches four other modules and is a
 * deliberate decision rather than a detail of this phase.
 */
export async function addAttachment(
  req: Request,
  actor: AuthenticatedUser,
  caseId: string,
  input: PostSalesAttachmentInput,
): Promise<PostSalesCaseView> {
  const existing = await repo.findCaseState(caseId);
  if (!existing) throw caseNotFound();

  const asset = await repo.findMediaAsset(input.mediaAssetId);
  if (!asset) {
    throw AppError.badRequest('INVALID_IMAGE', 'That image could not be found.');
  }

  const created = await repo.createAttachment({
    caseId,
    mediaAssetId: input.mediaAssetId,
    kind: input.kind,
    uploadedById: actor.id,
  });

  await recordAudit(req, {
    action: 'postSales.attachment.added',
    entityType: 'PostSalesCase',
    entityId: caseId,
    actorId: actor.id,
    newValue: { attachmentId: created.id, mediaAssetId: input.mediaAssetId, kind: input.kind },
  });

  return loadCase(caseId);
}

/**
 * Detaches an attachment from a case.
 *
 * **The MediaAsset is deliberately retained.** Media here is an independently
 * held record — seven tables reference it and every foreign key is SetNull rather
 * than Cascade — so removing an attachment detaches the asset and nothing more.
 * Deleting the Cloudinary object would be irreversible and could strip an image
 * still shown elsewhere.
 */
export async function removeAttachment(
  req: Request,
  actor: AuthenticatedUser,
  caseId: string,
  attachmentId: string,
): Promise<PostSalesCaseView> {
  const existing = await repo.findAttachmentForCase(caseId, attachmentId);
  if (!existing) throw attachmentNotFound();

  const count = await repo.deleteAttachmentForCase(caseId, attachmentId);
  if (count === 0) throw attachmentNotFound();

  await recordAudit(req, {
    action: 'postSales.attachment.removed',
    entityType: 'PostSalesCase',
    entityId: caseId,
    actorId: actor.id,
    // The asset id is recorded so the trail shows which image was detached — the
    // asset itself is retained, deliberately.
    oldValue: { attachmentId, mediaAssetId: existing.mediaAssetId },
  });

  return loadCase(caseId);
}
