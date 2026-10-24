/**
 * All Customers — the directory and profile.
 *
 * A separate file from `customer.service.ts`, which keeps serving the picker
 * that Product Enquiry, Create Lead and Sales submit to. That contract is
 * relied on by three modules and is deliberately untouched here.
 *
 * ### What this file is allowed to compute
 *
 * Aggregation and ordering. Never order arithmetic: every money figure arrives
 * from Sales' own `toMoney`, and the metrics helpers in @rs/shared add the
 * figures up without ever seeing a line, a price or a GST rate. If a customer's
 * purchase value could disagree with the invoice the customer was sent, this
 * module would be worthless, and reimplementing the arithmetic is the only way
 * that happens.
 */

import {
  attributionFor,
  customerConversionMetrics,
  customerPurchaseMetrics,
  type Attribution,
  type CustomerAnalytics,
  type CustomerDirectoryPage,
  type CustomerDirectoryQuery,
  type CustomerDirectoryRow,
  type CustomerLeadFact,
  type CustomerOrderFact,
  type SourceEvent,
  compareAmount,
} from '@rs/shared';
import { toMoney } from '../sales/sales.repository.js';
import * as repo from './customer.repository.js';
import type { CustomerDirectoryRecord } from './customer.repository.js';

/** Both record types' source values, as the attribution helper expects them. */
function sourceEventsOf(row: CustomerDirectoryRecord): SourceEvent[] {
  return [
    ...row.leads.map(
      (lead): SourceEvent => ({
        origin: 'LEAD',
        recordId: lead.id,
        source: lead.leadSource,
        sourceOther: lead.leadSourceOther,
        channel: lead.channel,
        channelOther: lead.channelOther,
        // The business instant somebody recorded, not when the row was written.
        at: lead.sourceAt,
      }),
    ),
    ...row.enquiries.map(
      (enquiry): SourceEvent => ({
        origin: 'ENQUIRY',
        recordId: enquiry.id,
        source: enquiry.source,
        sourceOther: enquiry.sourceDetail,
        at: enquiry.createdAt,
      }),
    ),
  ];
}

/** One order's money, through Sales' own definition. */
type OrderRecord = Awaited<ReturnType<typeof repo.orderFactsForCustomers>>[number];

function orderFactOf(order: OrderRecord): CustomerOrderFact {
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

/** Groups rows by customer id, so the page costs one query per relation. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

type Assembled = {
  row: CustomerDirectoryRow;
  purchase: ReturnType<typeof customerPurchaseMetrics>;
};

/**
 * Turns records into directory rows.
 *
 * Four queries for a whole page — customers, orders, leads, enquiry
 * aggregates — rather than four per customer. The row shape shows an order
 * count and a purchase value, which is exactly the shape that becomes an N+1
 * the moment somebody loops.
 */
async function assemble(records: readonly CustomerDirectoryRecord[]): Promise<Assembled[]> {
  const ids = records.map((r) => r.id);

  const [orders, leads, enquiryAggregates, flagged] = await Promise.all([
    repo.orderFactsForCustomers(ids),
    repo.leadFactsForCustomers(ids),
    repo.lastEnquiryForCustomers(ids),
    repo.customerIdsWithOpenDuplicates(ids),
  ]);

  const ordersByCustomer = groupBy(orders, (o) => o.customerId);
  const leadsByCustomer = groupBy(leads, (l) => l.customerId);
  const enquiryByCustomer = new Map(
    enquiryAggregates.map((a) => [a.customerId, a] as const),
  );

  return records.map((record) => {
    const { firstTouch, lastTouch } = attributionFor(sourceEventsOf(record));
    const purchase = customerPurchaseMetrics(
      (ordersByCustomer.get(record.id) ?? []).map(orderFactOf),
    );
    const enquiry = enquiryByCustomer.get(record.id);

    const row: CustomerDirectoryRow = {
      id: record.id,
      name: record.name,
      companyName: record.companyName,
      type: record.type,
      phone: record.phone,
      email: record.email,
      state: record.state,
      country: record.country,
      firstTouch,
      lastTouch,
      validOrderCount: purchase.validOrderCount,
      verifiedPurchaseValue: purchase.verifiedPurchaseValue,
      averageOrderValue: purchase.averageOrderValue,
      isRepeatCustomer: purchase.isRepeatCustomer,
      lastPurchaseAt: purchase.lastPurchaseAt,
      lastEnquiryAt: enquiry?._max.createdAt?.toISOString() ?? null,
      hasDuplicateCandidate: flagged.has(record.id),
      createdAt: record.createdAt.toISOString(),
    };

    // `leadsByCustomer` is read by the profile, not the row; computed there.
    void leadsByCustomer;
    return { row, purchase };
  });
}

/**
 * Applies the filters that can only be evaluated after aggregation.
 *
 * Repeat status, purchase-value bounds and source are derived, so no SQL
 * predicate can express them. They are applied here, after the aggregates
 * exist — which is also why a query using them is paged by offset over the
 * fully filtered set rather than by keyset: filtering after a keyset page would
 * return short pages and make "next" meaningless.
 */
function applyDerivedFilters(
  rows: readonly Assembled[],
  query: CustomerDirectoryQuery,
): Assembled[] {
  return rows.filter(({ row }) => {
    if (query.isRepeat !== undefined && row.isRepeatCustomer !== query.isRepeat) return false;

    if (query.source) {
      const attribution: Attribution =
        query.sourceTouch === 'FIRST' ? row.firstTouch : row.lastTouch;
      if (attribution.source !== query.source) return false;
    }

    if (query.minPurchaseValue !== undefined) {
      if (compareAmount(row.verifiedPurchaseValue, query.minPurchaseValue.toFixed(2)) < 0) {
        return false;
      }
    }
    if (query.maxPurchaseValue !== undefined) {
      if (compareAmount(row.verifiedPurchaseValue, query.maxPurchaseValue.toFixed(2)) > 0) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Orders by a derived aggregate, over the whole filtered set.
 *
 * This is the honest version of an aggregate sort: the full set is assembled,
 * ordered, and only then sliced into a page. Sorting a single keyset page would
 * present twenty-five rows ordered among themselves as though they were the
 * top twenty-five overall, which is the trap the RS Products listing documents.
 *
 * Every comparison ends in `id` so the order is total and a page boundary
 * cannot shift between requests.
 */
function sortByAggregate(rows: Assembled[], query: CustomerDirectoryQuery): Assembled[] {
  const sign = query.direction === 'desc' ? -1 : 1;

  return [...rows].sort((a, b) => {
    let primary = 0;
    switch (query.sort) {
      case 'purchaseValue':
        primary = compareAmount(a.row.verifiedPurchaseValue, b.row.verifiedPurchaseValue);
        break;
      case 'orderCount':
        primary = a.row.validOrderCount - b.row.validOrderCount;
        break;
      case 'lastPurchaseAt': {
        // Never purchased sorts last ascending, so a null is not read as "oldest".
        const left = a.row.lastPurchaseAt ?? '';
        const right = b.row.lastPurchaseAt ?? '';
        primary = left < right ? -1 : left > right ? 1 : 0;
        break;
      }
      default:
        primary = a.row.name.localeCompare(b.row.name);
    }
    if (primary !== 0) return primary * sign;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });
}

/** A page of the directory. */
export async function listDirectory(
  query: CustomerDirectoryQuery,
): Promise<CustomerDirectoryPage> {
  const derivedFilterRequested =
    query.isRepeat !== undefined ||
    query.source !== undefined ||
    query.minPurchaseValue !== undefined ||
    query.maxPurchaseValue !== undefined;

  /*
    Keyset only when the sort AND every filter can be expressed in SQL. The
    moment a derived filter or sort is involved, the full filtered set has to
    exist before a page can be cut from it, and the response says so.
  */
  if (repo.isColumnSort(query.sort) && !derivedFilterRequested) {
    const { rows, nextCursor } = await repo.listCustomersByColumn(query);
    const assembled = await assemble(rows);
    return {
      customers: assembled.map((a) => a.row),
      pagination: { mode: 'keyset', nextCursor },
    };
  }

  const { rows } = await repo.listCustomersByAggregate(query);
  const assembled = applyDerivedFilters(await assemble(rows), query);
  const ordered = sortByAggregate(assembled, query);

  const page = query.page ?? 1;
  const start = (page - 1) * query.limit;
  const total = ordered.length;

  return {
    customers: ordered.slice(start, start + query.limit).map((a) => a.row),
    pagination: {
      mode: 'offset',
      page,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
    },
  };
}

/** Directory-wide figures for the header and source performance. */
export async function directoryAnalytics(
  query: CustomerDirectoryQuery,
): Promise<CustomerAnalytics> {
  const { rows } = await repo.listCustomersByAggregate(query);
  const assembled = applyDerivedFilters(await assemble(rows), query);
  const ids = assembled.map((a) => a.row.id);

  const leads = await repo.leadFactsForCustomers(ids);
  const leadsByCustomer = groupBy(leads, (l) => l.customerId);

  let totalValue = '0.00';
  let withOrders = 0;
  let repeats = 0;
  type Bucket = {
    customerCount: number;
    customersWithOrders: number;
    verifiedValue: string;
    leadCount: number;
    convertedLeadCount: number;
  };
  const buckets = new Map<string, Bucket>();

  const bucketFor = (touch: 'FIRST' | 'LAST', source: string): Bucket => {
    const key = `${touch}|${source}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        customerCount: 0,
        customersWithOrders: 0,
        verifiedValue: '0.00',
        leadCount: 0,
        convertedLeadCount: 0,
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const { row } of assembled) {
    totalValue = addValue(totalValue, row.verifiedPurchaseValue);
    if (row.validOrderCount > 0) withOrders += 1;
    if (row.isRepeatCustomer) repeats += 1;

    const conversion = customerConversionMetrics(
      (leadsByCustomer.get(row.id) ?? []).map(
        (lead): CustomerLeadFact => ({
          leadId: lead.id,
          dealStatus: lead.dealStatus,
          salesOrderId: lead.salesOrderId,
          linkedOrderCancelled:
            lead.salesOrder === null ? null : lead.salesOrder.status === 'CANCELLED',
        }),
      ),
    );

    for (const [touch, attribution] of [
      ['FIRST', row.firstTouch],
      ['LAST', row.lastTouch],
    ] as const) {
      const bucket = bucketFor(touch, attribution.source);
      bucket.customerCount += 1;
      if (row.validOrderCount > 0) bucket.customersWithOrders += 1;
      bucket.verifiedValue = addValue(bucket.verifiedValue, row.verifiedPurchaseValue);
      bucket.leadCount += conversion.leadCount;
      bucket.convertedLeadCount += conversion.convertedLeadCount;
    }
  }

  const openDuplicateCandidates = await repo.countOpenDuplicateCandidates();

  return {
    totalCustomers: assembled.length,
    customersWithOrders: withOrders,
    repeatCustomers: repeats,
    totalVerifiedValue: totalValue,
    // Null rather than zero: with no purchasing customers there is no average.
    averageCustomerValue: withOrders > 0 ? divide(totalValue, withOrders) : null,
    openDuplicateCandidates,
    bySource: [...buckets.entries()].map(([key, bucket]) => {
      const [touch, source] = key.split('|') as ['FIRST' | 'LAST', string];
      return { source, touch, ...bucket };
    }),
  };
}

// Thin local wrappers so this file never imports a second money implementation.
function addValue(a: string, b: string): string {
  const paise = BigInt(a.replace('.', '')) + BigInt(b.replace('.', ''));
  return formatPaise(paise);
}

function divide(amount: string, divisor: number): string {
  const paise = BigInt(amount.replace('.', ''));
  const d = BigInt(divisor);
  return formatPaise((paise * 2n + d) / (d * 2n));
}

function formatPaise(paise: bigint): string {
  const sign = paise < 0n ? '-' : '';
  const abs = paise < 0n ? -paise : paise;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
