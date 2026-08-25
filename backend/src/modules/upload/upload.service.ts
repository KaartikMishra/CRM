/**
 * Product image upload.
 *
 * The browser sends the file here; this uploads it to Cloudinary and records a
 * MediaAsset row. Postgres stores the reference — publicId, secure URL and the
 * dimensions — never the binary (§6 of the original brief).
 *
 * The credential stays on this side of the wire. The browser receives only the
 * asset id and its public URL, and a Cloudinary failure is reported as a
 * generic upload error rather than the provider's own message, which can name
 * account internals.
 */

import type { UploadApiResponse } from 'cloudinary';
import { UPLOAD_FOLDER, cloudinary, isCloudinaryConfigured } from '../../config/cloudinary.js';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/AppError.js';

/** Raster formats Cloudinary handles and a browser will render inline. */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type UploadedAsset = {
  id: string;
  publicId: string;
  secureUrl: string;
  format: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
};

export function assertUploadAvailable(): void {
  if (!isCloudinaryConfigured()) {
    throw new AppError(
      'UPLOAD_NOT_CONFIGURED',
      503,
      'Image uploads are not available right now.',
    );
  }
}

export function assertAcceptableFile(file: { mimetype: string; size: number }, maxBytes: number): void {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_MIME_TYPES)[number])) {
    throw AppError.badRequest(
      'UNSUPPORTED_IMAGE_TYPE',
      'That file type is not supported. Use a JPEG, PNG, WebP or GIF image.',
    );
  }

  if (file.size > maxBytes) {
    throw AppError.badRequest(
      'IMAGE_TOO_LARGE',
      `That image is too large. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    );
  }
}

/** Streams a buffer to Cloudinary; the SDK's upload_stream has no promise form. */
function uploadBuffer(buffer: Buffer, filename: string): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: UPLOAD_FOLDER,
        resource_type: 'image',
        // Cloudinary must not be trusted to interpret the name as a path.
        use_filename: false,
        unique_filename: true,
        overwrite: false,
        context: { originalFilename: filename.slice(0, 120) },
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

export async function uploadProductImage(
  file: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  uploadedById: string,
  maxBytes: number,
): Promise<UploadedAsset> {
  assertUploadAvailable();
  assertAcceptableFile(file, maxBytes);

  let result: UploadApiResponse;
  try {
    result = await uploadBuffer(file.buffer, file.originalname);
  } catch (error) {
    // The provider's message can name account internals — log it, don't send it.
    logger.error({ err: error }, 'Cloudinary upload failed');
    throw new AppError('UPLOAD_FAILED', 502, 'The image could not be uploaded. Try again.');
  }

  const asset = await prisma.mediaAsset.create({
    data: {
      publicId: result.public_id,
      secureUrl: result.secure_url,
      format: result.format ?? null,
      width: result.width ?? null,
      height: result.height ?? null,
      bytes: result.bytes ?? null,
      uploadedById,
    },
    select: {
      id: true,
      publicId: true,
      secureUrl: true,
      format: true,
      width: true,
      height: true,
      bytes: true,
    },
  });

  return asset;
}
