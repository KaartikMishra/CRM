'use client';

import { Plus, X } from 'lucide-react';
import {
  SALES_CHARGE_MAX,
  SALES_CHARGE_TYPE_LABELS,
  SALES_CHARGE_TYPES,
  isValidAmount,
} from '@rs/shared';
import type { SalesChargeType } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * Order-level charges and adjustments: duty, packing, shipping, customization,
 * a discount, or something the list does not name.
 *
 * A list rather than six fixed fields, because an order can carry two shipping
 * legs or none at all. Every amount is entered positive; DISCOUNT is what makes
 * a row subtract, which is also why the type is chosen first and the hint
 * underneath changes with it.
 */

export type ChargeDraft = {
  key: string;
  type: SalesChargeType;
  label: string;
  amount: string;
};

export function ChargesEditor({
  charges,
  onChange,
  disabled = false,
}: {
  charges: ChargeDraft[];
  onChange: (next: ChargeDraft[]) => void;
  disabled?: boolean;
}) {
  const atCap = charges.length >= SALES_CHARGE_MAX;

  const update = (key: string, patch: Partial<ChargeDraft>) =>
    onChange(charges.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  const add = () =>
    onChange([
      ...charges,
      { key: `c${Date.now()}${charges.length}`, type: 'SHIPPING', label: '', amount: '' },
    ]);

  return (
    <div className="flex flex-col gap-3">
      {charges.length === 0 && (
        <p className="text-sm text-muted">
          No additional charges. Add duty, packing, shipping, customization or a discount if this
          order carries any.
        </p>
      )}

      {charges.map((charge) => {
        const isDiscount = charge.type === 'DISCOUNT';
        // Blank is not an error yet — somebody has only just added the row.
        const amountBad = charge.amount.trim() !== '' && !isValidAmount(charge.amount.trim());

        return (
          <div
            key={charge.key}
            className="grid gap-3 rounded-md border border-line bg-surface-2 p-3 sm:grid-cols-[170px_1fr_140px_auto] sm:items-start"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`charge-type-${charge.key}`} className="sr-only">
                Charge type
              </Label>
              <Select
                value={charge.type}
                onValueChange={(next) => update(charge.key, { type: next as SalesChargeType })}
                disabled={disabled}
              >
                <SelectTrigger id={`charge-type-${charge.key}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SALES_CHARGE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {SALES_CHARGE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`charge-label-${charge.key}`} className="sr-only">
                What this charge is for
              </Label>
              <Input
                id={`charge-label-${charge.key}`}
                value={charge.label}
                onChange={(e) => update(charge.key, { label: e.target.value })}
                placeholder="Optional note, e.g. air freight Mumbai–Dubai"
                disabled={disabled}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`charge-amount-${charge.key}`} className="sr-only">
                Amount
              </Label>
              <Input
                id={`charge-amount-${charge.key}`}
                inputMode="decimal"
                value={charge.amount}
                onChange={(e) => update(charge.key, { amount: e.target.value })}
                placeholder="0.00"
                disabled={disabled}
                className={cn('tabular', isDiscount && 'text-critical')}
              />
              {amountBad ? (
                <p className="text-xs text-critical">Enter an amount like 250.00</p>
              ) : (
                <p className="text-xs text-muted">{isDiscount ? 'Subtracted' : 'Added'}</p>
              )}
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={() => onChange(charges.filter((c) => c.key !== charge.key))}
              aria-label={`Remove ${SALES_CHARGE_TYPE_LABELS[charge.type]} charge`}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}

      <div>
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled || atCap}>
          <Plus className="size-4" />
          Add charge
        </Button>
        {atCap && (
          <p className="mt-1.5 text-xs text-muted">
            An order can hold at most {SALES_CHARGE_MAX} charges.
          </p>
        )}
      </div>
    </div>
  );
}

/** Drops the rows somebody added but never filled in, and shapes the rest. */
export function usableCharges(
  charges: readonly ChargeDraft[],
): { type: SalesChargeType; label?: string; amount: string }[] {
  return charges
    .filter((c) => c.amount.trim() !== '' && isValidAmount(c.amount.trim()))
    .map((c) => ({
      type: c.type,
      ...(c.label.trim() ? { label: c.label.trim() } : {}),
      amount: c.amount.trim(),
    }));
}
