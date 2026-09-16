'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRouter, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';

/**
 * The side panel a vendor's trades open in.
 *
 * Its own shell rather than the existing `Sheet`: that component is the mobile
 * navigation drawer — 18rem wide, with a close button labelled "Close
 * navigation". A vendor's trade history is a wide data view, and widening the
 * nav drawer to suit it would change every screen that uses it.
 *
 * Open state lives in the URL, not in React state. That is what lets the page
 * render the drawer's contents on the server: the vendor id arrives as a search
 * param, the server fetches that vendor's trades and mappings, and this
 * component only draws the frame around them. Closing removes the param, which
 * is also what makes the browser's Back button close the drawer.
 *
 * This is a Client Component because dismissal is interactive; its children are
 * Server Components passed straight through.
 */
export function VendorDrawerShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const params = useSearchParams();

  function close() {
    const next = new URLSearchParams(params.toString());
    // The vendor and both of their in-drawer page positions go together: a
    // cursor into one vendor's trades means nothing for the next.
    for (const key of ['vendorId', 'tradeCursor', 'tradePages', 'mapCursor', 'mapPages']) {
      next.delete(key);
    }
    const query = next.toString();
    router.push(query ? `/vendor-invoices?${query}` : '/vendor-invoices', { scroll: false });
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/20" />
        <DialogPrimitive.Content
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-4xl flex-col border-l border-line bg-surface shadow-overlay"
          aria-describedby={undefined}
        >
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-lg font-semibold text-ink">
                {title}
              </DialogPrimitive.Title>
              {subtitle && <p className="mt-0.5 truncate text-sm text-muted">{subtitle}</p>}
            </div>

            <DialogPrimitive.Close
              className="shrink-0 rounded-sm p-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="Close vendor details"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>

          {/* The drawer scrolls vertically; its tables scroll horizontally
              inside their own containers. */}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
