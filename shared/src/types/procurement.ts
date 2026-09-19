import type {
  BillApprovalStatus,
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

/*
 * `ProductView` — the legacy Product master as Procurement showed it, carrying
 * `onHand` from InventoryItem — is gone.
 *
 * There is one product identity now, and it is `RsProductRef` below. A second
 * shape describing a second catalogue is what let Sales and Procurement name
 * the same goods differently, which is the thing this migration removed.
 */

/**
 * An RS Product as Procurement refers to it — the canonical product identity.
 *
 * Product level, never variant. The Procurement-facing RS Products API already
 * aggregates its variants into one product row, so Procurement reads stock
 * without a variant concept and never exposes one.
 *
 * `id` is the whole identity. `sku` and `title` are here to be read by a human
 * and searched on; neither identifies anything, because RS SKUs are nullable
 * and legitimately repeat across variants.
 */
export type RsProductRef = {
  id: string;
  title: string;
  /** The first variant's SKU. Display and search only. Never unique. */
  sku: string | null;
  imageUrl: string | null;
  /**
   * CRM STOCK — what the CRM counts, maintained by hand.
   *
   * Summed across the product's variants from `ShopifyVariant.crmStockQty`, via
   * the same helper `RsProductListRow.crmStockQty` uses, so the figure
   * Procurement displays is by construction the one RS Products displays.
   *
   * Never `InventoryItem.onHand`, which is the legacy warehouse count
   * Procurement no longer treats as a stock source.
   */
  crmStockQty: number;
  /**
   * RS PRODUCT STOCK — what Shopify says is sellable.
   *
   * Summed across the product's variants from `ShopifyVariant.inventoryQty`,
   * which every sync pass and every inventory webhook overwrites.
   *
   * A DIFFERENT NUMBER FROM `crmStockQty`, and deliberately carried beside it
   * rather than folded into it. The two answer different questions — "what have
   * we counted" and "what is the storefront selling" — and they routinely
   * disagree, which is itself the useful signal. Substituting one for the other
   * anywhere, or relabelling one as the other, is what the separate columns and
   * separate labels downstream exist to prevent.
   */
  rsStockQty: number;
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
  /**
   * The RS Product this line is mapped to — Procurement's canonical identity.
   *
   * Null on a line nobody has mapped yet, including every line recorded before
   * the mapping existed. Such a line is shown as unmapped rather than guessed
   * at: nothing derives a mapping from the vendor's wording or from a SKU.
   *
   * Allocation compares this against `SalesOrderItem`'s, so a line with none
   * can be recorded and received but not allocated.
   */
  rsProduct: RsProductRef | null;
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
  /**
   * An undecided request to move this line to a different RS Product.
   *
   * Null on a line with none, which is almost all of them. While it is set the
   * mapping shown above is still the live one — a pending request changes
   * nothing — so the UI reports the line as awaiting approval rather than
   * showing the proposed product as though it had already been applied.
   */
  pendingProductChange: ProductChangeView | null;
};

/**
 * One request to re-map a purchase line, as the API states it.
 *
 * Both products are carried in full rather than as ids: an approver is deciding
 * whether the goods on a bill were misidentified, and two cuids tell them
 * nothing. The stock figures come with them for the same reason — moving a
 * mapping moves which product's stock the line's requirement is read against.
 */
export type ProductChangeView = {
  id: string;
  billId: string;
  billNumber: string;
  itemId: string;
  /** The vendor's wording on the line, which is the evidence being judged. */
  productName: string;
  /** What the line is mapped to now. An approval has not changed this yet. */
  fromRsProduct: RsProductRef;
  /** What the requester wants it to become. */
  toRsProduct: RsProductRef;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedBy: { id: string; name: string };
  requestedAt: string;
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /**
   * How much stock is allocated through the line right now.
   *
   * Reported so an approver can see that approving would refuse: a line with
   * allocations cannot be re-mapped, because its stock has been promised to
   * orders under the current identity.
   */
  allocatedQty: number;
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
  /** How much of the goods have arrived. Derived from the lines. */
  status: PurchaseBillStatus;
  /**
   * Whether an administrator has signed the bill off.
   *
   * Independent of `status` above: a bill can be fully RECEIVED and still
   * PENDING. Until it is APPROVED its stock cannot be allocated to an order,
   * which is enforced by the API and not merely hidden by the UI.
   */
  approvalStatus: BillApprovalStatus;
  /** Who decided it, and when. Both null while it is pending. */
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
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
  /** The RS Product this line is for. Null when nobody has mapped it. */
  rsProductId: string | null;
  /** True when `rsProductId` is set — the condition for taking stock. */
  linked: boolean;
  requiredQty: number;
  /** Supplied outside procurement, recorded by hand. */
  alreadyFulfilled: number;
  /** Supplied through procurement — the sum of this line's allocations. */
  allocatedQty: number;
  /** alreadyFulfilled + allocatedQty. Derived, never stored. */
  totalFulfilled: number;
  /*
   * There is deliberately no stock figure on an order line.
   *
   * There used to be `availableInInventory`, read from InventoryItem.onHand.
   * Procurement no longer treats that as its stock source, and a sales order
   * line carries no RS Product link to read the RS figure from — Sales is not
   * migrated. Reporting the legacy number under a stock label would be exactly
   * the second, disagreeing stock source this migration exists to prevent, so
   * the field is gone rather than relabelled.
   */
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
  rsProductId: string | null;
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
   * What to call this requirement. For a mapped row it is the RS Product's
   * title; for a free-text row it is the exact string written on the line,
   * aggregated verbatim and never normalised.
   *
   * Two spellings of the same thing therefore stay two rows. That is
   * deliberate: folding them would be an identity decision, and the folding
   * this board used to do — against the legacy catalogue's normalised names —
   * went with that catalogue. Mapping a line to an RS Product is how two
   * spellings become one row now, and a person does it.
   */
  productName: string;
  /**
   * The RS Product this row aggregates, when there is one.
   *
   * Null for demand or supply that exists only as free text — goods nobody has
   * mapped to the catalogue yet. Such demand is real and must be bought, so it
   * appears here; it simply cannot take part in allocation until somebody maps
   * it, which is what `linked: false` tells the reader.
   */
  rsProduct: RsProductRef | null;
  linked: boolean;
  /**
   * The mapped product's SKU, lifted onto the row so the board can show it in
   * the Product column. Display only — nothing on this board identifies by SKU.
   */
  sku: string | null;
  totalRequired: number;
  totalAllocated: number;
  /**
   * CRM STOCK for this row — the hand-maintained count. Null when the row has
   * no RS Product.
   *
   * This is the figure the board's inclusion rule is evaluated against: a row
   * appears when CRM stock cannot cover what the open orders still need.
   *
   * Null renders as a dash, never a zero. "No RS Product is mapped, so there is
   * no stock figure to state" and "there are none in stock" are different
   * facts, and one of them means the row cannot be allocated at all.
   */
  crmStockQty: number | null;
  /**
   * RS PRODUCT STOCK for this row — Shopify's sellable quantity. Null when the
   * row has no RS Product.
   *
   * A SEPARATE NUMBER from `crmStockQty` above, shown in its own column under
   * its own label. Neither is derived from the other and neither substitutes
   * for the other; where they disagree, that disagreement is the point.
   *
   * Both are displayed beside the shortage and neither is subtracted from it.
   * The shortage is what the open orders still need; netting stock off it would
   * hide demand behind stock that is shared across every order.
   */
  rsStockQty: number | null;
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
  /** The RS Product the line is mapped to, when it is. */
  rsProduct: RsProductRef | null;
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
