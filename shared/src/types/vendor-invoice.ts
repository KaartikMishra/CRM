/**
 * What the Vendor Invoices API returns.
 *
 * Money is a decimal string end to end, matching the rest of the CRM: no float
 * touches a rate or a total. Dates are ISO strings in UTC, formatted for
 * display by the frontend's existing Asia/Kolkata helpers rather than being
 * pre-formatted here.
 */

/** A vendor as the list shows one. */
export type VendorListRow = {
  id: string;
  name: string;
  companyName: string | null;
  /** The primary number, treated as WhatsApp. */
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  contactPerson: string | null;
  isActive: boolean;

  /** How many products this vendor currently supplies. Counted, not fetched. */
  mappedProductCount: number;

  createdAt: string;
};

/** The vendor panel above their trade history. */
export type VendorSummary = {
  id: string;
  name: string;
  companyName: string | null;
  address: string | null;
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  contactPerson: string | null;
  city: string | null;
  isActive: boolean;
};

/**
 * One historical purchase line.
 *
 * Every field here comes from an existing PurchaseBill or PurchaseBillItem
 * record. Nothing is stored twice, and nothing is computed that the source
 * could have disagreed with — `lineTotal` is derived from the stored rate and
 * quantity at read time.
 */
export type VendorTradeRow = {
  id: string;

  /** When the bill is dated, as printed on it. */
  billDate: string;
  /**
   * When the line was recorded in the CRM.
   *
   * A real timestamp, not a substitute for billDate: a bill dated the 10th may
   * have been typed up on the 12th, and both facts are true.
   */
  recordedAt: string;

  /** What the vendor's own bill called it. Always present. */
  productName: string;
  /** The catalogue entry, once linked. Null on an unlinked line. */
  productId: string | null;
  /** The line's photograph, through the existing MediaAsset path. */
  productImageUrl: string | null;

  orderedQty: number;
  receivedQty: number;
  /** What this purchase actually cost per unit. Historical, never rewritten. */
  rate: string;
  /** rate × orderedQty, derived at read time. */
  lineTotal: string;

  /** The vendor's own bill number — this CRM's invoice reference. */
  billNumber: string;
  billId: string;
  billStatus: string;
  billType: string;
};

/** One row of the vendor-product mapping table. */
export type VendorMappingRow = {
  id: string;
  vendorId: string;
  vendorName: string;

  rsProductId: string;
  productTitle: string;
  /** Shopify's first image, or null for a manual product with none. */
  productImageUrl: string | null;
  productStatus: string;
  productSource: string;

  /** The current agreed rate. Not what past purchases cost. */
  currentRate: string;
  isActive: boolean;

  createdAt: string;
  updatedAt: string;
};
