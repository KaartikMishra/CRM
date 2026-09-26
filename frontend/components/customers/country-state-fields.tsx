'use client';

import { COUNTRIES, DEFAULT_COUNTRY, INDIA_STATES, customerStateSchema } from '@rs/shared';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * The Country and State pair, in one place.
 *
 * These two fields are not independent: `state` is closed to the States and
 * Union Territories of India, so it applies within India and nowhere else. That
 * rule already lives in the shared customer schema, which is what actually
 * enforces it — this exists so every form that asks for the pair *behaves* the
 * same way, rather than each one restating it.
 *
 * It exists because they did not. The Sales dialog and the Product Enquiry
 * dialog were two hand-written copies of the same two fields, the rule was
 * added to one of them, and the other went on offering Indian states to a
 * customer in Honduras. A second copy is how that happened; removing the copy
 * is the fix.
 */

/** Whether a state may be recorded at all for this country. */
export const stateApplies = (country: string): boolean => country === DEFAULT_COUNTRY;

/**
 * The form's read of the shared rule: required within India, absent outside it.
 *
 * Deliberately a mirror and never the authority. The schema refuses the same
 * combinations server-side, so this only decides whether the Add button is
 * offered — a form that gets it wrong is a nuisance, not a hole.
 */
export function customerStateOk(country: string, state: string): boolean {
  return stateApplies(country)
    ? customerStateSchema.safeParse(state).success
    : state === '';
}

/** The message for a state that does not fit its country. */
export const customerStateError = (country: string): string =>
  stateApplies(country)
    ? 'Choose a state'
    : `A state is only recorded for a customer in ${DEFAULT_COUNTRY}`;

export function CountryStateFields({
  country,
  state,
  onCountryChange,
  onStateChange,
  stateError,
  countryError,
  disabled = false,
}: {
  country: string;
  state: string;
  onCountryChange: (next: string) => void;
  /** Called with '' when the country moves away from India. */
  onStateChange: (next: string) => void;
  stateError?: string;
  countryError?: string;
  disabled?: boolean;
}) {
  const applies = stateApplies(country);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="newCustomerState">State{applies ? '' : ' (India only)'}</Label>
        <Select value={state} onValueChange={onStateChange} disabled={disabled || !applies}>
          <SelectTrigger id="newCustomerState">
            <SelectValue placeholder={applies ? 'Select state' : 'Not applicable'} />
          </SelectTrigger>
          <SelectContent>
            {INDIA_STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {stateError && <p className="text-xs text-critical">{stateError}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="newCustomerCountry">Country</Label>
        <Select
          value={country}
          onValueChange={(next) => {
            onCountryChange(next);
            /*
              Cleared, not merely disabled.

              A disabled Select keeps whatever it held, and that value would go
              on being submitted — which the server now refuses, turning a
              silent contradiction into a failure at save time instead of
              preventing it. Clearing here is what makes "disabled" mean
              "absent".
            */
            if (!stateApplies(next)) onStateChange('');
          }}
          disabled={disabled}
        >
          <SelectTrigger id="newCustomerCountry">
            <SelectValue placeholder="Select country" />
          </SelectTrigger>
          <SelectContent>
            {COUNTRIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {countryError && <p className="text-xs text-critical">{countryError}</p>}
      </div>
    </>
  );
}
