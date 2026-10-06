'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Search, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  COUNTRIES,
  CUSTOMER_TYPES,
  DEFAULT_COUNTRY,
  dialCodeFor,
  LEAD_CHANNELS,
  LEAD_CHANNEL_LABELS,
  LEAD_OTHER_MAX_LENGTH,
  LEAD_SOURCES,
  LEAD_SOURCE_DETAILS_MAX_LENGTH,
  LEAD_SOURCE_LABELS,
  REQUIREMENT_TYPES,
  REQUIREMENT_TYPE_LABELS,
  normalizePhone,
  type Country,
  type CustomerView,
  type LeadChannel,
  type IndiaState,
  type LeadSource,
  type RequirementType,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ErrorMessage } from '@/components/common/error-message';
import { CountryStateFields, customerStateOk } from '@/components/customers/country-state-fields';
import { createLeadAction, lookupCustomerByPhoneAction } from '@/app/(app)/create-lead/actions';
import { customerLabel, lookupState, type LookupState } from './lead-logic';

/**
 * Create Lead / Deal — Phase 1.
 *
 * Captures where an enquiry came from, when it happened, what kind of business
 * it is, who it is from and which channel carried it. Nothing else: no status,
 * no owner, no follow-up, no products. Those rules are not settled, and a field
 * added on a guess is one the business has to work around later.
 *
 * ### The customer half
 *
 * The form never creates a customer the user did not ask for. A phone number is
 * looked up as it is typed, and what happens next depends only on how many
 * customers came back:
 *
 *   none    Add Customer is offered, and the details are sent with the lead
 *   one     it is shown and linked, with no dialog at all
 *   several every one is listed and somebody has to pick — never auto-chosen
 *
 * The several case is not hypothetical: the live data carries duplicate numbers
 * from dummy and historical rows, and quietly picking the first would attach a
 * lead to the wrong person.
 */
export function CreateLeadForm() {
  const router = useRouter();

  // --- lead source ---------------------------------------------------------
  const [leadSource, setLeadSource] = useState<LeadSource | ''>('');
  const [leadSourceOther, setLeadSourceOther] = useState('');
  const [sourceDetails, setSourceDetails] = useState('');
  const [sourceAt, setSourceAt] = useState(localNow);

  // --- requirement ---------------------------------------------------------
  const [requirementType, setRequirementType] = useState<RequirementType | ''>('');

  // --- customer ------------------------------------------------------------
  const [country, setCountry] = useState<string>(DEFAULT_COUNTRY);
  /**
   * The national part only — what somebody types after the prefix.
   *
   * The full number is derived below rather than stored, for the same reason
   * promptness and volume are: two pieces of state holding the prefix and the
   * whole number would be free to disagree the moment the country changed.
   */
  const [localPhone, setLocalPhone] = useState('');
  const [email, setEmail] = useState('');
  const [matches, setMatches] = useState<CustomerView[]>([]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  // --- the new-customer half, shown only when nobody was found -------------
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<(typeof CUSTOMER_TYPES)[number]>('RETAIL');
  const [newState, setNewState] = useState('');

  // --- channel -------------------------------------------------------------
  const [channel, setChannel] = useState<LeadChannel | ''>('');
  const [channelOther, setChannelOther] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{ path: string; message: string }[]>([]);
  const [saving, startSaving] = useTransition();

  /*
    Debounced so a lookup runs when somebody stops typing rather than on every
    keystroke. The token guards against an older, slower response overwriting a
    newer one — without it, deleting digits quickly can leave the matches of a
    number no longer on screen.
  */
  const requestToken = useRef(0);

  /*
    The prefix for the chosen country, and the complete number the rest of this
    form works with. Derived, so the lookup, the validity check and the submit
    all see one value and the country select has nothing to keep in sync.

    A country with no code is impossible — COUNTRY_DIAL_CODES covers every entry
    in COUNTRIES, asserted by a test — but `dialCodeFor` returns null rather than
    throwing, and an absent prefix simply submits the digits as typed.
  */
  const dialCode = dialCodeFor(country);
  const phone = localPhone.trim() === '' ? '' : `${dialCode ?? ''}${localPhone.trim()}`;

  useEffect(() => {
    const digits = normalizePhone(phone);

    if (digits.length < 7) {
      setMatches([]);
      setChosenId(null);
      setSearched(false);
      setSearching(false);
      return;
    }

    const token = ++requestToken.current;
    setSearching(true);

    const timer = setTimeout(async () => {
      const result = await lookupCustomerByPhoneAction(phone);
      if (token !== requestToken.current) return;

      setSearching(false);
      setSearched(true);

      if (!result.ok) {
        setMatches([]);
        return;
      }

      const found = result.data.customers;
      setMatches(found);
      // Exactly one is linked without asking. Several never are.
      setChosenId(found.length === 1 ? found[0]!.id : null);
      setAdding(false);
    }, 400);

    return () => clearTimeout(timer);
  }, [phone]);

  const state: LookupState = lookupState({
    phone,
    searching,
    searched,
    matchCount: matches.length,
  });

  const needsSourceOther = leadSource === 'OTHER';
  const needsChannelOther = channel === 'OTHER';

  const customerReady = adding
    ? newName.trim() !== '' && phone.trim() !== '' && customerStateOk(country, newState)
    : chosenId !== null;

  const incomplete =
    leadSource === '' ||
    (needsSourceOther && leadSourceOther.trim() === '') ||
    sourceAt === '' ||
    requirementType === '' ||
    channel === '' ||
    (needsChannelOther && channelOther.trim() === '') ||
    !customerReady;

  const submit = () => {
    if (leadSource === '' || requirementType === '' || channel === '') return;
    setError(null);
    setDetails([]);

    startSaving(async () => {
      const result = await createLeadAction({
        leadSource,
        ...(needsSourceOther ? { leadSourceOther: leadSourceOther.trim() } : {}),
        ...(sourceDetails.trim() ? { sourceDetails: sourceDetails.trim() } : {}),
        // The input gives local wall-clock time; the contract wants an instant.
        sourceAt: new Date(sourceAt).toISOString(),
        requirementType,
        customer: adding
          ? {
              newCustomer: {
                name: newName.trim(),
                type: newType,
                phone: phone.trim(),
                ...(email.trim() ? { email: email.trim() } : {}),
                /*
                  Narrowed at the edge. Both lists come from @rs/shared and the
                  selects can only offer their members, but these are held as
                  plain strings so `CountryStateFields` can clear a state with
                  ''. The schema re-checks both server-side, so the assertion
                  widens nothing that is not already guaranteed.
                */
                country: country as Country,
                ...(newState ? { state: newState as IndiaState } : {}),
              },
            }
          : { customerId: chosenId! },
        channel,
        ...(needsChannelOther ? { channelOther: channelOther.trim() } : {}),
      });

      if (!result.ok) {
        setError(result.message);
        setDetails(result.details ?? []);
        return;
      }

      toast.success('Lead created.');
      router.push('/create-lead');
      router.refresh();
      resetForm();
    });
  };

  function resetForm(): void {
    setLeadSource('');
    setLeadSourceOther('');
    setSourceDetails('');
    setSourceAt(localNow());
    setRequirementType('');
    setLocalPhone('');
    setEmail('');
    setMatches([]);
    setChosenId(null);
    setSearched(false);
    setAdding(false);
    setNewName('');
    setNewState('');
    setChannel('');
    setChannelOther('');
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Lead source
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leadSource">Where did it come from?</Label>
              <Select value={leadSource} onValueChange={(v) => setLeadSource(v as LeadSource)}>
                <SelectTrigger id="leadSource">
                  <SelectValue placeholder="Choose a source" />
                </SelectTrigger>
                <SelectContent>
                  {LEAD_SOURCES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {LEAD_SOURCE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sourceAt">Date &amp; time</Label>
              {/* The moment the enquiry happened, which is often earlier than
                  the moment somebody sits down to record it. */}
              <Input
                id="sourceAt"
                type="datetime-local"
                value={sourceAt}
                onChange={(e) => setSourceAt(e.target.value)}
              />
            </div>
          </div>

          {needsSourceOther && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leadSourceOther">Name the source</Label>
              <Input
                id="leadSourceOther"
                value={leadSourceOther}
                onChange={(e) => setLeadSourceOther(e.target.value)}
                maxLength={LEAD_OTHER_MAX_LENGTH}
                placeholder="Where this lead actually came from"
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sourceDetails">Source details (optional)</Label>
            <Textarea
              id="sourceDetails"
              value={sourceDetails}
              onChange={(e) => setSourceDetails(e.target.value)}
              maxLength={LEAD_SOURCE_DETAILS_MAX_LENGTH}
              placeholder="A call note, a thread subject, an abandoned cart reference"
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Requirement type
          </h2>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="requirementType">What is the enquiry for?</Label>
            <Select
              value={requirementType}
              onValueChange={(v) => setRequirementType(v as RequirementType)}
            >
              <SelectTrigger id="requirementType">
                <SelectValue placeholder="Choose a requirement type" />
              </SelectTrigger>
              <SelectContent>
                {REQUIREMENT_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {REQUIREMENT_TYPE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Customer</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="country">Country</Label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger id="country">
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
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone">Phone number</Label>
              {/*
                The dial code comes from the country chosen beside this, so
                nobody types `+91` on every lead. It is a prefix on the field
                rather than a second dropdown: the country is already answered
                one input away, and asking twice invites the two to disagree.

                The submitted value is the prefix joined to what was typed —
                `+91` + `9876543210` — which matches how the existing customer
                rows are stored. `localPhone` holds only the national part, so
                changing the country re-prefixes without rewriting the digits.
              */}
              <div className="flex gap-2">
                <span
                  className="flex h-9 shrink-0 items-center rounded-md border border-line-2 bg-surface-2 px-2.5 text-sm tabular text-ink-2"
                  aria-label={`Dial code for ${country}`}
                >
                  {dialCode ?? '—'}
                </span>

                <div className="relative flex-1">
                  <Input
                    id="phone"
                    value={localPhone}
                    onChange={(e) => setLocalPhone(e.target.value)}
                    placeholder="9876543210"
                    className="tabular pr-9"
                    inputMode="tel"
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted" />
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email (optional)</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Only if they gave one"
            />
          </div>

          <CustomerLookupPanel
            state={state}
            matches={matches}
            chosenId={chosenId}
            adding={adding}
            onChoose={setChosenId}
            onAdd={() => setAdding(true)}
            onCancelAdd={() => setAdding(false)}
          />

          {adding && (
            <div className="grid gap-4 rounded-md border border-line p-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newCustomerName">Customer name</Label>
                <Input
                  id="newCustomerName"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Who the enquiry is from"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newCustomerType">Customer type</Label>
                <Select
                  value={newType}
                  onValueChange={(v) => setNewType(v as (typeof CUSTOMER_TYPES)[number])}
                >
                  <SelectTrigger id="newCustomerType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CUSTOMER_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.charAt(0) + t.slice(1).toLowerCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* The existing customer fields, reused rather than restated —
                  including the rule that an Indian customer names a State. */}
              <CountryStateFields
                country={country}
                state={newState}
                onCountryChange={setCountry}
                onStateChange={setNewState}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Channel</h2>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel">How did it arrive?</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as LeadChannel)}>
              <SelectTrigger id="channel">
                <SelectValue placeholder="Choose a channel" />
              </SelectTrigger>
              <SelectContent>
                {LEAD_CHANNELS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {LEAD_CHANNEL_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {needsChannelOther && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channelOther">Name the channel</Label>
              <Input
                id="channelOther"
                value={channelOther}
                onChange={(e) => setChannelOther(e.target.value)}
                maxLength={LEAD_OTHER_MAX_LENGTH}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {error && <ErrorMessage message={error} />}
      {details.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-critical">
          {details.map((detail) => (
            <li key={`${detail.path}-${detail.message}`}>{detail.message}</li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={submit} disabled={saving || incomplete}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Create lead
        </Button>
      </div>
    </div>
  );
}

/**
 * What the phone lookup found, in the five states it can be in.
 *
 * The several-matches case is the one worth reading: every customer is listed
 * and none is selected, so the lead cannot be created until somebody says which
 * person it belongs to.
 */
function CustomerLookupPanel({
  state,
  matches,
  chosenId,
  adding,
  onChoose,
  onAdd,
  onCancelAdd,
}: {
  state: LookupState;
  matches: CustomerView[];
  chosenId: string | null;
  adding: boolean;
  onChoose: (id: string) => void;
  onAdd: () => void;
  onCancelAdd: () => void;
}) {
  if (state === 'IDLE') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Search className="size-4" />
        Enter a phone number to look the customer up.
      </p>
    );
  }

  if (state === 'SEARCHING') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" />
        Looking for an existing customer…
      </p>
    );
  }

  if (state === 'NOT_FOUND') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line px-3 py-2.5">
        <span className="text-sm text-muted">
          No existing customer has this number.
        </span>
        {adding ? (
          <Button size="sm" variant="outline" onClick={onCancelAdd}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onAdd}>
            <UserPlus className="size-4" />
            Add Customer
          </Button>
        )}
      </div>
    );
  }

  if (state === 'ONE_MATCH') {
    const customer = matches[0]!;
    return (
      <div className="rounded-md border border-positive/30 bg-positive-soft p-3">
        <p className="flex items-center gap-2 text-sm font-medium text-positive">
          <Check className="size-4" />
          Existing customer found — this lead will be linked to them.
        </p>
        <p className="mt-1 text-sm text-ink">{customerLabel(customer)}</p>
      </div>
    );
  }

  /*
    Several customers share this number. Not the normal business case — a phone
    is meant to identify one customer — but the data contains it, so the form
    refuses to guess and makes somebody choose.
  */
  return (
    <div className="rounded-md border border-warning/30 bg-warning-soft p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-warning">
        <Users className="size-4" />
        {matches.length} customers share this number. Choose the right one.
      </p>

      <ul className="mt-2 flex flex-col gap-1.5">
        {matches.map((customer) => (
          <li key={customer.id}>
            <button
              type="button"
              onClick={() => onChoose(customer.id)}
              className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                chosenId === customer.id
                  ? 'border-accent bg-brass-soft text-ink'
                  : 'border-line bg-surface text-ink-2 hover:border-accent'
              }`}
            >
              {customerLabel(customer)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `datetime-local` wants local wall-clock time, not an ISO instant. */
function localNow(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}
