/**
 * @rs/shared — the contract between frontend and backend.
 *
 * Everything crossing the API boundary is described here once: Zod schemas for
 * validation, their inferred TypeScript types, the enum vocabulary, and the
 * business constants. The backend validates with these schemas; the frontend
 * builds forms from the same objects. A contract change is therefore a compile
 * error on both sides rather than a runtime surprise at integration.
 *
 * This package must never import from @rs/database, backend or frontend.
 */

export * from './constants/index.js';
export * from './enums.js';
export * from './schemas/index.js';
export * from './types/enquiry.js';
export * from './types/sales.js';
export * from './types/procurement.js';
export * from './types/notification.js';
export * from './utils/units.js';
export * from './utils/money.js';
export * from './utils/product-name.js';
