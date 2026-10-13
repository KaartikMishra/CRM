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

/**
 * Where confidential documents live — a separate folder, deliberately.
 *
 * Not a second provider and not a second credential: the same Cloudinary account
 * and the same CLOUDINARY_URL serve both. What differs is the delivery type.
 * Objects in UPLOAD_FOLDER above are uploaded as Cloudinary's public `upload`
 * type, so their URLs are fetchable by anybody holding the link — correct for a
 * product photo. Objects here are uploaded as `authenticated` and reachable only
 * through a signed URL that expires.
 *
 * The folder separation is not itself the security boundary — the delivery type
 * is. It exists so that a misconfiguration is visible in the asset library rather
 * than hidden among ten thousand product images, and so an account-level policy
 * can be applied to one folder without touching the other.
 */
export const SECURE_UPLOAD_FOLDER = 'royalstuffs-crm/secure';

/**
 * How long a signed document URL stays valid, in seconds.
 *
 * Ten minutes: long enough to open a payslip and print it, short enough that a
 * URL pasted into a chat or left in a browser history is worthless by the time
 * anybody else tries it. This is the mitigation for the one thing a signed URL
 * cannot do — it is a bearer token once minted, so the only real control is how
 * briefly it works.
 */
export const SECURE_URL_TTL_SECONDS = 600;
