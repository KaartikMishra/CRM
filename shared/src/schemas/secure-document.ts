import { z } from 'zod';
import {
  APP_MODULES,
  SECURE_DOCUMENT_KINDS,
  SECURE_DOCUMENT_OWNER_TYPES,
} from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for secure documents.
 *
 * What these deliberately do NOT accept:
 *
 *   - **A URL, of any kind.** This is the central decision of the whole feature.
 *     MediaAsset stores `secureUrl`, and that stored link is exactly why its
 *     files are world-readable: a URL outlives every access check and cannot be
 *     revoked. Here the only durable identifier is `publicId`, and a delivery URL
 *     is minted per request, signed, and expires. Accepting one would reintroduce
 *     the problem on day one.
 *   - **`deliveryType`.** Set by the upload service to 'authenticated'. A caller
 *     able to choose it could choose Cloudinary's public default, and the row
 *     would claim to be confidential while being fetchable by anybody. The
 *     database refuses that again with a CHECK.
 *   - **`uploadedById`.** From the authenticated session, like every actor field.
 *   - **Raw bytes.** They go through the upload service, which is the one place
 *     binary data is handled and the one place the type and size caps live.
 */

export const secureDocumentKindSchema = z.enum(SECURE_DOCUMENT_KINDS, {
  errorMap: () => ({ message: 'Choose what kind of document this is' }),
});

/**
 * Whose document this is.
 *
 * Polymorphic until Employee exists — Phase 1 adds 'Employee' to the enum and
 * the typed relation alongside it. A named set rather than a free string so a
 * typo cannot file a payslip under an owner type nothing will ever query.
 */
export const secureDocumentOwnerSchema = z.object({
  ownerType: z.enum(SECURE_DOCUMENT_OWNER_TYPES, {
    errorMap: () => ({ message: 'Choose what kind of record this document belongs to' }),
  }),
  ownerId: cuidSchema,
});

/**
 * Registering an already-uploaded object.
 *
 * `module` governs who may read it: HR_PAYROLL on a payslip means reading it
 * needs HR_PAYROLL + VIEW, resolved by the same permission service every other
 * request obeys rather than by a rule invented here.
 */
export const createSecureDocumentSchema = secureDocumentOwnerSchema.extend({
  publicId: z
    .string()
    .trim()
    .min(1, 'A stored document needs its storage identifier')
    .max(255, 'Storage identifier is too long'),
  kind: secureDocumentKindSchema,
  module: z.enum(APP_MODULES, {
    errorMap: () => ({ message: 'Choose which module governs access to this document' }),
  }),
  fileName: z.string().trim().max(255, 'File name is too long').optional(),
  mimeType: z.string().trim().max(100, 'Content type is too long').optional(),
  /** Positive, matching the secure_document_bytes_positive CHECK. */
  bytes: z.number().int().positive('A file cannot be zero bytes').optional(),
});

/**
 * Amending the description of one.
 *
 * `publicId`, `ownerType` and `ownerId` are absent on purpose: moving a stored
 * document to a different owner is not an edit, it is a mistake being covered
 * up. Delete the row and register the file against the right owner.
 */
export const updateSecureDocumentSchema = z.object({
  kind: secureDocumentKindSchema.optional(),
  fileName: z.string().trim().max(255, 'File name is too long').optional(),
});

export const secureDocumentListQuerySchema = paginationSchema.extend({
  ownerType: z.enum(SECURE_DOCUMENT_OWNER_TYPES).optional(),
  ownerId: cuidSchema.optional(),
  kind: secureDocumentKindSchema.optional(),
  module: z.enum(APP_MODULES).optional(),
});

export const secureDocumentParamSchema = z.object({ id: cuidSchema });

export type CreateSecureDocumentInput = z.infer<typeof createSecureDocumentSchema>;
export type UpdateSecureDocumentInput = z.infer<typeof updateSecureDocumentSchema>;
export type SecureDocumentListQuery = z.infer<typeof secureDocumentListQuerySchema>;
