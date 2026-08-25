'use client';

import { ImagePlus, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * INTEGRATION POINT — Cloudinary product image.
 *
 * §20/§52: there is no upload endpoint yet, and inventing one would mean
 * pretending an upload works when nothing is stored. So this renders the real
 * slot the image will occupy and says plainly that uploads are not live —
 * rather than offering a control that silently does nothing.
 *
 * When the Cloudinary phase lands, the flow is already decided by the backend
 * contract: request a signature, upload browser-to-Cloudinary, post the
 * resulting publicId back, and pass the returned MediaAsset id as
 * `imageAssetId` on the product or vendor response. Only this component
 * changes; every caller already threads `imageAssetId` through.
 */
export function ImageUploadField({ className, label = 'Product image' }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-sm font-medium text-ink-2">{label}</span>
      <div
        className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-line-2 bg-surface-2"
        aria-describedby="image-upload-note"
      >
        <div className="flex flex-col items-center gap-1.5 px-3 text-center">
          <ImagePlus className="size-5 text-faint" aria-hidden />
          <span className="text-xs text-faint">No image</span>
        </div>
      </div>
      <p id="image-upload-note" className="flex items-start gap-1.5 text-xs text-muted">
        <Info className="mt-px size-3 shrink-0" aria-hidden />
        Uploads arrive with the Cloudinary phase.
      </p>
    </div>
  );
}
