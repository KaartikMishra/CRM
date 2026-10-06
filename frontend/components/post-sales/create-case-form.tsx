'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Search } from 'lucide-react';
import {
  POST_SALES_CASE_TYPES,
  POST_SALES_CASE_TYPE_LABELS,
  POST_SALES_ISSUE_CATEGORY_LABELS,
  POST_SALES_ISSUE_GROUPS,
  POST_SALES_PRIORITIES,
  POST_SALES_PRIORITY_LABELS,
  type PostSalesCaseType,
  type PostSalesIssueCategory,
  type PostSalesPriority,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { formatDateTime } from '@/lib/format';
import { createCaseAction, fetchCustomerOrdersAction } from '@/app/(app)/post-sales/actions';

/**
 * Raising a case.
 *
 * Organised the way the work actually happens: find the customer, optionally pick
 * the order and the lines it concerns, say what kind of problem it is, describe it.
 *
 * ### What this form never does
 *
 *   - **It creates no customer.** A case points at an existing Customer; adding one
 *     is the Customer module's job, and a second creation path would mean two
 *     definitions of what a customer is.
 *   - **It sends no actor identity.** `raisedById` comes from the authenticated
 *     session on the server.
 *   - **It validates nothing the server does not validate again.** The cross-order
 *     checks below are there so somebody sees their mistake before submitting, not
 *     because the API trusts them.
 */

type Customer = { id: string; name: string; phone: string | null; email: string | null };
type OrderLine = { id: string; lineNo: number; productName: string; quantity: number };
type Order = {
  id: string;
  orderId: string;
  status: string;
  orderDate: string;
  items: OrderLine[];
};

export function CreateCaseForm() {
  const router = useRouter();

  // --- customer ------------------------------------------------------------
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [denied, setDenied] = useState(false);

  // --- order and lines -----------------------------------------------------
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderId, setOrderId] = useState<string | null>(null);
  /** salesOrderItemId -> affected quantity. Absent means not affected. */
  const [affected, setAffected] = useState<Record<string, number>>({});

  // --- classification ------------------------------------------------------
  const [caseType, setCaseType] = useState<PostSalesCaseType | ''>('');
  const [issueCategory, setIssueCategory] = useState<PostSalesIssueCategory | ''>('');
  const [priority, setPriority] = useState<PostSalesPriority>('MEDIUM');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{ path: string; message: string }[]>([]);
  const [saving, startSaving] = useTransition();

  /*
    Debounced so a search runs when somebody stops typing rather than on every
    keystroke — the same 400ms the lead form uses.
  */
  useEffect(() => {
    if (customer) return;
    if (query.trim().length < 2) {
      setMatches([]);
      setSearched(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/proxy/customers?q=${encodeURIComponent(query.trim())}&limit=20`,
          { signal: controller.signal },
        );
        const body = await res.json();

        setSearching(false);
        setSearched(true);

        if (!body.success) {
          // A permission failure is a different problem from an empty directory,
          // and saying so saves somebody hunting for customers that are there.
          setDenied(res.status === 403);
          setMatches([]);
          return;
        }
        setDenied(false);
        setMatches(body.data.customers as Customer[]);
      } catch {
        // An aborted request is the expected outcome of fast typing.
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 400);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, customer]);

  /*
    Orders follow the customer. Loaded from an endpoint scoped to that customer, so
    the picker can only ever offer their own orders — the authorisation is the URL,
    not a filter applied here.
  */
  useEffect(() => {
    if (!customer) {
      setOrders([]);
      setOrderId(null);
      setAffected({});
      return;
    }

    let live = true;
    void fetchCustomerOrdersAction(customer.id).then((result) => {
      if (!live) return;
      setOrders(result.ok ? result.data.orders : []);
    });
    return () => {
      live = false;
    };
  }, [customer]);

  const selectedOrder = orders.find((o) => o.id === orderId) ?? null;

  const ready =
    customer !== null &&
    caseType !== '' &&
    issueCategory !== '' &&
    subject.trim() !== '' &&
    description.trim() !== '';

  function submit(): void {
    /*
      One guard, which also narrows the two unions away from '' for the payload
      below. `ready` alone does not narrow them, because TypeScript cannot see
      through a boolean const.
    */
    if (customer === null || caseType === '' || issueCategory === '') return;
    if (subject.trim() === '' || description.trim() === '') return;

    setError(null);
    setDetails([]);

    const items = Object.entries(affected)
      .filter(([, qty]) => qty > 0)
      .map(([salesOrderItemId, affectedQty]) => ({ salesOrderItemId, affectedQty }));

    startSaving(async () => {
      const result = await createCaseAction({
        customerId: customer.id,
        ...(orderId ? { salesOrderId: orderId } : {}),
        caseType,
        issueCategory,
        priority,
        subject: subject.trim(),
        description: description.trim(),
        ...(items.length > 0 ? { items } : {}),
      });

      if (!result.ok) {
        setError(result.message);
        setDetails(result.details ?? []);
        return;
      }

      router.push(`/post-sales/cases/${result.data.case.id}`);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex flex-col gap-2">
          <ErrorMessage message={error} />
          {/* Field-level reasons the API returned, so somebody can fix the right one. */}
          {details.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-critical">
              {details.map((d) => (
                <li key={`${d.path}-${d.message}`}>
                  {d.path.split('.').pop()}: {d.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* --- customer --------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Customer</h2>

          {customer ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-2 bg-surface-2 p-3">
              <div>
                <p className="text-sm font-medium text-ink">{customer.name}</p>
                <p className="text-xs text-muted">
                  {[customer.phone, customer.email].filter(Boolean).join(' · ') || 'No contact'}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCustomer(null);
                  setQuery('');
                }}
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="customerSearch">Find the customer</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <Input
                  id="customerSearch"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Name, phone or email"
                  className="pl-9"
                />
                {searching && (
                  <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted" />
                )}
              </div>

              {denied && (
                <p className="text-xs text-critical">
                  You do not have permission to search customers.
                </p>
              )}

              {searched && !denied && matches.length === 0 && (
                <p className="text-xs text-muted">
                  No customer found. A case must belong to an existing customer — add them in
                  the Customer directory first.
                </p>
              )}

              {matches.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {matches.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setCustomer(c)}
                        className="flex w-full items-center justify-between gap-3 rounded-md border border-line-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
                      >
                        <span>
                          <span className="block text-sm text-ink">{c.name}</span>
                          <span className="block text-xs text-muted">
                            {[c.phone, c.email].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <Check className="size-4 shrink-0 text-faint" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- order and affected lines ----------------------------------- */}
      {customer && (
        <Card>
          <CardContent className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
                Order (optional)
              </h2>
              <p className="text-xs text-muted">
                A product question or a piece of feedback may not concern an order at all.
              </p>
            </div>

            {orders.length === 0 ? (
              <p className="text-xs text-muted">This customer has no orders on record.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {orders.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md border border-line-2 px-3 py-2 hover:bg-surface-2"
                  >
                    <input
                      type="radio"
                      name="order"
                      checked={orderId === o.id}
                      onChange={() => {
                        setOrderId(o.id);
                        // Lines belong to one order; switching clears the old pick.
                        setAffected({});
                      }}
                      className="size-4"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm tabular text-ink">{o.orderId}</span>
                      <span className="block text-xs text-muted">
                        {formatDateTime(o.orderDate)} · {o.status} · {o.items.length} line(s)
                      </span>
                    </span>
                  </label>
                ))}

                {orderId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-fit"
                    onClick={() => {
                      setOrderId(null);
                      setAffected({});
                    }}
                  >
                    Clear order
                  </Button>
                )}
              </div>
            )}

            {selectedOrder && selectedOrder.items.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-ink-2">
                  Affected products (optional)
                </span>
                {selectedOrder.items.map((line) => {
                  const qty = affected[line.id] ?? 0;
                  return (
                    <div
                      key={line.id}
                      className="flex flex-wrap items-center gap-3 rounded-md border border-line-2 px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={qty > 0}
                        onChange={(e) =>
                          setAffected((prev) => {
                            const next = { ...prev };
                            if (e.target.checked) next[line.id] = 1;
                            else delete next[line.id];
                            return next;
                          })
                        }
                        className="size-4"
                        aria-label={`Line ${line.lineNo} affected`}
                      />
                      <span className="min-w-0 flex-1 text-sm text-ink">
                        <span className="text-muted">{line.lineNo}.</span> {line.productName}
                        <span className="ml-2 text-xs text-muted">({line.quantity} bought)</span>
                      </span>

                      {qty > 0 && (
                        <label className="flex items-center gap-2 text-xs text-muted">
                          Affected
                          <Input
                            type="number"
                            min={1}
                            max={line.quantity}
                            value={qty}
                            onChange={(e) =>
                              setAffected((prev) => ({
                                ...prev,
                                [line.id]: Number(e.target.value),
                              }))
                            }
                            className="h-8 w-20 tabular"
                            aria-label={`Affected quantity for line ${line.lineNo}`}
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* --- classification --------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            What is the problem?
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="caseType">Case type</Label>
              <select
                id="caseType"
                value={caseType}
                onChange={(e) => setCaseType(e.target.value as PostSalesCaseType)}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
              >
                <option value="">Choose…</option>
                {POST_SALES_CASE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {POST_SALES_CASE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="issueCategory">Issue</Label>
              {/* Grouped for reading only; the stored value is the flat enum. */}
              <select
                id="issueCategory"
                value={issueCategory}
                onChange={(e) => setIssueCategory(e.target.value as PostSalesIssueCategory)}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
              >
                <option value="">Choose…</option>
                {POST_SALES_ISSUE_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.categories.map((c) => (
                      <option key={c} value={c}>
                        {POST_SALES_ISSUE_CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-2">Priority</span>
            <div className="flex flex-wrap gap-2">
              {POST_SALES_PRIORITIES.map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={p === priority ? 'default' : 'outline'}
                  aria-pressed={p === priority}
                  onClick={() => setPriority(p)}
                >
                  {POST_SALES_PRIORITY_LABELS[p]}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted">
              Judged by you. Nothing is inferred from order value or customer history.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="One line — what the customer is reporting"
              maxLength={300}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What the customer said, in as much detail as you have"
              rows={5}
              maxLength={5000}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={submit} disabled={!ready || saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Create case
        </Button>
        {!ready && (
          <p className="text-xs text-muted">
            A customer, a case type, an issue, a subject and a description are required.
          </p>
        )}
      </div>

      {/*
        Attachments and assignment come after creation, on the case itself. The case
        has to exist before a photo can belong to it, and allocating is a separate
        capability — somebody who may raise a case may not be able to assign it.
      */}
      <p className="text-xs text-muted">
        Attachments and assignment are added on the case once it exists.
      </p>
    </div>
  );
}
