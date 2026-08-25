import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * The RoyalStuffs mark — the single source of truth for brand imagery.
 *
 * Two properties of the supplied file drive everything here, and neither is
 * fixed by editing the asset:
 *
 *   1. It has an opaque white background and no alpha channel. On the ivory
 *      ground that would read as a pale rectangle, so the image is composited
 *      with `mix-blend-mode: multiply` (see .logo-blend). The mark is dark
 *      espresso on white, which multiplies cleanly onto any lighter surface.
 *
 *   2. The artwork occupies only the middle 118×118 of a 288×214 canvas — 41%
 *      of the width. Rendered with plain `object-contain` at sidebar size the
 *      mark would come out around 13px and turn to mush, so `MARK` crops to the
 *      measured ink box. The crop is a translation and a uniform scale: the
 *      aspect ratio is preserved exactly and nothing is stretched.
 *
 * `FULL` renders the asset as supplied, letterboxed with object-contain, for
 * places with room to breathe.
 */

const SRC = '/RS_logo.png';

/** Measured ink bounds within the 288×214 source. */
const CANVAS = { w: 288, h: 214 };
const INK = { x: 89, y: 49, size: 118 };

/**
 * Square crop to the ink box. The image is scaled so the ink is exactly `size`
 * across, then offset so the ink lands inside the clipping box.
 */
function Mark({ size, className }: { size: number; className?: string }) {
  const scale = size / INK.size;

  return (
    <span
      className={cn('relative block shrink-0 overflow-hidden', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Image
        src={SRC}
        alt=""
        width={CANVAS.w}
        height={CANVAS.h}
        priority
        className="logo-blend max-w-none"
        style={{
          width: CANVAS.w * scale,
          height: CANVAS.h * scale,
          marginLeft: -INK.x * scale,
          marginTop: -INK.y * scale,
        }}
      />
    </span>
  );
}

export type LogoProps = {
  /** Hides the wordmark, leaving only the mark — for a collapsed sidebar. */
  collapsed?: boolean;
  /** Mark size in pixels. */
  size?: number;
  className?: string;
};

/** Mark plus wordmark. Used in the sidebar and the mobile header. */
export function Logo({ collapsed = false, size = 34, className }: LogoProps) {
  return (
    <span className={cn('flex items-center gap-2.5 select-none', className)}>
      <Mark size={size} />
      {!collapsed && (
        <span className="flex flex-col leading-none">
          <span className="font-serif text-[18px] font-semibold tracking-tight text-ink">
            RoyalStuffs
          </span>
          <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted">
            CRM
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * The asset exactly as supplied, letterboxed. For the sign-in page, where the
 * built-in padding around the mark is breathing room rather than a problem.
 */
export function LogoFull({ className, width = 132 }: { className?: string; width?: number }) {
  return (
    <Image
      src={SRC}
      alt="RoyalStuffs"
      width={CANVAS.w}
      height={CANVAS.h}
      priority
      className={cn('logo-blend h-auto object-contain', className)}
      style={{ width }}
    />
  );
}

/** Just the mark, for tight spaces like a mobile bar or an avatar slot. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return <Mark size={size} className={className} />;
}
