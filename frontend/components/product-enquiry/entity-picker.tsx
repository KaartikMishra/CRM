'use client';

import { useEffect, useState, useTransition } from 'react';
import { Check, ChevronsUpDown, Loader2, Plus } from 'lucide-react';
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

export type PickerOption = { id: string; label: string; hint?: string };

/**
 * Searchable picker for a master record — a customer or a vendor.
 *
 * Search runs on the server: the query goes through the Next.js proxy, which
 * attaches the session token and forwards to Express (§16). No token reaches
 * browser JavaScript, and the full master list is never shipped to the client.
 */
export function EntityPicker({
  value,
  onChange,
  endpoint,
  placeholder,
  emptyLabel,
  onCreate,
  disabled,
}: {
  value: PickerOption | null;
  onChange: (option: PickerOption | null) => void;
  /** Proxy path, e.g. "customers" or "vendors". */
  endpoint: 'customers' | 'vendors';
  placeholder: string;
  emptyLabel: string;
  onCreate?: (query: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [loading, startLoading] = useTransition();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();

    const id = setTimeout(() => {
      startLoading(async () => {
        try {
          const params = new URLSearchParams({ limit: '20' });
          if (query) params.set('q', query);
          const res = await fetch(`/api/proxy/${endpoint}?${params}`, {
            signal: controller.signal,
          });
          const body = await res.json();
          if (!body.success) {
            setOptions([]);
            return;
          }
          const rows = endpoint === 'customers' ? body.data.customers : body.data.vendors;
          setOptions(
            rows.map((row: { id: string; name: string; type?: string; city?: string }) => ({
              id: row.id,
              label: row.name,
              hint: row.type ?? row.city ?? undefined,
            })),
          );
        } catch {
          // An aborted request is the expected outcome of fast typing.
        }
      });
    }, 250);

    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [open, query, endpoint]);

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
            {value ? value.label : placeholder}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={placeholder} />
          <CommandList>
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" />
                Searching
              </div>
            )}

            {!loading && options.length === 0 && <CommandEmpty>{emptyLabel}</CommandEmpty>}

            {!loading && options.length > 0 && (
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    onSelect={() => {
                      onChange(option);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'size-4 shrink-0 text-accent',
                        value?.id === option.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint && (
                      <span className="shrink-0 text-xs text-muted">
                        {option.hint.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>

          {onCreate && (
            <div className="border-t border-line p-1">
              <button
                type="button"
                onClick={() => {
                  onCreate(query);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm text-accent hover:bg-surface-2"
              >
                <Plus className="size-4" />
                {query ? `Add "${query}"` : 'Add new'}
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
