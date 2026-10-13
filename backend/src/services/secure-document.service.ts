/**
 * Confidential document storage and delivery.
 *
 * ### Why this exists beside the upload module rather than inside it
 *
 * `modules/upload` stores product photographs. It uploads with Cloudinary's
 * default `upload` type and records the resulting `secure_url` on MediaAsset, so
 * the file is fetchable by anybody holding that link, with no CRM session. That
 * is correct for its purpose — a product image is public content — and it is why
 * seven tables reference MediaAsset happily.
 *
 * A payslip, a bank mandate or an Aadhaar scan cannot live there. Making
 * MediaAsset private instead would change delivery for product, enquiry, sales,
 * purchase, lead and post-sales images at once — six shipped modules — for no
 * gain to any of them.
 *
 * So: **one storage provider, two access models.** Same Cloudinary account, same
 * CLOUDINARY_URL credential, no new dependency and no new secret. The difference
 * is three decisions, each made here and nowhere else:
 *
 *   1. `type: 'authenticated'` on upload, so the object has no public URL at all.
 *   2. No stored URL. SecureDocument has no `secureUrl` column — see below.
 *   3. Every read mints a fresh signed URL that expires.
 *
 * ### Why no URL is ever stored
 *
 * This is the whole design, so it is worth stating bluntly: a stored URL outlives
 * every access check. Once written to a row it can be read by any future query,
 * logged by any future handler, and serialised into any future API response, and
 * nothing downstream can tell that it should not have been. Revoking it is
 * impossible without deleting the object itself. MediaAsset's `secureUrl` column
 * is precisely how its files became world-readable.
 *
 * `publicId` is the only durable identifier here. It is useless on its own — a
 * request for an authenticated object without a valid signature is refused by
 * Cloudinary — so a leaked database row does not leak the documents.
 *
 * ### What a signed URL can and cannot do
 *
 * It is a bearer token once minted: whoever holds it within its lifetime can
 * fetch the file, and there is no way to bind it to a session. The mitigations
 * are that it is short-lived (SECURE_URL_TTL_SECONDS), that it is minted only
 * after the caller's permission has been resolved, and that it is never logged.
 * Stating the limit rather than implying it is absent: a ten-minute window is the
 * residual risk this design accepts.
 */

import type { UploadApiResponse } from 'cloudinary';
import type { AppModule, SecureDocumentKind, SecureDocumentOwnerType } from '@rs/shared';
import {
  SECURE_UPLOAD_FOLDER,
  SECURE_URL_TTL_SECONDS,
  cloudinary,
  isCloudinaryConfigured,
} from '../config/cloudinary.js';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';

/**
 * What a confidential document may be.
 *
 * Wider than the image uploader's list, because HR documents are overwhelmingly
 * PDFs and scans — an identity proof that cannot be a PDF is not a usable
 * feature. Deliberately NOT achieved by widening the shared image uploader's
 * ALLOWED_MIME_TYPES, which would let PDFs into product, enquiry, sales,
 * purchase, lead and post-sales attachments as a side effect.
 *
 * Office formats are absent on purpose: they carry macros, and nothing in HR
 * needs a spreadsheet stored where a PDF would do.
 */
export const SECURE_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SecureDocumentMimeType = (typeof SECURE_DOCUMENT_MIME_TYPES)[number];

/**
 * What a caller is told about a stored document.
 *
 * Note what is absent: any URL. Callers that need one ask for it explicitly
 * through `signedUrlFor`, which is the function that costs a permission check.
 * If this type carried a URL, every list endpoint would hand out fetchable links
 * to every document it mentions.
 */
export type StoredSecureDocument = {
  id: string;
  publicId: string;
  kind: SecureDocumentKind;
  module: AppModule;
  ownerType: string;
  ownerId: string;
  fileName: string | null;
  mimeType: string | null;
  bytes: number | null;
  uploadedById: string;
  createdAt: Date;
};

export function assertSecureStorageAvailable(): void {
  if (!isCloudinaryConfigured()) {
    throw new AppError(
      'SECURE_STORAGE_NOT_CONFIGURED',
      503,
      'Document storage is not available right now.',
    );
  }
}

export function assertAcceptableDocument(
  file: { mimetype: string; size: number },
  maxBytes: number,
): void {
  if (!SECURE_DOCUMENT_MIME_TYPES.includes(file.mimetype as SecureDocumentMimeType)) {
    throw AppError.badRequest(
      'UNSUPPORTED_DOCUMENT_TYPE',
      'That file type is not supported. Use a PDF, JPEG, PNG or WebP file.',
    );
  }

  if (file.size > maxBytes) {
    throw AppError.badRequest(
      'DOCUMENT_TOO_LARGE',
      `That file is too large. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    );
  }
}

/**
 * Streams a buffer to Cloudinary as an authenticated object.
 *
 * `type: 'authenticated'` is the line that matters and is the single difference
 * from the product-image path: without it Cloudinary stores a public object and
 * every other precaution in this file is decoration.
 *
 * `resource_type: 'raw'` for PDFs, 'image' for the rest. Cloudinary rejects a PDF
 * sent as an image, and sending an image as raw forgoes the format validation it
 * would otherwise do.
 */
function uploadSecureBuffer(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<UploadApiResponse> {
  const resourceType = mimetype === 'application/pdf' ? 'raw' : 'image';

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: SECURE_UPLOAD_FOLDER,
        resource_type: resourceType,
        type: 'authenticated',
        // Cloudinary must not be trusted to interpret the name as a path, and a
        // predictable public id would let somebody guess at other people's
        // documents even without a valid signature.
        use_filename: false,
        unique_filename: true,
        overwrite: false,
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('Cloudinary returned no result'));
          return;
        }
        resolve(result);
      },
    );

    stream.end(buffer);
  });
}

/**
 * Stores a confidential document and records it.
 *
 * The caller has already resolved that this person may file a document against
 * this owner — this function does not re-decide access, it stores bytes. What it
 * does guarantee is that nothing reaches the row unless Cloudinary accepted it as
 * an authenticated object.
 */
export async function storeSecureDocument(
  file: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  meta: {
    kind: SecureDocumentKind;
    module: AppModule;
    ownerType: SecureDocumentOwnerType;
    ownerId: string;
    uploadedById: string;
  },
  maxBytes: number,
): Promise<StoredSecureDocument> {
  assertSecureStorageAvailable();
  assertAcceptableDocument(file, maxBytes);

  let result: UploadApiResponse;
  try {
    result = await uploadSecureBuffer(file.buffer, file.originalname, file.mimetype);
  } catch (error) {
    // The provider's message can name account internals — log it, don't send it.
    logger.error({ err: error }, 'Secure document upload failed');
    throw new AppError('UPLOAD_FAILED', 502, 'The document could not be uploaded. Try again.');
  }

  /*
    Belt and braces. If Cloudinary ever returned a public object — a changed
    default, an SDK bug, a parameter silently ignored — storing the row anyway
    would create a record this table promises is confidential and that is in fact
    world-readable. The database's own CHECK would refuse the insert, but failing
    here says why, and deletes the object rather than leaving it orphaned.
  */
  if (result.type !== 'authenticated') {
    logger.error(
      { publicId: result.public_id, type: result.type },
      'Cloudinary stored a secure document as a non-authenticated object',
    );
    await destroySecureObject(result.public_id, result.resource_type).catch(() => undefined);
    throw new AppError('UPLOAD_FAILED', 502, 'The document could not be stored securely.');
  }

  return prisma.secureDocument.create({
    data: {
      publicId: result.public_id,
      deliveryType: 'authenticated',
      kind: meta.kind,
      module: meta.module,
      ownerType: meta.ownerType,
      ownerId: meta.ownerId,
      // Kept for display only. Never used to build a path — publicId is the one
      // thing that addresses the file.
      fileName: file.originalname.slice(0, 255),
      mimeType: file.mimetype,
      bytes: result.bytes ?? file.size,
      uploadedById: meta.uploadedById,
    },
    select: documentSelect,
  });
}

const documentSelect = {
  id: true,
  publicId: true,
  kind: true,
  module: true,
  ownerType: true,
  ownerId: true,
  fileName: true,
  mimeType: true,
  bytes: true,
  uploadedById: true,
  createdAt: true,
} as const;

/**
 * Mints a short-lived signed URL for one stored document.
 *
 * Synchronous and local: `private_download_url` signs with the configured secret
 * and makes no network call, so this costs nothing and cannot fail at the
 * provider. The expiry is an absolute Unix time Cloudinary enforces on its side.
 *
 * Call this only after resolving that the requester may read the document. It
 * takes a stored row rather than an id precisely so the caller must have fetched
 * it first — and therefore had something to check permissions against.
 */
export function signedUrlFor(
  document: Pick<StoredSecureDocument, 'publicId' | 'mimeType'>,
  ttlSeconds: number = SECURE_URL_TTL_SECONDS,
): { url: string; expiresAt: Date } {
  assertSecureStorageAvailable();

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const isPdf = document.mimeType === 'application/pdf';

  const url = cloudinary.utils.private_download_url(
    document.publicId,
    // Cloudinary wants the format without a dot; '' lets it serve what it stored.
    isPdf ? 'pdf' : '',
    {
      resource_type: isPdf ? 'raw' : 'image',
      type: 'authenticated',
      expires_at: Math.floor(expiresAt.getTime() / 1000),
    },
  );

  return { url, expiresAt };
}

/** Removes the stored object. Separate from the row so each failure is visible. */
async function destroySecureObject(publicId: string, resourceType: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    type: 'authenticated',
    invalidate: true,
  });
}

/**
 * Deletes a document — the stored object and its row.
 *
 * The object goes first. If that fails the row survives and the document is
 * still accounted for, which is recoverable; deleting the row first would leave a
 * confidential file in storage that nothing in the CRM knows about, which is not.
 */
export async function deleteSecureDocument(id: string): Promise<void> {
  const document = await prisma.secureDocument.findUnique({
    where: { id },
    select: { publicId: true, mimeType: true },
  });

  if (!document) {
    throw AppError.notFound('DOCUMENT_NOT_FOUND', 'That document could not be found.');
  }

  try {
    await destroySecureObject(
      document.publicId,
      document.mimeType === 'application/pdf' ? 'raw' : 'image',
    );
  } catch (error) {
    logger.error({ err: error, id }, 'Could not remove stored document');
    throw new AppError('DELETE_FAILED', 502, 'The document could not be removed. Try again.');
  }

  await prisma.secureDocument.delete({ where: { id } });
}
