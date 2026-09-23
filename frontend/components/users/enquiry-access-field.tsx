'use client';

import type { EnquiryAccess } from '@rs/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * The two Product Enquiry capabilities, held independently.
 *
 * Checkboxes and not radios, because this is not a choice between two jobs.
 * Somebody can be a Raiser, an Answerer, both, or neither — a person who takes
 * enquiries at the counter and also prices them is one checkbox each, not a
 * third role invented to describe the combination.
 *
 * Shown only when the Product Enquiry module is granted: the capabilities say
 * what somebody may do *inside* the module, so they mean nothing until they are
 * in it.
 */

const CAPABILITIES: {
  key: keyof EnquiryAccess;
  title: string;
  detail: string;
}[] = [
  {
    key: 'raiser',
    title: 'Raiser',
    detail: 'Can create enquiries and view customer information.',
  },
  {
    key: 'answerer',
    title: 'Answerer',
    detail: 'Can view enquiries and handle vendor responses.',
  },
];

export function EnquiryAccessField({
  value,
  onChange,
  disabled = false,
  idPrefix,
}: {
  value: EnquiryAccess;
  onChange: (next: EnquiryAccess) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Product Enquiry access
      </legend>

      <div className="mt-2.5 grid gap-px overflow-hidden rounded-md border border-line bg-line">
        {CAPABILITIES.map(({ key, title, detail }) => {
          const id = `${idPrefix}-enquiry-${key}`;
          const active = value[key];

          return (
            <div
              key={key}
              className={cn(
                'flex items-start gap-2.5 bg-surface px-3 py-2.5 transition-colors',
                active && 'bg-brass-soft',
                disabled && 'opacity-60',
              )}
            >
              <Checkbox
                id={id}
                checked={active}
                // Each toggles on its own — selecting one never clears the other.
                onCheckedChange={(next) => onChange({ ...value, [key]: next === true })}
                className="mt-0.5"
              />
              <Label htmlFor={id} className="cursor-pointer font-normal">
                <span className={cn('block text-sm', active ? 'text-ink' : 'text-ink-2')}>
                  {title}
                </span>
                <span className="mt-0.5 block text-xs text-muted">{detail}</span>
              </Label>
            </div>
          );
        })}
      </div>

      {!value.raiser && !value.answerer && (
        <p className="mt-2 text-xs text-muted">
          Neither selected — this person can read enquiries but cannot raise one or answer it.
        </p>
      )}
    </fieldset>
  );
}
