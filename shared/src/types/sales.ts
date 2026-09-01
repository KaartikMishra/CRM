/**
 * Response contracts for the Sales Order API.
 *
 * These describe what actually crosses the wire, which is not the Prisma row:
 * `DateTime` arrives as an ISO string and `Decimal` as a decimal string, never
 * a float (§7). The frontend types against these rather than against the
 * database models, so the two tiers cannot drift.
 */

import type {
  SalesChangeStatus,
  SalesChangeType,
  SalesEfficiency,
  SalesItemStatus,
  SalesOrderStatus,
} from '../enums.js';
import type {
  CustomerContactRef,
  CustomerRef,
  DecimalString,
  IsoDateTime,
  MediaRef,
  UserRef,
} from './enquiry.js';

/** One product line on an order. */
export type SalesOrderItemView = {
  id: string;
  lineNo: number;
  productName: string;
  image: MediaRef | null;
  quantity: number;
  price: DecimalString;
  /** quantity × price, derived by the API. */
  lineTotal: DecimalString;
  status: SalesItemStatus;
  /** Who put this line forward. */
  proposedBy: UserRef;
  /** Set only where a proposal was actually approved; null for original lines. */
  approvedBy: UserRef | null;
  approvedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
};

/**
 * The money on an order, grouped so the UI reads one object.
 *
 * Only `paid` is stored. `total` is the sum of the order's ACTIVE line totals
 * and `pending` is total − paid, both derived by the API — they exist in no
 * database column, which is precisely why they cannot be edited. The client
 * renders them; it never computes the authoritative value, and it never parses
 * any of these back into a number for arithmetic.
 */
export type SalesMoneyView = {
  /** Sum of the ACTIVE line totals. Excludes anything awaiting approval. */
  total: DecimalString;
  paid: DecimalString;
  /** total − paid */
  pending: DecimalString;
  /** True once the order is settled in full. Saves the UI a string comparison. */
  fullyPaid: boolean;
  currency: string;
  activeItemCount: number;
  /** How many lines are waiting on an approver. */
  pendingApprovalCount: number;
  /** What those waiting lines would add to the total once approved. */
  pendingApprovalTotal: DecimalString;
};

/** The list row — enough to render a table, no nested collections. */
export type SalesOrderSummary = {
  /** Internal record id. This is what the row links to, never orderId. */
  id: string;
  /** The human-facing, manually entered number. */
  orderId: string;
  customer: CustomerRef;
  /** The first active line's product, for the table's description column. */
  leadProductName: string;
  thumbnail: MediaRef | null;
  money: SalesMoneyView;
  status: SalesOrderStatus;
  /** Null until the order is dispatched, then frozen. */
  efficiency: SalesEfficiency | null;
  orderDate: IsoDateTime;
  toBeDispatchedBy: IsoDateTime;
  dispatchedAt: IsoDateTime | null;
  /** Derived, not stored: still open and past its dispatch deadline. */
  overdue: boolean;
  updatedAt: IsoDateTime;
};

/**
 * A proposed change to the order's products.
 *
 * Carries both sides for an EDIT — `current` is the line as it stands right
 * now, `proposed` is what was asked for — so the UI can render CURRENT →
 * PROPOSED without a second lookup, and so a reader can see what a rejected
 * request would have done.
 *
 * None of this is counted anywhere. It is a request, not a product.
 */
export type SalesChangeRequestView = {
  id: string;
  type: SalesChangeType;
  status: SalesChangeStatus;
  /** The line this acts on. Null for ADD, which has no line yet. */
  current: {
    id: string;
    lineNo: number;
    productName: string;
    image: MediaRef | null;
    quantity: number;
    price: DecimalString;
    lineTotal: DecimalString;
  } | null;
  /** What was asked for. Null for REMOVE, which proposes no values. */
  proposed: {
    productName: string;
    image: MediaRef | null;
    quantity: number;
    price: DecimalString;
    lineTotal: DecimalString;
  } | null;
  requestedBy: UserRef;
  requestedAt: IsoDateTime;
  reviewedBy: UserRef | null;
  reviewedAt: IsoDateTime | null;
  reviewNote: string | null;
};

/** The detail payload — everything the details page needs, in one call. */
export type SalesOrderDetail = {
  id: string;
  orderId: string;
  /** Detail carries the contact details; the list row deliberately does not. */
  customer: CustomerContactRef;
  /** The order's actual products, ordered by line number. All are active. */
  items: SalesOrderItemView[];
  /** Proposals against those products: pending first, then decided history. */
  changeRequests: SalesChangeRequestView[];
  money: SalesMoneyView;
  status: SalesOrderStatus;
  efficiency: SalesEfficiency | null;
  orderDate: IsoDateTime;
  toBeDispatchedBy: IsoDateTime;
  dispatchedAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
  closedBy: UserRef | null;
  overdue: boolean;
  createdBy: UserRef;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};
