import type {
  FulfillmentStatus,
  PurchaseBillStatus,
  PurchaseBillType,
} from '../enums.js';

/**
 * What the Purchase & Procurement API returns.
 *
 * Every quantity below is computed by the server from the ledger — none is
 * stored as a column that could disagree with the rows it summarises. Money is
 * a decimal string end to end; no float touches a rate or a line total.
 */

export type ProductView = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  /** Physically in the warehouse. */
  onHand: number;
  createdAt: string;
};

/** A vendor as procurement shows it — the existing master, not a new one. */
export type ProcurementVendorView = {
  id: string;
  name: string;
};

export type PurchaseBillItemView = {
  id: string;
  lineNo: number;
  /** What the vendor's bill calls it — always present. */
  productName: string;
  /** The catalogue entry, once linked. Null until then; stock cannot be
   *  allocated from an unlinked line. */
  product: ProductView | null;
  orderedQty: number;
  receivedQty: number;
  rate: string;
  /** receivedQty × rate, as an exact decimal string. */
  lineTotal: string;
  /**
   * Received but not yet assigned to any order: receivedQty − Σ allocations.
   * This is the pool a new allocation draws from.
   */
  standingQty: number;
  allocatedQty: number;
  productImage: { id: string; secureUrl: string } | null;
  allocations: AllocationView[];
};

export type AllocationView = {
  id: string;
  quantity: number;
  salesOrderItemId: string;
  /** Enough of the order to make the allocation legible without a second call. */
  order: { id: string; orderId: string; customerName: string };
  productName: string;
  /** True once the order line's requirement is fully met; USER cannot edit it. */
  frozen: boolean;
  createdAt: string;
};

export type PurchaseBillSummary = {
  id: string;
  billNumber: string;
  vendor: ProcurementVendorView;
  billType: PurchaseBillType;
  status: PurchaseBillStatus;
  billDate: string;
  expectedBy: string | null;
  isDelayed: boolean;
  itemCount: number;
  /** Σ receivedQty × rate across the bill's lines. */
  billTotal: string;
  totalStandingQty: number;
  createdAt: string;
};

export type PurchaseBillDetail = Omit<PurchaseBillSummary, 'itemCount'> & {
  delayReason: string | null;
  notes: string | null;
  billImage: { id: string; secureUrl: string } | null;
  items: PurchaseBillItemView[];
  createdBy: { id: string; name: string };
  updatedAt: string;
};

/**
 * One line of an order, with the arithmetic procurement actually needs.
 *
 *   required  = the quantity ordered
 *   fromStock = what warehouse inventory can cover right now
 *   allocated = what purchased stock has already been assigned
 *   pending   = required − fromStock − allocated, floored at zero
 *
 * `productId` is nullable because a line written before the product master
 * existed has no catalogue entry. Such a line reports `linked: false` and
 * cannot be allocated against — it is shown rather than hidden, so the gap is
 * visible instead of mysterious.
 */
export type OrderLineRequirement = {
  salesOrderItemId: string;
  lineNo: number;
  productName: string;
  productId: string | null;
  linked: boolean;
  requiredQty: number;
  /** Supplied outside procurement, recorded by hand. */
  alreadyFulfilled: number;
  /** Supplied through procurement — the sum of this line's allocations. */
  allocatedQty: number;
  /** alreadyFulfilled + allocatedQty. Derived, never stored. */
  totalFulfilled: number;
  /**
   * Warehouse stock for the product. Informational only: it is shared across
   * every order, so it is never counted against one customer's requirement.
   */
  availableInInventory: number;
  pendingQty: number;
  status: FulfillmentStatus;
  /** True when pendingQty is 0 — the mapping is frozen for USER. */
  frozen: boolean;
};

/**
 * One customer requirement, as the SALES board shows it.
 *
 * Flattened across orders so procurement can see at a glance which customer is
 * causing a shortage, rather than opening each order in turn.
 */
export type SalesRequirementRow = {
  salesOrderItemId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  productName: string;
  productId: string | null;
  linked: boolean;
  requiredQty: number;
  alreadyFulfilled: number;
  procurementFulfilled: number;
  totalFulfilled: number;
  unfulfilledQty: number;
  status: FulfillmentStatus;
  /**
   * The IST calendar day this line was last supplied against, as YYYY-MM-DD.
   *
   * Derived, never stored: the later of the last recorded `alreadyFulfilled`
   * edit and the last allocation against the line. Null while a line is
   * untouched — an UNFULFILLED line has no fulfilment date, and inventing one
   * from the order's own dates would be a guess presented as a fact.
   */
  fulfilledOn: string | null;
};

/** An order looked up by its human-entered number, with its requirements. */
export type OrderRequirementView = {
  orderId: string;
  id: string;
  customer: { id: string; name: string };
  orderDate: string;
  status: string;
  lines: OrderLineRequirement[];
};

/** The shortage board: what is still needed across every open order. */
export type ShortageRow = {
  /**
   * What to call this requirement. For a catalogue-linked row it is the
   * Product's name; for a free-text row it is the exact string on the order
   * line, aggregated verbatim and never normalised.
   */
  productName: string;
  /**
   * The catalogue entry, when there is one.
   *
   * Null for demand that exists only as free text on an order line — legacy
   * rows, or goods nobody has catalogued yet. Such demand is real and must be
   * bought, so it appears here; it simply cannot take part in inventory
   * operations until somebody links it, which is what `linked: false` tells
   * the reader.
   */
  product: ProductView | null;
  linked: boolean;
  totalRequired: number;
  totalAllocated: number;
  /** Always 0 for an unlinked row: there is no InventoryItem to read. */
  onHand: number;
  /** What procurement still has to buy. */
  shortageQty: number;
  /** Received-but-unassigned stock that could cover part of the shortage. */
  standingQty: number;
};

/**
 * Where one order line's fulfilment actually came from.
 *
 * The board answers "how much is still owed"; this answers "and who supplied
 * the rest". One allocation per source, never pooled: two bills from two
 * vendors are two rows, because "which vendor supplied these units" is the
 * question the view exists to answer.
 */
export type FulfillmentSource = {
  allocationId: string;
  allocatedQty: number;
  allocatedAt: string;
  /** The purchase line the stock came off, in the vendor's own wording. */
  purchaseLine: {
    id: string;
    productName: string;
    orderedQty: number;
    receivedQty: number;
    rate: string;
    lineTotal: string;
    /** receivedQty − every allocation on that line, not just this one. */
    standingQty: number;
  };
  bill: {
    id: string;
    billNumber: string;
    billType: PurchaseBillType;
    status: PurchaseBillStatus;
    billDate: string;
    expectedBy: string | null;
  };
  /** Whoever the bill was raised against. `null` is impossible — a bill
   *  always has a vendor — but the fields inside it are optional. */
  vendor: {
    id: string;
    name: string;
    contactPerson: string | null;
    phone: string | null;
    email: string | null;
    city: string | null;
    isActive: boolean;
  };
};

/** One dated thing that happened, for the popup's activity strip. */
export type FulfillmentEvent = {
  at: string;
  label: string;
  detail: string | null;
};

/**
 * Everything the History detail view shows for one order line.
 *
 * The arithmetic is the server's own — the same helpers the board uses — so
 * the popup cannot drift from the row that opened it. `productName` is the
 * spelling written on the order and is never replaced by the catalogue's;
 * `product` carries the catalogue entry separately when one is linked.
 */
export type SalesFulfillmentDetail = {
  salesOrderItemId: string;
  order: {
    id: string;
    orderId: string;
    orderDate: string;
    status: string;
  };
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
  };
  /** As written on the order line. */
  productName: string;
  /** The catalogue entry, when the line is linked. */
  product: ProductView | null;
  requiredQty: number;
  /** Supplied outside procurement. Never a purchase source. */
  alreadyFulfilled: number;
  procurementFulfilled: number;
  totalFulfilled: number;
  unfulfilledQty: number;
  status: FulfillmentStatus;
  sources: FulfillmentSource[];
  activity: FulfillmentEvent[];
};
