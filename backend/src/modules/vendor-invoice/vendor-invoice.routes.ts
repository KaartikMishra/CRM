/**
 * The route table, and nothing else.
 *
 * Every route carries requireAuth and a requirePermission for VENDOR_INVOICE —
 * the module value that already existed in the enum, reusing the CRM's one
 * permission system rather than introducing a second.
 *
 * The split between EDIT and DELETE is deliberate: changing a vendor's details
 * and retiring them are different decisions, and archiving sits behind DELETE
 * so that granting someone EDIT does not also let them take a supplier out of
 * circulation.
 *
 * Distinct from the existing /api/vendors routes, which Product Enquiry and
 * Procurement depend on and which are left exactly as they were.
 */

import { Router } from 'express';
import {
  createMappingSchema,
  createVendorSchema,
  mappingIdParamSchema,
  mappingListQuerySchema,
  updateMappingSchema,
  updateVendorSchema,
  vendorIdParamSchema,
  vendorListQuerySchema,
  vendorTradeQuerySchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './vendor-invoice.controller.js';

export const vendorInvoiceRoutes = Router();

vendorInvoiceRoutes.use(requireAuth);

// --- vendors ----------------------------------------------------------------

vendorInvoiceRoutes.get(
  '/vendors',
  requirePermission('VENDOR_INVOICE', 'VIEW'),
  validate({ query: vendorListQuerySchema }),
  controller.listVendors,
);

vendorInvoiceRoutes.post(
  '/vendors',
  requirePermission('VENDOR_INVOICE', 'CREATE'),
  validate({ body: createVendorSchema }),
  controller.createVendor,
);

// --- mappings ---------------------------------------------------------------
//
// Declared before the parameterised vendor routes below so that `/mappings` is
// never read as a vendor id.

vendorInvoiceRoutes.get(
  '/mappings',
  requirePermission('VENDOR_INVOICE', 'VIEW'),
  validate({ query: mappingListQuerySchema }),
  controller.listMappings,
);

vendorInvoiceRoutes.post(
  '/mappings',
  requirePermission('VENDOR_INVOICE', 'CREATE'),
  validate({ body: createMappingSchema }),
  controller.createMapping,
);

vendorInvoiceRoutes.patch(
  '/mappings/:id',
  requirePermission('VENDOR_INVOICE', 'EDIT'),
  validate({ params: mappingIdParamSchema, body: updateMappingSchema }),
  controller.updateMapping,
);

/** Archive, never delete: the pair is revived rather than re-created. */
vendorInvoiceRoutes.post(
  '/mappings/:id/archive',
  requirePermission('VENDOR_INVOICE', 'DELETE'),
  validate({ params: mappingIdParamSchema }),
  controller.archiveMapping,
);

// --- one vendor -------------------------------------------------------------

vendorInvoiceRoutes.get(
  '/vendors/:id',
  requirePermission('VENDOR_INVOICE', 'VIEW'),
  validate({ params: vendorIdParamSchema }),
  controller.getVendor,
);

/**
 * A vendor's purchase history.
 *
 * Read-only, and there is deliberately no write counterpart: the history is
 * Procurement's PurchaseBill and PurchaseBillItem records, read live. This
 * module stores no copy of them.
 */
vendorInvoiceRoutes.get(
  '/vendors/:id/trades',
  requirePermission('VENDOR_INVOICE', 'VIEW'),
  validate({ params: vendorIdParamSchema, query: vendorTradeQuerySchema }),
  controller.vendorTrades,
);

vendorInvoiceRoutes.patch(
  '/vendors/:id',
  requirePermission('VENDOR_INVOICE', 'EDIT'),
  validate({ params: vendorIdParamSchema, body: updateVendorSchema }),
  controller.updateVendor,
);

/** Archive, never delete: purchase bills name this vendor and must stay readable. */
vendorInvoiceRoutes.post(
  '/vendors/:id/archive',
  requirePermission('VENDOR_INVOICE', 'DELETE'),
  validate({ params: vendorIdParamSchema }),
  controller.archiveVendor,
);
