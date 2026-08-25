/**
 * All Prisma access for Product Enquiry, plus the mappers that turn rows into
 * the wire contract in @rs/shared.
 *
 * Two shapes exist deliberately (§33): the list selects a flat summary with
 * counts, and the detail selects the nested tree. Neither uses a bare `include`
 * of everything, so listing 25 enquiries never drags 500 vendor responses along
 * with it, and nothing here can accidentally return a password hash.
 *
 * Decimals leave as strings and dates as ISO strings — never floats (§7).
 */

import { Prisma } from '@rs/database';
import { prisma } from '../../config/database.js';
import type {
  CustomerRef,
  DelayRecordView,
  DimensionView,
  EnquiryDetail,
  EnquiryEventView,
  EnquiryListQuery,
  EnquiryProductView,
  EnquirySlaView,
  EnquirySummary,
  MediaRef,
  UserRef,
  VendorResponseView,
  WeightView,
} from '@rs/shared';
import { isBreached } from './enquiry-sla.service.js';

// ---------------------------------------------------------------------------
//  Select shapes
// ---------------------------------------------------------------------------

const userRef = { id: true, name: true, employeeId: true, role: true } as const;
const customerRef = { id: true, name: true, type: true } as const;
const mediaRef = { id: true, secureUrl: true, publicId: true } as const;

const slaFields = {
  slaMinutes: true,
  createdAt: true,
  slaDeadlineAt: true,
  firstSubmitAt: true,
  responseSeconds: true,
  efficiency: true,
} as const;

const summarySelect = {
  id: true,
  enquiryNo: true,
  source: true,
  status: true,
  updatedAt: true,
  ...slaFields,
  customer: { select: customerRef },
  assignedTo: { select: userRef },
  createdBy: { select: userRef },
  _count: { select: { products: true } },
  products: {
    orderBy: { lineNo: 'asc' },
    select: { status: true, image: { select: mediaRef } },
  },
} satisfies Prisma.ProductEnquirySelect;

const detailSelect = {
  id: true,
  enquiryNo: true,
  source: true,
  sourceDetail: true,
  status: true,
  partialSubmittedAt: true,
  closedAt: true,
  updatedAt: true,
  ...slaFields,
  customer: { select: customerRef },
  assignedTo: { select: userRef },
  createdBy: { select: userRef },
  closedBy: { select: userRef },
  products: {
    orderBy: { lineNo: 'asc' },
    select: {
      id: true,
      lineNo: true,
      name: true,
      quantity: true,
      similarOptionNeeded: true,
      status: true,
      noVendorReason: true,
      weightValue: true,
      weightUnit: true,
      weightInGrams: true,
      lengthValue: true,
      widthValue: true,
      heightValue: true,
      dimensionUnit: true,
      image: { select: mediaRef },
      vendorResponses: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          matchType: true,
          ratePerUnit: true,
          currency: true,
          deliveryWithinDays: true,
          deliveryNote: true,
          notes: true,
          createdAt: true,
          weightValue: true,
          weightUnit: true,
          weightInGrams: true,
          lengthValue: true,
          widthValue: true,
          heightValue: true,
          dimensionUnit: true,
          vendor: { select: { id: true, name: true } },
          image: { select: mediaRef },
          createdBy: { select: userRef },
        },
      },
    },
  },
  events: {
    orderBy: { occurredAt: 'desc' },
    take: 200,
    select: {
      id: true,
      type: true,
      field: true,
      oldValue: true,
      newValue: true,
      occurredAt: true,
      actor: { select: userRef },
    },
  },
  delays: {
    orderBy: { submittedAt: 'desc' },
    select: {
      id: true,
      reason: true,
      deadlineAt: true,
      detectedAt: true,
      minutesLate: true,
      submittedAt: true,
      submittedBy: { select: userRef },
    },
  },
} satisfies Prisma.ProductEnquirySelect;

type SummaryRow = Prisma.ProductEnquiryGetPayload<{ select: typeof summarySelect }>;
type DetailRow = Prisma.ProductEnquiryGetPayload<{ select: typeof detailSelect }>;

// ---------------------------------------------------------------------------
//  Mappers
// ---------------------------------------------------------------------------

const iso = (d: Date): string => d.toISOString();
const dec = (d: Prisma.Decimal | null): string | null => (d === null ? null : d.toString());

function toWeight(row: {
  weightValue: Prisma.Decimal | null;
  weightUnit: WeightView['unit'] | null;
  weightInGrams: Prisma.Decimal | null;
}): WeightView | null {
  if (row.weightValue === null || row.weightUnit === null) return null;
  return {
    value: row.weightValue.toString(),
    unit: row.weightUnit,
    inGrams: dec(row.weightInGrams) ?? '0',
  };
}

function toDimension(row: {
  lengthValue: Prisma.Decimal | null;
  widthValue: Prisma.Decimal | null;
  heightValue: Prisma.Decimal | null;
  dimensionUnit: DimensionView['unit'] | null;
}): DimensionView | null {
  if (
    row.lengthValue === null ||
    row.widthValue === null ||
    row.heightValue === null ||
    row.dimensionUnit === null
  ) {
    return null;
  }
  return {
    length: row.lengthValue.toString(),
    width: row.widthValue.toString(),
    height: row.heightValue.toString(),
    unit: row.dimensionUnit,
  };
}

function toSla(row: DetailRow | SummaryRow, now: Date): EnquirySlaView {
  return {
    slaMinutes: row.slaMinutes,
    createdAt: iso(row.createdAt),
    slaDeadlineAt: iso(row.slaDeadlineAt),
    firstSubmitAt: row.firstSubmitAt ? iso(row.firstSubmitAt) : null,
    responseSeconds: row.responseSeconds,
    efficiency: row.efficiency,
    breached: isBreached(now, row.slaDeadlineAt, row.firstSubmitAt),
  };
}

function toSummary(row: SummaryRow, now: Date): EnquirySummary {
  const thumbnail = row.products.find((p) => p.image !== null)?.image ?? null;

  return {
    id: row.id,
    enquiryNo: row.enquiryNo,
    customer: row.customer as CustomerRef,
    source: row.source,
    status: row.status,
    assignedTo: row.assignedTo as UserRef,
    createdBy: row.createdBy as UserRef,
    productCount: row._count.products,
    respondedCount: row.products.filter((p) => p.status !== 'PENDING').length,
    sla: toSla(row, now),
    thumbnail: thumbnail as MediaRef | null,
    updatedAt: iso(row.updatedAt),
  };
}

function toVendorResponse(
  r: DetailRow['products'][number]['vendorResponses'][number],
): VendorResponseView {
  return {
    id: r.id,
    vendor: r.vendor,
    matchType: r.matchType,
    ratePerUnit: r.ratePerUnit.toString(),
    currency: r.currency,
    deliveryWithinDays: r.deliveryWithinDays,
    deliveryNote: r.deliveryNote,
    weight: toWeight(r),
    dimension: toDimension(r),
    image: r.image as MediaRef | null,
    notes: r.notes,
    createdBy: r.createdBy as UserRef,
    createdAt: iso(r.createdAt),
  };
}

function toProduct(p: DetailRow['products'][number]): EnquiryProductView {
  return {
    id: p.id,
    lineNo: p.lineNo,
    name: p.name,
    quantity: p.quantity,
    image: p.image as MediaRef | null,
    weight: toWeight(p),
    dimension: toDimension(p),
    similarOptionNeeded: p.similarOptionNeeded,
    status: p.status,
    noVendorReason: p.noVendorReason,
    vendorResponses: p.vendorResponses.map(toVendorResponse),
  };
}

function toDetail(row: DetailRow, now: Date): EnquiryDetail {
  return {
    id: row.id,
    enquiryNo: row.enquiryNo,
    customer: row.customer as CustomerRef,
    source: row.source,
    sourceDetail: row.sourceDetail,
    status: row.status,
    assignedTo: row.assignedTo as UserRef,
    createdBy: row.createdBy as UserRef,
    closedBy: (row.closedBy as UserRef | null) ?? null,
    closedAt: row.closedAt ? iso(row.closedAt) : null,
    partialSubmittedAt: row.partialSubmittedAt ? iso(row.partialSubmittedAt) : null,
    sla: toSla(row, now),
    products: row.products.map(toProduct),
    events: row.events.map(
      (e): EnquiryEventView => ({
        id: e.id,
        type: e.type,
        actor: (e.actor as UserRef | null) ?? null,
        field: e.field,
        oldValue: e.oldValue,
        newValue: e.newValue,
        occurredAt: iso(e.occurredAt),
      }),
    ),
    delays: row.delays.map(
      (d): DelayRecordView => ({
        id: d.id,
        reason: d.reason,
        deadlineAt: iso(d.deadlineAt),
        detectedAt: iso(d.detectedAt),
        minutesLate: d.minutesLate,
        submittedBy: d.submittedBy as UserRef,
        submittedAt: iso(d.submittedAt),
      }),
    ),
    updatedAt: iso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
//  Queries
// ---------------------------------------------------------------------------

/** The minimum needed to make an access decision — no nested loads. */
export type EnquiryForPolicy = {
  id: string;
  status: EnquiryDetail['status'];
  createdById: string;
  assignedToId: string;
  createdAt: Date;
  slaDeadlineAt: Date;
  firstSubmitAt: Date | null;
  slaMinutes: number;
};

export function findForPolicy(
  id: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<EnquiryForPolicy | null> {
  return client.productEnquiry.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      createdById: true,
      assignedToId: true,
      createdAt: true,
      slaDeadlineAt: true,
      firstSubmitAt: true,
      slaMinutes: true,
    },
  });
}

export async function findDetail(id: string, now: Date): Promise<EnquiryDetail | null> {
  const row = await prisma.productEnquiry.findUnique({ where: { id }, select: detailSelect });
  return row ? toDetail(row, now) : null;
}

export type ListResult = {
  items: EnquirySummary[];
  nextCursor: string | null;
};

/**
 * §10/§33 — server-side filtering with keyset pagination.
 *
 * Keyset rather than offset so page 40 costs the same as page 1, and the tie
 * breaker is the cuid primary key so a stable order survives equal sort values.
 */
export async function list(query: EnquiryListQuery, now: Date): Promise<ListResult> {
  const where: Prisma.ProductEnquiryWhereInput = {};

  if (query.status) where.status = query.status;
  if (query.assignedToId) where.assignedToId = query.assignedToId;
  if (query.customerId) where.customerId = query.customerId;
  if (query.efficiency) where.efficiency = query.efficiency;

  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }

  // §46 — breached with nothing submitted, which is not the same as DELAYED.
  if (query.neverResponded) {
    where.firstSubmitAt = null;
    where.slaDeadlineAt = { lt: now };
  }

  if (query.q) {
    where.OR = [
      { enquiryNo: { contains: query.q, mode: 'insensitive' } },
      { customer: { name: { contains: query.q, mode: 'insensitive' } } },
      { products: { some: { name: { contains: query.q, mode: 'insensitive' } } } },
    ];
  }

  const rows = await prisma.productEnquiry.findMany({
    where,
    select: summarySelect,
    orderBy: [{ [query.sortBy]: query.sortDir }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: page.map((row) => toSummary(row, now)),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Serialises concurrent mutations of one enquiry.
 *
 * Conditional updates protect individual columns, but a workflow action reads
 * state and then acts on it, and two requests can interleave between those two
 * steps. The row lock makes them queue, so the second one sees what the first
 * one did — which is how two simultaneous Full Submits become one success and
 * one honest ENQUIRY_CLOSED.
 */
export async function lockEnquiry(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "ProductEnquiry" WHERE "id" = ${id} FOR UPDATE`;
}

/**
 * §26 — a product is only ever reached through its enquiry. Looking it up by id
 * alone would let a caller touch a line belonging to someone else's enquiry.
 */
export function findProductInEnquiry(
  tx: Prisma.TransactionClient,
  enquiryId: string,
  productId: string,
) {
  return tx.enquiryProduct.findFirst({
    where: { id: productId, enquiryId },
    select: {
      id: true,
      lineNo: true,
      name: true,
      status: true,
      noVendorReason: true,
      quantity: true,
    },
  });
}
