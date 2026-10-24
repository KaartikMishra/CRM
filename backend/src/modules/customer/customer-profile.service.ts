/**
 * All Customers — one customer's profile and history.
 *
 * Phase A2. Separate from `customer-directory.service.ts` because the questions
 * are different: the directory answers "which customers match this", a page at
 * a time across many customers; this answers "everything about one customer",
 * which means aggregating all of their orders and paging each relation.
 *
 * ### The same money rule as everywhere else
 *
 * Order values come from Sales' own `toMoney`. This file performs no order
 * arithmetic — no quantity times price, no GST rate, no charge summing — so a
 * customer's purchase value cannot disagree with the invoice the customer was
 * sent. The aggregate is `customerPurchaseMetrics`, which only adds up figures
 * `toMoney` already produced.
 *
 * ### What it refuses to invent
 *
 * A customer with no enquiries has an empty list, not a zero-filled one. A
 * customer who has never ordered has a null average order value and a null last
 * purchase date, never '0.00' or an epoch. And the timeline says when it has
 * been truncated, because "nothing more happened" and "this view does not show
 * everything that happened" are different claims.
 */

import {
  attributionFor,
  customerConversionMetrics,
  customerPurchaseMetrics,
  type CustomerEnquiryRow,
  type CustomerHistoryPage,
  type CustomerLeadFact,
  type CustomerLeadRow,
  type CustomerOrderFact,
  type CustomerOrderRow,
  type CustomerProfile,
  type CustomerTimelineEntry,
  type CustomerTimelinePage,
  type SourceEvent,
  sortTimeline,
} from '@rs/shared';
import { AppError } from '../../utils/AppError.js';
import { toMoney } from '../sales/sales.repository.js';
import * as repo from './customer.repository.js';

/**
 * How many events of each kind the timeline reads.
 *
 * A cap rather than everything: eight sources unbounded would let one very
 * active customer pull an arbitrary amount into memory to render a page nobody
 * scrolls to the end of. When a source hits the cap the response says so.
 */
const TIMELINE_PER_SOURCE = 50;

/** The customer, or the standard 404 the rest of the CRM returns. */
async function requireCustomer(id: string) {
  const customer = await repo.findCustomerById(id);
  if (!customer) {
    throw AppError.notFound('CUSTOMER_NOT_FOUND', 'That customer could not be found.');
  }
  return customer;
}

/** One order's money, through Sales' own definition. Never recomputed here. */
function orderFactOf(order: {
  id: string;
  orderDate: Date;
  status: 'OPEN' | 'DISPATCHED' | 'CLOSED' | 'CANCELLED';
  items: Parameters<typeof toMoney>[1];
  charges: Parameters<typeof toMoney>[2];
  paidAmount: Parameters<typeof toMoney>[0]['paidAmount'];
  customer: Parameters<typeof toMoney>[0]['customer'];
  refunds?: Parameters<typeof toMoney>[0]['refunds'];
  paymentMethod?: string | null;
}): CustomerOrderFact {
  const money = toMoney(order, order.items, order.charges);
  return {
    orderId: order.id,
    orderDate: order.orderDate,
    status: order.status,
    money: {
      activeTotal: money.activeTotal,
      refunded: money.refunded,
      refundPending: money.refundPending,
      paid: money.paid,
      fullyPaid: money.fullyPaid,
    },
  };
}

/** The profile header: identity, attribution and every derived aggregate. */
export async function customerProfile(id: string): Promise<CustomerProfile> {
  const customer = await requireCustomer(id);

  /*
    The aggregate reads every order and every lead, not a page of them: a
    purchase total over the first twenty-five orders would be wrong, and
    silently so. The paged endpoints below are what the tabs call.
  */
  const [orders, leads, enquirySummary, assignees, flagged] = await Promise.all([
    repo.allOrdersForCustomerMoney(id),
    repo.allLeadsForCustomerConversion(id),
    repo.enquirySummaryForCustomer(id),
    repo.assigneesForCustomer(id),
    repo.hasOpenDuplicate(id),
  ]);

  const purchase = customerPurchaseMetrics(orders.map((o) => orderFactOf(o)));
  const conversion = customerConversionMetrics(
    leads.map(
      (lead): CustomerLeadFact => ({
        leadId: lead.id,
        dealStatus: lead.dealStatus,
        salesOrderId: lead.salesOrderId,
        linkedOrderCancelled:
          lead.salesOrder === null ? null : lead.salesOrder.status === 'CANCELLED',
      }),
    ),
  );

  const events: SourceEvent[] = [
    ...customer.leads.map(
      (lead): SourceEvent => ({
        origin: 'LEAD',
        recordId: lead.id,
        source: lead.leadSource,
        sourceOther: lead.leadSourceOther,
        channel: lead.channel,
        channelOther: lead.channelOther,
        at: lead.sourceAt,
      }),
    ),
    ...customer.enquiries.map(
      (enquiry): SourceEvent => ({
        origin: 'ENQUIRY',
        recordId: enquiry.id,
        source: enquiry.source,
        sourceOther: enquiry.sourceDetail,
        at: enquiry.createdAt,
      }),
    ),
  ];
  const { firstTouch, lastTouch } = attributionFor(events);

  /*
    Ownership stays per record. The counts are merged by user so the profile can
    say "Priya holds three of this customer's records", and no single one of
    them is elected the customer's owner — the schema records no such thing, and
    inventing one would misstate who is responsible for what.
  */
  const counts = new Map<string, number>();
  for (const row of assignees.enquiryOwners) {
    if (row.assignedToId) {
      counts.set(row.assignedToId, (counts.get(row.assignedToId) ?? 0) + row._count._all);
    }
  }
  for (const row of assignees.leadOwners) {
    if (row.associateId) {
      counts.set(row.associateId, (counts.get(row.associateId) ?? 0) + row._count._all);
    }
  }
  const people = await repo.usersByIds([...counts.keys()]);

  return {
    id: customer.id,
    name: customer.name,
    companyName: customer.companyName,
    type: customer.type,
    phone: customer.phone,
    email: customer.email,
    address: customer.address,
    state: customer.state,
    country: customer.country,
    gstNumber: customer.gstNumber,
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
    firstTouch,
    lastTouch,
    purchase: {
      validOrderCount: purchase.validOrderCount,
      cancelledOrderCount: purchase.cancelledOrderCount,
      paidOrderCount: purchase.paidOrderCount,
      verifiedPurchaseValue: purchase.verifiedPurchaseValue,
      grossPurchaseValue: purchase.grossPurchaseValue,
      refundedValue: purchase.refundedValue,
      pendingRefundValue: purchase.pendingRefundValue,
      averageOrderValue: purchase.averageOrderValue,
      isRepeatCustomer: purchase.isRepeatCustomer,
      firstPurchaseAt: purchase.firstPurchaseAt,
      lastPurchaseAt: purchase.lastPurchaseAt,
      // The CRM's money is INR throughout; toMoney hardcodes it, and Shopify's
      // currencies are a separate module's problem by design.
      currency: 'INR',
    },
    conversion: {
      leadCount: conversion.leadCount,
      convertedLeadCount: conversion.convertedLeadCount,
      wonLeadCount: conversion.wonLeadCount,
      conversionRate: conversion.conversionRate,
    },
    enquiryCount: enquirySummary.count,
    lastEnquiryAt: enquirySummary.lastAt?.toISOString() ?? null,
    assignees: people.map((person) => ({
      userId: person.id,
      name: person.name,
      employeeId: person.employeeId,
      recordCount: counts.get(person.id) ?? 0,
    })),
    hasDuplicateCandidate: flagged,
  };
}

/** Cuts a `take: limit + 1` result into a page plus its cursor. */
function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
): { rows: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

export async function customerEnquiries(
  id: string,
  limit: number,
  cursor?: string,
): Promise<CustomerHistoryPage<CustomerEnquiryRow>> {
  // 404 before listing: an unknown id should say so, not return an empty page
  // that reads as "this customer has no enquiries".
  await requireCustomer(id);

  const { rows, nextCursor } = paginate(
    await repo.enquiriesForCustomer(id, limit, cursor),
    limit,
  );

  return {
    rows: rows.map((row) => ({
      enquiryId: row.id,
      enquiryNo: row.enquiryNo,
      source: row.source,
      sourceDetail: row.sourceDetail,
      status: row.status,
      assignedTo: { userId: row.assignedTo.id, name: row.assignedTo.name },
      productCount: row._count.products,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function customerLeads(
  id: string,
  limit: number,
  cursor?: string,
): Promise<CustomerHistoryPage<CustomerLeadRow>> {
  await requireCustomer(id);

  const { rows, nextCursor } = paginate(await repo.leadsForCustomer(id, limit, cursor), limit);

  return {
    rows: rows.map((row) => ({
      leadId: row.id,
      leadSource: row.leadSource,
      leadSourceOther: row.leadSourceOther,
      channel: row.channel,
      channelOther: row.channelOther,
      requirementType: row.requirementType,
      dealStatus: row.dealStatus,
      salesOrderId: row.salesOrderId,
      /*
        A link alone is not conversion. A lead whose order was cancelled has not
        produced a sale, which is why the order's status is selected alongside
        the id rather than inferred from its presence.
      */
      isConverted: row.salesOrderId !== null && row.salesOrder?.status !== 'CANCELLED',
      associate: row.associate
        ? { userId: row.associate.id, name: row.associate.name }
        : null,
      sourceAt: row.sourceAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function customerOrders(
  id: string,
  limit: number,
  cursor?: string,
): Promise<CustomerHistoryPage<CustomerOrderRow>> {
  await requireCustomer(id);

  const { rows, nextCursor } = paginate(await repo.ordersForCustomer(id, limit, cursor), limit);

  return {
    rows: rows.map((row) => {
      const money = toMoney(row, row.items, row.charges);
      return {
        id: row.id,
        orderId: row.orderId,
        orderDate: row.orderDate.toISOString(),
        status: row.status,
        /*
          Both figures are shown. `activeTotal` is what the order is worth now,
          cancellations netted out and '0.00' if the whole order was called off;
          `total` is what was originally agreed. Showing only the first would
          make a cancelled order look like it never existed, and only the second
          would overstate what the customer owes.
        */
        activeTotal: money.activeTotal,
        total: money.total,
        paid: money.paid,
        refunded: money.refunded,
        refundPending: money.refundPending,
        fullyPaid: money.fullyPaid,
        itemCount: row._count.items,
      };
    }),
    nextCursor,
  };
}

/**
 * The merged journey.
 *
 * Eight sources, read in parallel, merged and ordered newest first. Ordering is
 * total: timestamp, then a fixed kind precedence, then the record id — so two
 * events sharing a timestamp always come back in the same order rather than
 * whichever the database returned first.
 */
export async function customerTimeline(id: string): Promise<CustomerTimelinePage> {
  await requireCustomer(id);
  const sources = await repo.timelineSourcesForCustomer(id, TIMELINE_PER_SOURCE);

  const entries: CustomerTimelineEntry[] = [];

  for (const e of sources.enquiries) {
    entries.push({
      id: `enquiry:${e.id}`,
      kind: 'ENQUIRY_RAISED',
      at: e.createdAt.toISOString(),
      summary: `Enquiry ${e.enquiryNo} raised via ${e.source}`,
      actor: null,
      href: `/product-enquiry/${e.id}`,
    });
  }

  for (const ev of sources.enquiryEvents) {
    entries.push({
      id: `enquiry-event:${ev.id}`,
      kind: 'ENQUIRY_EVENT',
      at: ev.occurredAt.toISOString(),
      summary: ev.field ? `Enquiry ${ev.type}: ${ev.field}` : `Enquiry ${ev.type}`,
      // Null is a real state, not missing data: some events have no actor.
      actor: ev.actor ? { userId: ev.actor.id, name: ev.actor.name } : null,
      href: `/product-enquiry/${ev.enquiryId}`,
    });
  }

  for (const lead of sources.leads) {
    entries.push({
      id: `lead:${lead.id}`,
      kind: 'LEAD_CAPTURED',
      // sourceAt, the business instant, not when the row was written.
      at: lead.sourceAt.toISOString(),
      summary: `Lead captured via ${lead.leadSource} on ${lead.channel}`,
      actor: null,
      href: `/leads/${lead.id}`,
    });
  }

  for (const act of sources.leadActivities) {
    /*
      A follow-up has two timestamps: when it was due and when it happened. The
      completed one is the event if there is one; otherwise the due date places
      an outstanding follow-up on the timeline, which is where somebody looking
      for what is pending would expect it.
    */
    const at = act.completedAt ?? act.dueAt;
    entries.push({
      id: `lead-activity:${act.id}`,
      kind: 'LEAD_ACTIVITY',
      at: at.toISOString(),
      summary: act.completedAt
        ? `Lead ${act.kind.toLowerCase().replace('_', ' ')} completed${act.note ? `: ${act.note}` : ''}`
        : `Lead ${act.kind.toLowerCase().replace('_', ' ')} due`,
      actor: act.performedBy
        ? { userId: act.performedBy.id, name: act.performedBy.name }
        : null,
      href: `/leads/${act.leadId}`,
    });
  }

  for (const order of sources.orders) {
    entries.push({
      id: `order:${order.id}`,
      kind: 'ORDER_PLACED',
      at: order.orderDate.toISOString(),
      summary: `Order ${order.orderId} placed`,
      actor: null,
      href: `/sales/${order.id}`,
    });
    // A cancellation is its own event at its own time, not a changed label on
    // the order-placed entry: both happened, and the timeline records both.
    if (order.cancelledAt) {
      entries.push({
        id: `order-cancelled:${order.id}`,
        kind: 'ORDER_CANCELLED',
        at: order.cancelledAt.toISOString(),
        summary: order.cancellationReason
          ? `Order ${order.orderId} cancelled: ${order.cancellationReason}`
          : `Order ${order.orderId} cancelled`,
        actor: null,
        href: `/sales/${order.id}`,
      });
    }
  }

  for (const payment of sources.payments) {
    entries.push({
      id: `payment:${payment.id}`,
      kind: 'PAYMENT_RECORDED',
      at: payment.recordedAt.toISOString(),
      summary: `Payment of ₹${payment.amount.toString()} recorded (${payment.method})`,
      actor: payment.recordedBy
        ? { userId: payment.recordedBy.id, name: payment.recordedBy.name }
        : null,
      href: `/sales/${payment.orderId}`,
    });
  }

  for (const refund of sources.refunds) {
    // Settled when there is a settlement date, requested otherwise. The status
    // travels in the summary so a pending refund is never read as money returned.
    const at = refund.settledAt ?? refund.requestedAt;
    entries.push({
      id: `refund:${refund.id}`,
      kind: 'REFUND_RECORDED',
      at: at.toISOString(),
      summary: `Refund of ₹${refund.amount.toString()} ${refund.status.toLowerCase()}`,
      actor: null,
      href: `/sales/${refund.orderId}`,
    });
  }

  for (const kase of sources.cases) {
    entries.push({
      id: `post-sales:${kase.id}`,
      kind: 'POST_SALES_CASE',
      at: kase.createdAt.toISOString(),
      summary: 'Post-sales case raised',
      actor: null,
      href: `/post-sales/cases/${kase.id}`,
    });
  }

  /*
    Ordered by the shared comparator rather than a sort written here: the rule
    is testable without a database that way, and there is one definition of it
    instead of one per caller. Newest first, total order — see
    `customer-timeline.ts` for why the tiebreakers are what they are.
  */
  const ordered = sortTimeline(entries);

  /*
    Which sources hit their cap. Reported rather than hidden: a profile that
    quietly dropped the oldest fifty payments would be telling the reader that
    those payments never happened.
  */
  const truncated: string[] = [];
  const check = (name: string, length: number) => {
    if (length >= TIMELINE_PER_SOURCE) truncated.push(name);
  };
  check('enquiries', sources.enquiries.length);
  check('enquiryEvents', sources.enquiryEvents.length);
  check('leads', sources.leads.length);
  check('leadActivities', sources.leadActivities.length);
  check('orders', sources.orders.length);
  check('payments', sources.payments.length);
  check('refunds', sources.refunds.length);
  check('postSalesCases', sources.cases.length);

  return { entries: ordered, truncated };
}
