import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { sendCreated } from '../../utils/apiResponse.js';
import { currentUser } from '../../middleware/requireAuth.js';
import { recordAudit } from '../../services/audit.service.js';
import { uploadProductImage } from './upload.service.js';

export async function upload(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const file = req.file;

  if (!file) {
    throw AppError.badRequest('NO_FILE', 'Choose an image to upload.');
  }

  const asset = await uploadProductImage(
    file,
    user.id,
    env.UPLOAD_MAX_MB * 1024 * 1024,
  );

  // The upload is worth a trail: it costs money and creates a stored object.
  await recordAudit(req, {
    action: 'media.upload',
    entityType: 'MediaAsset',
    entityId: asset.id,
    actorId: user.id,
    newValue: { publicId: asset.publicId, bytes: asset.bytes },
  });

  sendCreated(res, { asset });
}
