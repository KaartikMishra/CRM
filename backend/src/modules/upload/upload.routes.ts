import { Router } from 'express';
import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { ALLOWED_MIME_TYPES } from './upload.service.js';
import { upload } from './upload.controller.js';

/**
 * Held in memory and streamed straight to Cloudinary — nothing is written to
 * this server's disk. The limit is enforced twice: multer refuses the stream
 * past the cap, and the service checks the size again before uploading.
 */
const receive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_MIME_TYPES)[number])) {
      cb(AppError.badRequest(
        'UNSUPPORTED_IMAGE_TYPE',
        'That file type is not supported. Use a JPEG, PNG, WebP or GIF image.',
      ));
      return;
    }
    cb(null, true);
  },
});

/** Translates multer's own errors into the API's envelope. */
function receiveImage(req: Request, res: Response, next: NextFunction): void {
  receive.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      next(
        error.code === 'LIMIT_FILE_SIZE'
          ? AppError.badRequest(
              'IMAGE_TOO_LARGE',
              `That image is too large. The limit is ${env.UPLOAD_MAX_MB} MB.`,
            )
          : AppError.badRequest('INVALID_UPLOAD', 'That upload could not be read.'),
      );
      return;
    }
    next(error);
  });
}

export const uploadRoutes = Router();

uploadRoutes.use(requireAuth);

/**
 * Guarded on PRODUCT_ENQUIRY CREATE — the same capability that lets someone
 * record an enquiry lets them attach an image to one. Resolved through the
 * existing permission system, so a UserModulePermission override applies.
 */
uploadRoutes.post(
  '/',
  requirePermission('PRODUCT_ENQUIRY', 'CREATE'),
  receiveImage,
  upload,
);
