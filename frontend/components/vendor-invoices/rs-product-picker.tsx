'use client';

import { useEffect, useState, useTransition } from 'react';
import { Check, ChevronsUpDown, ImageOff, Loader2 } from 'lucide-react';
import type { RsProductListRow } from '@rs/shared';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type PickedProduct = {
  id: string;
  title: string;
  sku: string | null;
  imageUrl: string | null;
};

/** How many products one search returns. Never the whole catalogue. */
const PICKER_LIMIT = 20;

/** How long typing must pause before a search goes out. */
const DEBOUNCE_MS = 250;

/**
 * Picks a product from **RS Products** — the canonical catalogue.
 *
 * Never the legacy `Product` master and never a `ShopifyVariant`: a mapping
 * names an `RsProduct`, because that is what the API validates against and
 * what the rest of the CRM is converging on.
 *
 * Search runs on the server, twenty rows at a time. The catalogue holds five
 * hundred products and will hold more, so it is never shipped to the browser to
 * be filtered locally — that would send half a megabyte to answer a question the
 * database can answer in a query.
 *
 * The request goes through the Next.js proxy (§16), which reads the httpOnly
 * session cookie server-side and attaches the bearer. No token reaches browser
 * JavaScript.
 *
 * Note the permission this depends on: `GET /api/rs-products` is guarded by
 * `RS_PRODUCTS:VIEW`. Somebody holding Vendor Invoices but not RS Products gets
 * the "no products" message rather than a silent empty box — see `denied`.
 */
export function RsProductPicker({
  value,
  onChange,
  disabled,
}: {
  value: PickedProduct | null;
  onChange: (product: PickedProduct | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PickedProduct[]>([]);
  const [denied, setDenied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, startLoading] = useTransition();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();

    const id = setTimeout(() => {
      startLoading(async () => {
        try {
          const params = new URLSearchParams({
            limit: String(PICKER_LIMIT),
            // Active products first; an archived one is rarely what somebody is
            // about to agree a price for.
            status: 'ACTIVE',
          });
          if (query) params.set('q', query);

          const response = await fetch(`/api/proxy/rs-products?${params}`, {
            signal: controller.signal,
          });
          const body = await response.json();

          if (!body.success) {
            // A permission failure is a different problem from an empty
            // catalogue, and saying so saves somebody hunting for products that
            // are there.
            setDenied(response.status === 403);
            setFailed(response.status !== 403);
            setOptions([]);
            return;
          }

          setDenied(false);
          setFailed(false);
          setOptions(
            (body.data.products as RsProductListRow[]).map((product) => ({
              id: product.id,
              title: product.title,
              sku: product.sku,
              imageUrl: product.imageUrl,
            })),
          );
        } catch {
          // An aborted request is the expected outcome of fast typing, and must
          // not be reported as a failure.
          if (!controller.signal.aborted) setFailed(true);
        }
      });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [open, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className={cn('truncate', !value && 'text-faint')}>
            {value ? value.title : 'Search the RS Products catalogue'}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        {/* shouldFilter={false}: the server has already filtered, and letting
            cmdk filter again would hide rows that legitimately matched. */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search by product name or SKU"
          />
          <CommandList>
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" />
                Searching
              </div>
            )}

            {!loading && denied && (
              <div className="px-3 py-6 text-center text-sm text-muted">
                You do not have access to the RS Products catalogue, so products cannot be listed
                here. An administrator can grant RS Products view access.
              </div>
            )}

            {!loading && failed && (
              <div className="px-3 py-6 text-center text-sm text-critical">
                The catalogue could not be reached. Try again in a moment.
              </div>
            )}

            {!loading && !denied && !failed && options.length === 0 && (
              <CommandEmpty>
                {query ? 'No products match that search.' : 'No products in the catalogue yet.'}
              </CommandEmpty>
            )}

            {!loading && !denied && !failed && options.length > 0 && (
              <CommandGroup>
                {options.map((product) => (
                  <CommandItem
                    key={product.id}
                    value={product.id}
                    onSelect={() => {
                      onChange(product);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'size-4 shrink-0 text-accent',
                        value?.id === product.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <ProductThumb url={product.imageUrl} alt={product.title} />
                    <span className="min-w-0 flex-1 truncate" title={product.title}>
                      {product.title}
                    </span>
                    {product.sku && (
                      <span className="shrink-0 font-mono text-[11px] text-muted">
                        {product.sku}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>

          {/* Says plainly that this is a page of results, not the catalogue. */}
          {!loading && !denied && !failed && options.length === PICKER_LIMIT && (
            <p className="border-t border-line px-3 py-2 text-[11px] text-muted">
              Showing the first {PICKER_LIMIT} matches. Keep typing to narrow the search.
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Shopify's own product photography, reused as it already is.
 *
 * A plain <img> rather than next/image: these are 24px thumbnails inside a
 * popover, and the optimiser's benefit at that size does not pay for a request
 * per keystroke's worth of results.
 */
function ProductThumb({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <span
        className="grid size-6 shrink-0 place-items-center rounded border border-line bg-surface-2 text-muted"
        aria-hidden="true"
      >
        <ImageOff className="size-3" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className="size-6 shrink-0 rounded border border-line object-cover"
    />
  );
}
