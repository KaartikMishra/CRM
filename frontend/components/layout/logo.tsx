import { cn } from '@/lib/utils';

/**
 * INTEGRATION POINT — RoyalStuffs brand mark.
 *
 * The supplied logo file could not be read, so this is a typographic wordmark
 * standing in for it. Everything brand-related is isolated here: drop the real
 * asset into `public/` and swap the <span> for an <Image>, and the whole
 * application picks it up. No other file references the brand.
 */
export function Logo({ collapsed = false, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5 select-none', className)}>
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-[5px] bg-accent font-serif text-[15px] font-semibold leading-none text-accent-ink"
      >
        R
      </span>
      {!collapsed && (
        <span className="flex flex-col leading-none">
          <span className="font-serif text-[17px] font-semibold tracking-tight text-ink">
            RoyalStuffs
          </span>
          <span className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
            CRM
          </span>
        </span>
      )}
    </span>
  );
}
