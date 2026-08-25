/**
 * The API surface, assembled in one place.
 *
 * Each module contributes its own router; this file only mounts them, so
 * adding a module never means editing app.ts. Auth, customers, vendors and
 * product enquiries join here in the phases that follow.
 */

import { Router } from 'express';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { customerRoutes } from '../modules/customer/customer.routes.js';
import { healthRoutes } from '../modules/health/health.routes.js';
import { productEnquiryRoutes } from '../modules/product-enquiry/product-enquiry.routes.js';
import { vendorRoutes } from '../modules/vendor/vendor.routes.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRoutes);
apiRouter.use('/auth', authRoutes);
apiRouter.use('/product-enquiries', productEnquiryRoutes);
apiRouter.use('/customers', customerRoutes);
apiRouter.use('/vendors', vendorRoutes);
