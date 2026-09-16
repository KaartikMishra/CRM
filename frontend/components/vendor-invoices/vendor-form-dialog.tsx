'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { VendorListRow } from '@rs/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { createVendorAction, updateVendorAction } from '@/app/(app)/vendor-invoices/actions';

/**
 * Add and edit a vendor, in one form.
 *
 * The two differ only in which action they call and what they start from, so
 * they share a component: keeping two nearly identical forms in step by hand is
 * how the edit path quietly loses a field.
 *
 * `isActive` is **not** here, and that is deliberate. Archiving a vendor is its
 * own operation behind its own permission (DELETE, not EDIT), with its own
 * confirmation explaining what is preserved. A checkbox in this form would let
 * an edit do what archiving is meant to guard — and the backend strips the
 * field anyway, so a control for it would be a lie.
 *
 * Only the name is required. Everything else is genuinely optional: a vendor
 * reached solely on WhatsApp has no email, and demanding one would mean staff
 * inventing one.
 */

type Fields = {
  name: string;
  companyName: string;
  contactPerson: string;
  phone: string;
  altPhone: string;
  email: string;
  city: string;
  address: string;
};

const blank: Fields = {
  name: '',
  companyName: '',
  contactPerson: '',
  phone: '',
  altPhone: '',
  email: '',
  city: '',
  address: '',
};

const fromVendor = (vendor: VendorListRow): Fields => ({
  name: vendor.name,
  companyName: vendor.companyName ?? '',
  contactPerson: vendor.contactPerson ?? '',
  phone: vendor.phone ?? '',
  altPhone: vendor.altPhone ?? '',
  email: vendor.email ?? '',
  city: vendor.city ?? '',
  address: vendor.address ?? '',
});

/**
 * Drops the blanks.
 *
 * The API's optional fields reject an empty string — they are absent or they
 * are valid — so an untouched box must not be sent at all.
 */
function payload(fields: Fields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/**
 * Fields a blanked box can actually clear.
 *
 * PATCH is a partial update, so omitting a field leaves it as it was. Emptying
 * a box therefore has to send *something* to mean "remove this", and an empty
 * string is what the backend's optional text schemas accept.
 *
 * `phone`, `altPhone` and `email` are deliberately absent: their schemas
 * validate the format, so an empty string fails with "Enter a valid phone
 * number" — a confusing error on a field somebody deliberately emptied. Until
 * the contract offers a way to clear them, blanking one of those boxes leaves
 * the stored value alone rather than showing a validation error that misstates
 * what happened. See CLEARABLE_NOTE, which says so in the form.
 */
const CLEARABLE = ['companyName', 'address', 'city', 'contactPerson'] as const;

/**
 * Builds the PATCH body, clearing what can be cleared.
 *
 * A field that had a value and now has none is sent as an empty string when the
 * schema accepts one, and otherwise omitted — never sent as a value that would
 * be rejected.
 */
function editPayload(fields: Fields, original: Fields): Record<string, string> {
  const out = payload(fields);
  for (const key of CLEARABLE) {
    if (original[key].trim() && !fields[key].trim()) out[key] = '';
  }
  return out;
}

export function VendorFormDialog({
  open,
  onOpenChange,
  vendor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent for a new vendor; present to edit an existing one. */
  vendor?: VendorListRow;
}) {
  const router = useRouter();
  const [fields, setFields] = useState<Fields>(blank);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{ path: string; message: string }[]>([]);
  const [pending, startTransition] = useTransition();

  const editing = Boolean(vendor);

  // Reopening must not show the last attempt's values or its error.
  useEffect(() => {
    if (!open) return;
    setFields(vendor ? fromVendor(vendor) : blank);
    setError(null);
    setDetails([]);
  }, [open, vendor]);

  const set = (key: keyof Fields) => (value: string) =>
    setFields((current) => ({ ...current, [key]: value }));

  const fieldError = (name: keyof Fields): string | undefined =>
    details.find((detail) => detail.path === name || detail.path.endsWith(`.${name}`))?.message;

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDetails([]);

    if (!fields.name.trim()) {
      setDetails([{ path: 'name', message: 'Vendor name is required' }]);
      return;
    }

    startTransition(async () => {
      const result = vendor
        ? await updateVendorAction(vendor.id, editPayload(fields, fromVendor(vendor)))
        : await createVendorAction(payload(fields) as { name: string });

      if (!result.ok) {
        setError(result.message);
        setDetails(result.details ?? []);
        return;
      }

      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${vendor?.name}` : 'Add vendor'}</DialogTitle>
          <DialogDescription>
            Only the vendor name is required. Everything else can be filled in later.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {error && <ErrorMessage message={error} />}

          {/* Said once, here, rather than left to be discovered by a change
              that appears to save and does not. See CLEARABLE above. */}
          {editing && (
            <p className="text-xs text-muted">
              To remove a phone number or email address, replace it rather than clearing the box —
              an emptied number or address is left unchanged.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="vendor-name"
              label="Vendor name"
              required
              value={fields.name}
              onChange={set('name')}
              error={fieldError('name')}
              placeholder="Devansh Brass"
              disabled={pending}
            />
            <Field
              id="vendor-company"
              label="Company"
              value={fields.companyName}
              onChange={set('companyName')}
              error={fieldError('companyName')}
              placeholder="Devansh Brass Works"
              disabled={pending}
            />
            <Field
              id="vendor-phone"
              label="WhatsApp / Phone"
              value={fields.phone}
              onChange={set('phone')}
              error={fieldError('phone')}
              placeholder="+91 98765 43210"
              disabled={pending}
              hint="The primary number, treated as WhatsApp."
            />
            <Field
              id="vendor-alt-phone"
              label="Additional number"
              value={fields.altPhone}
              onChange={set('altPhone')}
              error={fieldError('altPhone')}
              placeholder="+91 98765 43211"
              disabled={pending}
            />
            <Field
              id="vendor-email"
              label="Email"
              type="email"
              value={fields.email}
              onChange={set('email')}
              error={fieldError('email')}
              placeholder="accounts@example.com"
              disabled={pending}
            />
            <Field
              id="vendor-contact"
              label="Contact person"
              value={fields.contactPerson}
              onChange={set('contactPerson')}
              error={fieldError('contactPerson')}
              placeholder="Rakesh"
              disabled={pending}
            />
            <Field
              id="vendor-city"
              label="City"
              value={fields.city}
              onChange={set('city')}
              error={fieldError('city')}
              placeholder="Moradabad"
              disabled={pending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vendor-address">Address</Label>
            <Textarea
              id="vendor-address"
              value={fields.address}
              onChange={(event) => set('address')(event.target.value)}
              placeholder="14 Station Road, Moradabad, Uttar Pradesh"
              rows={2}
              disabled={pending}
            />
            {fieldError('address') && (
              <p className="text-xs text-critical">{fieldError('address')}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending
                ? editing
                  ? 'Saving…'
                  : 'Adding…'
                : editing
                  ? 'Save changes'
                  : 'Add vendor'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  placeholder,
  disabled,
  required,
  type = 'text',
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  type?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-critical">*</span>}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="text-xs text-critical">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted">{hint}</p>
      )}
    </div>
  );
}
