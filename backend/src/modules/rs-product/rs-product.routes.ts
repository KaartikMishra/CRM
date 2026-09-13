/**
 * The route table, and nothing else.
 *
 * Every route carries requireAuth and a requirePermission for RS_PRODUCTS. The
 * module denies USER by default, so a plain employee reaches this only once an
 * administrator grants it through the existing overrides screen — no second
 * permission mechanism is introduced here.
 *
 * Literal paths are declared before any parameterised one, so `/product-types`
 * and `/shopify/...` are never read as product ids.
 */

import { Router } from 'express';
import {
  createRsProductSchema,
  rsProductIdParamSchema,
  rsProductListQuerySchema,
  updateRsProductSchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './rs-product.controller.js';

export const rsProductRoutes = Router();

rsProductRoutes.use(requireAuth);

rsProductRoutes.get(
  '/',
  requirePermission('RS_PRODUCTS', 'VIEW'),
  validate({ query: rsProductListQuerySchema }),
  controller.list,
);

/** Creating a CRM-only product. Always MANUAL; never a Shopify row. */
rsProductRoutes.post(
  '/',
  requirePermission('RS_PRODUCTS', 'CREATE'),
  validate({ body: createRsProductSchema }),
  controller.create,
);

/** The filter control's options, from what the catalogue actually holds. */
rsProductRoutes.get(
  '/product-types',
  requirePermission('RS_PRODUCTS', 'VIEW'),
  controller.productTypes,
);

/**
 * Whether the Shopify store connection works.
 *
 * A setup diagnostic, so it sits behind EDIT rather than VIEW: reading the
 * catalogue and configuring where the catalogue comes from are different
 * privileges. It returns connection metadata only — never a token or a secret.
 */
rsProductRoutes.get(
  '/shopify/connection',
  requirePermission('RS_PRODUCTS', 'EDIT'),
  controller.shopifyConnection,
);

/**
 * Pulls the Shopify catalogue into RS Products.
 *
 * POST because it writes, and CREATE because it brings products into existence.
 * Idempotent, so a repeated call is safe — but it is still a write, and the
 * permission says so.
 */
rsProductRoutes.post(
  '/shopify/sync',
  requirePermission('RS_PRODUCTS', 'CREATE'),
  controller.shopifySync,
);

/**
 * Parameterised routes last, so the literal paths above are never read as ids.
 */
rsProductRoutes.get(
  '/:id',
  requirePermission('RS_PRODUCTS', 'VIEW'),
  validate({ params: rsProductIdParamSchema }),
  controller.detail,
);

/** CRM-side editing only. Nothing here reaches Shopify. */
rsProductRoutes.patch(
  '/:id',
  requirePermission('RS_PRODUCTS', 'EDIT'),
  validate({ params: rsProductIdParamSchema, body: updateRsProductSchema }),
  controller.update,
);

/**
 * Archive, never delete. POST rather than DELETE because nothing is removed —
 * the verb would promise something this does not do.
 */
rsProductRoutes.post(
  '/:id/archive',
  requirePermission('RS_PRODUCTS', 'DELETE'),
  validate({ params: rsProductIdParamSchema }),
  controller.archive,
);
