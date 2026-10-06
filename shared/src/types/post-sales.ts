/**
 * Response contracts for Post Sales & Grievance — Phase 1.
 *
 * These describe what crosses the wire, which is not the Prisma row: DateTime
 * arrives as an ISO string, money as a decimal string, and every related entity
 * travels as a narrow reference rather than as copied fields. A case never
 * restates a customer, an order or a product — it points at them, so it cannot
 * disagree with the canonical record.
 */

import type {
  PostSalesActivityKind,
  PostSalesAttachmentKind,
  PostSalesCaseStatus,
  PostSalesCaseType,
  PostSalesCommunicationChannel,
  PostSalesCommunicationDirection,
  PostSalesIssueCategory,
  PostSalesPriority,
} from '../enums.js';
import type {
  CustomerView,
  DecimalString,
  IsoDateTime,
  MediaRef,
  UserRef,
} from './enquiry.js';

/** The order a case is about, as much of it as a case screen shows. */
export type PostSalesOrderRef = {
  id: string;
  /** The hand-entered business id, e.g. `rsm_5675`. */
  orderId: string;
  status: string;
  orderDate: IsoDateTime;
  /** Derived through Sales' own `toMoney`; never a figure stored on the case. */
  total: DecimalString;
  paidAmount: DecimalString;
};

/** One affected line, with its product identity drawn from the line itself. */
export type PostSalesCaseItemView = {
  id: string;
  affectedQty: number;
  salesOrderItem: {
    id: string;
    lineNo: number;
    /** As written on the order line. */
    productName: string;
    /** How many were bought, against which `affectedQty` is a subset. */
    quantity: number;
    /** The catalogue product, where the line names one. */
    rsProduct: { id: string; title: string; sku: string | null } | null;
    image: MediaRef | null;
  };
};

/**
 * One timeline entry.
 *
 * `channel` and `direction` are populated only for a CUSTOMER_COMMUNICATION;
 * `dueAt` and `completedAt` only mean something on a FOLLOW_UP. `performedBy` is
 * null for the three kinds the service writes itself.
 */
export type PostSalesActivityView = {
  id: string;
  kind: PostSalesActivityKind;
  note: string;
  channel: PostSalesCommunicationChannel | null;
  direction: PostSalesCommunicationDirection | null;
  dueAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  performedBy: UserRef | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type PostSalesAttachmentView = {
  id: string;
  kind: PostSalesAttachmentKind;
  /** Null when the underlying asset was removed; the link survives as history. */
  media: MediaRef | null;
  uploadedBy: UserRef | null;
  createdAt: IsoDateTime;
};

/**
 * One case in full, as the detail page needs it.
 *
 * Everything the page draws arrives on one read — customer, order, affected
 * lines, timeline and attachments — so a case with ten activities is one round
 * trip rather than eleven.
 */
export type PostSalesCaseView = {
  id: string;
  /** `PS-2026-000001`. The business-facing id; `id` stays the internal key. */
  caseNumber: string;

  customer: CustomerView;
  /** Null when the case needs no order — a care question, a suggestion. */
  order: PostSalesOrderRef | null;
  /** Only populated for delivery-shaped cases. Read-only. */
  dispatch: { id: string; status: string; awb: string | null } | null;

  caseType: PostSalesCaseType;
  issueCategory: PostSalesIssueCategory;
  priority: PostSalesPriority;
  status: PostSalesCaseStatus;

  subject: string;
  description: string;

  assignedTo: UserRef | null;
  raisedBy: UserRef;

  resolvedAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;

  items: PostSalesCaseItemView[];
  activities: PostSalesActivityView[];
  attachments: PostSalesAttachmentView[];

  /**
   * Where this case may go next, from the shared transition map.
   *
   * Sent rather than derived in the browser so the form offers exactly what the
   * service will accept — one definition of the lifecycle, not two.
   */
  nextStatuses: PostSalesCaseStatus[];

  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

/**
 * One row of the case board.
 *
 * Deliberately NOT the full `PostSalesCaseView`: that embeds the whole timeline
 * and the complete customer record, and fifty of those is a payload nobody reads.
 * This is the board's columns and what it takes to render them.
 */
export type PostSalesCaseRow = {
  id: string;
  caseNumber: string;

  customer: { id: string; name: string; phone: string | null; email: string | null };
  /** The business order id, for the Order column. Null when there is no order. */
  orderId: string | null;

  caseType: PostSalesCaseType;
  issueCategory: PostSalesIssueCategory;
  priority: PostSalesPriority;
  status: PostSalesCaseStatus;

  assignedTo: UserRef | null;

  /** The first affected product, plus a count — the board shows one, not twelve. */
  product: { name: string; more: number } | null;

  /**
   * When anything last happened on this case.
   *
   * The latest activity's `createdAt`, falling back to the case's own. Derived
   * from rows the same batched query already fetched — no column stores it, and
   * the board therefore cannot sort by it (see POST_SALES_SORTS).
   */
  lastActivityAt: IsoDateTime;

  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type PostSalesCasePage = {
  cases: PostSalesCaseRow[];
  nextCursor: string | null;
};

/**
 * The overview counts.
 *
 * Only what the core case system can answer honestly. No return rate, refund
 * rate, SLA breach or CSAT — those need data Phase 1 does not hold, and a
 * plausible-looking zero would be worse than an absent tile.
 */
export type PostSalesOverview = {
  total: number;
  open: number;
  newToday: number;
  assignedToMe: number;
  critical: number;
  resolvedToday: number;
  reopened: number;
  unassigned: number;
};

/** One audit entry on a case, for the history panel. */
export type PostSalesAuditEntry = {
  id: string;
  action: string;
  actor: UserRef | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: IsoDateTime;
};
