/**
 * Cloudinary configuration — backend only.
 *
 * The credential lives in one environment variable, CLOUDINARY_URL, which
 * embeds the API secret. It is read here and nowhere else: it never reaches a
 * response body, a log line, or any variable the browser could see. There is
 * deliberately no NEXT_PUBLIC_ equivalent.
 *
 * Configuration is optional so the API still boots without it — uploads then
 * fail with a clear "not configured" answer instead of the whole service
 * refusing to start over a feature most requests never touch.
 */

import { v2 as cloudinary } from 'cloudinary';
import { env } from './env.js';
import { logger } from './logger.js';

let configured = false;

if (env.CLOUDINARY_URL) {
  // The SDK parses CLOUDINARY_URL from the environment itself.
  cloudinary.config({ secure: true });
  configured = true;

  // Cloud name is public; the key and secret are not, and are never logged.
  logger.info({ cloudName: cloudinary.config().cloud_name }, 'Cloudinary configured');
} else {
  logger.warn('CLOUDINARY_URL is not set — image uploads are disabled');
}

export const isCloudinaryConfigured = (): boolean => configured;
export { cloudinary };

/** Where enquiry images live in the asset library. */
export const UPLOAD_FOLDER = 'royalstuffs-crm/product-enquiry';
