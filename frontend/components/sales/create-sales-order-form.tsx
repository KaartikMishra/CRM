'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { Loader2, Mail, Phone, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  CUSTOMER_TYPES,
  MAX_ITEMS_PER_SALES_ORDER,
  createSalesOrderSchema,
  customerAddressSchema,
  customerEmailSchema,
  customerPhoneSchema,
  isValidAmount,
  lineTotal,
  subtractAmount,
  sumItemTotals,
  type CreateSalesOrderInput,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { EntityPicker, type PickerOption } from '@/components/product-enquiry/entity-picker';
import { ImageUploadField } from '@/components/product-enquiry/image-upload-field';
import { formatCurrency, label } from '@/lib/format';
import { createSalesCustomerAction, createSalesOrderAction } from '@/app/(app)/sales/actions';

const today = (): string => new Date().toISOString().slice(0, 10);

type ItemDraft = {
  /** Optional catalogue link; free text stays valid when this is null. */
  productId: string | null;
  key: string;
  productName: string;
  quantity: string;
  price: string;
  imageAssetId: string | null;
};

/**
 * Row keys must be identical on the server and on the client.
 *
 * The same hydration trap the enquiry form documents: a key derived from
 * `crypto.randomUUID()` or a module counter differs between the two renders.
 * The first row's key is fixed, and rows added later get theirs from a ref that
 * only ever advances on a click — which is client-side, after hydration.
 */
const emptyItem = (key: string): ItemDraft => ({
  key,
  productId: null,
  productName: '',
  quantity: '',
  price: '',
  imageAssetId: null,
});

/**
 * The create form.
 *
 * Validation runs against the same Zod schema the backend uses, so a field
 * error here is the error the API would have returned — and the API still
 * validates independently.
 *
 * Line totals, the order total and the pending amount are rendered as read-only
 * text rather than inputs. They are derived by the backend and have no column
 * of their own; showing them live is a preview computed with the same exact
 * decimal helpers the server uses, never a value that gets submitted.
 */
export function CreateSalesOrderForm({
  products = [],
}: {
  /** The catalogue, for the product suggestions. Empty is fine — free text still works. */
  products?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const formId = useId();
  const nextKey = useRef(1);

  const [orderId, setOrderId] = useState('');
  const [customer, setCustomer] = useState<PickerOption | null>(null);
  const [items, setItems] = useState<ItemDraft[]>(() => [emptyItem('i0')]);
  const [paidAmount, setPaidAmount] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [dispatchBy, setDispatchBy] = useState(today);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; code?: string } | null>(null);

  // Inline customer creation
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerType, setNewCustomerType] =
    useState<(typeof CUSTOMER_TYPES)[number]>('RETAIL');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [newCustomerEmail, setNewCustomerEmail] = useState('');
  const [newCustomerAddress, setNewCustomerAddress] = useState('');
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [customerErrors, setCustomerErrors] = useState<Record<string, string>>({});

  // Validated with the same schemas the API uses, so the dialog refuses exactly
  // what the server would. Phone is required here — an order that needs chasing
  // is far easier to chase with a number on it — while email stays optional.
  const nameOk = newCustomerName.trim().length >= 2;
  const phoneOk = customerPhoneSchema.safeParse(newCustomerPhone).success;
  const emailOk =
    newCustomerEmail.trim() === '' || customerEmailSchema.safeParse(newCustomerEmail).success;
  const addressOk =
    newCustomerAddress.trim() === '' ||
    customerAddressSchema.safeParse(newCustomerAddress).success;
  const customerReady = nameOk && phoneOk && emailOk && addressOk;

  const atCap = items.length >= MAX_ITEMS_PER_SALES_ORDER;

  const updateItem = (key: string, patch: Partial<ItemDraft>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const addItem = () => {
    if (atCap) {
      toast.error(`An order can hold at most ${MAX_ITEMS_PER_SALES_ORDER} products.`);
      return;
    }
    setItems((list) => [...list, emptyItem(`i${nextKey.current++}`)]);
  };

  const removeItem = (key: string) =>
    setItems((list) => (list.length === 1 ? list : list.filter((i) => i.key !== key)));

  // --- the derived preview ------------------------------------------------
  // Computed per line only where that line's own inputs are valid; a malformed
  // price would otherwise throw inside the exact-decimal helpers.
  const priceable = (item: ItemDraft) => {
    const qty = Number(item.quantity);
    return Number.isInteger(qty) && qty >= 1 && isValidAmount(item.price.trim());
  };
  const lineTotalOf = (item: ItemDraft): string | null =>
    priceable(item) ? lineTotal(item.price.trim(), Number(item.quantity)) : null;

  const allPriceable = items.every(priceable);
  const total = allPriceable
    ? sumItemTotals(items.map((i) => ({ quantity: Number(i.quantity), price: i.price.trim() })))
    : null;

  const paidForPreview = paidAmount.trim() === '' ? '0.00' : paidAmount.trim();
  const derivedPending =
    total && isValidAmount(paidForPreview) ? subtractAmount(total, paidForPreview) : null;

  function buildInput(): CreateSalesOrderInput | null {
    const candidate = {
      orderId: orderId.trim(),
      customerId: customer?.id ?? '',
      items: items.map((item) => ({
        productName: item.productName.trim(),
        ...(item.productId ? { productId: item.productId } : {}),
        quantity: item.quantity.trim() === '' ? Number.NaN : Number(item.quantity),
        price: item.price.trim(),
        ...(item.imageAssetId ? { productImageAssetId: item.imageAssetId } : {}),
      })),
      paidAmount: paidAmount.trim() === '' ? '0' : paidAmount.trim(),
      orderDate,
      toBeDispatchedBy: dispatchBy,
    };

    const parsed = createSalesOrderSchema.safeParse(candidate);

    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        if (!errors[path]) errors[path] = issue.message;
      }
      setFieldErrors(errors);
      setFormError({ message: 'Some details need fixing before this can be submitted.' });
      return null;
    }

    setFieldErrors({});
    setFormError(null);
    return parsed.data;
  }

  function submit() {
    const input = buildInput();
    if (!input) return;

    startTransition(async () => {
      const result = await createSalesOrderAction(input);

      if (!result.ok) {
        // The backend is authoritative; surface exactly what it said.
        setFormError({ message: result.message, ...(result.code ? { code: result.code } : {}) });
        if (result.details) {
          setFieldErrors(Object.fromEntries(result.details.map((d) => [d.path, d.message])));
        }
        toast.error(result.message);
        return;
      }

      toast.success(`Order ${result.data.order.orderId} created`);
      router.push(`/sales/${result.data.order.id}`);
    });
  }

  function createCustomer() {
    const errors: Record<string, string> = {};
    if (!nameOk) errors.name = 'Customer name is required';
    if (!phoneOk) {
      errors.phone =
        customerPhoneSchema.safeParse(newCustomerPhone).error?.issues[0]?.message ??
        'Enter a valid phone number';
    }
    if (!emailOk) errors.email = 'Enter a valid email address';
    if (!addressOk) errors.address = 'Keep the address under 500 characters';
    setCustomerErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setCreatingCustomer(true);

    startTransition(async () => {
      const result = await createSalesCustomerAction({
        name: newCustomerName.trim(),
        type: newCustomerType,
        // Omitted entirely when blank: the schema treats these as optional, and
        // an empty string would fail its format check rather than mean "none".
        ...(newCustomerPhone.trim() ? { phone: newCustomerPhone.trim() } : {}),
        ...(newCustomerEmail.trim() ? { email: newCustomerEmail.trim() } : {}),
        ...(newCustomerAddress.trim() ? { address: newCustomerAddress.trim() } : {}),
      });
      setCreatingCustomer(false);

      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      setCustomer({
        id: result.data.customer.id,
        label: result.data.customer.name,
        phone: newCustomerPhone.trim() || null,
        email: newCustomerEmail.trim() || null,
      });
      setCustomerDialogOpen(false);
      setNewCustomerName('');
      setNewCustomerPhone('');
      setNewCustomerEmail('');
      setNewCustomerAddress('');
      setCustomerErrors({});
      toast.success('Customer added');
    });
  }

  const err = (path: string) => fieldErrors[path];

  return (
    <div className="flex flex-col gap-6">
      {formError && <ErrorMessage message={formError.message} code={formError.code} />}

      {/* ---------------- Order & customer ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order &amp; customer</CardTitle>
          <CardDescription>
            The order ID is entered by hand so a Shopify number or a handwritten one can be recorded
            exactly as it arrived.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-5 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="orderId">Order ID</Label>
            <Input
              id="orderId"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="#1001"
              className="tabular"
            />
            {err('orderId') && <p className="text-xs text-critical">{err('orderId')}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="customer">Customer</Label>
            <EntityPicker
              value={customer}
              onChange={setCustomer}
              endpoint="customers"
              placeholder="Search customers"
              emptyLabel="No customer found"
              onCreate={(q) => {
                setNewCustomerName(q);
                setCustomerDialogOpen(true);
              }}
            />
            {err('customerId') && <p className="text-xs text-critical">{err('customerId')}</p>}
          </div>

          {/*
            The selected customer's contact details, read-only.

            Shown rather than edited on purpose: this form records an order, and
            silently rewriting a master record from here — especially blanking a
            number with an empty field — is exactly the accident worth avoiding.
            New customers capture theirs in the dialog below.
          */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-2">Contact</span>
            {customer ? (
              <div className="flex min-h-10 flex-col justify-center gap-1 rounded-md border border-line bg-surface-2 px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-ink-2">
                  <Phone className="size-3 shrink-0 text-faint" />
                  <span className="tabular">{customer.phone || 'Not recorded'}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs text-ink-2">
                  <Mail className="size-3 shrink-0 text-faint" />
                  <span className="truncate">{customer.email || 'Not recorded'}</span>
                </span>
              </div>
            ) : (
              <div className="flex h-10 items-center rounded-md border border-line bg-surface-2 px-3 text-xs text-faint">
                Select a customer
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------------- Products ---------------- */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Products</CardTitle>
            <CardDescription className="mt-1">
              Everything on this order, one line each. Totals are calculated for you.
            </CardDescription>
          </div>
          <span className="shrink-0 font-mono text-sm text-muted tabular">
            {items.length} / {MAX_ITEMS_PER_SALES_ORDER}
          </span>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {err('items') && <ErrorMessage message={err('items')!} />}

          {items.map((item, index) => (
            <div key={item.key} className="rounded-md border border-line bg-surface-2/40 p-4">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-mono text-xs font-medium uppercase tracking-wider text-muted tabular">
                  Product {String(index + 1).padStart(2, '0')}
                </span>
                {items.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeItem(item.key)}
                    aria-label={`Remove product ${index + 1}`}
                  >
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-[132px_1fr]">
                <ImageUploadField
                  value={item.imageAssetId}
                  onChange={(assetId) => updateItem(item.key, { imageAssetId: assetId })}
                />

                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-name-${item.key}`}>Product name</Label>
                    {/*
                      A datalist rather than a select: the catalogue is a
                      suggestion, not a constraint. Typing a product that does
                      not exist yet still works exactly as before — the line is
                      simply not linked, and procurement can attach it later.
                      Picking a listed name captures its id, which is what lets
                      purchased stock be matched to this line.
                    */}
                    <Input
                      id={`${formId}-name-${item.key}`}
                      list={`${formId}-products`}
                      value={item.productName}
                      onChange={(e) => {
                        const value = e.target.value;
                        const match = products.find((p) => p.name === value);
                        updateItem(item.key, { productName: value, productId: match?.id ?? null });
                      }}
                      placeholder="Hammered copper bottle"
                    />
                    {item.productId && (
                      <p className="text-xs text-positive">In the catalogue — stock can be allocated to this line.</p>
                    )}
                    {index === 0 && (
                      <datalist id={`${formId}-products`}>
                        {products.map((p) => (
                          <option key={p.id} value={p.name} />
                        ))}
                      </datalist>
                    )}
                    {err(`items.${index}.productName`) && (
                      <p className="text-xs text-critical">{err(`items.${index}.productName`)}</p>
                    )}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${formId}-qty-${item.key}`}>Quantity</Label>
                      <Input
                        id={`${formId}-qty-${item.key}`}
                        inputMode="numeric"
                        value={item.quantity}
                        onChange={(e) => updateItem(item.key, { quantity: e.target.value })}
                        placeholder="12"
                        className="tabular"
                      />
                      {err(`items.${index}.quantity`) && (
                        <p className="text-xs text-critical">{err(`items.${index}.quantity`)}</p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${formId}-price-${item.key}`}>Price per unit</Label>
                      <Input
                        id={`${formId}-price-${item.key}`}
                        inputMode="decimal"
                        value={item.price}
                        onChange={(e) => updateItem(item.key, { price: e.target.value })}
                        placeholder="1250.50"
                        className="tabular"
                      />
                      {err(`items.${index}.price`) && (
                        <p className="text-xs text-critical">{err(`items.${index}.price`)}</p>
                      )}
                    </div>

                    {/* Derived, never submitted — quantity × price. */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-sm font-medium text-ink-2">Line total</span>
                      <div className="flex h-10 items-center rounded-md border border-line bg-surface px-3 font-mono text-sm text-ink tabular">
                        {lineTotalOf(item) ? formatCurrency(lineTotalOf(item)!) : '—'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}

          <Button type="button" variant="outline" onClick={addItem} disabled={atCap}>
            <Plus className="size-4" />
            Add Product
          </Button>
          {atCap && (
            <p className="text-xs text-warning">
              An order can hold at most {MAX_ITEMS_PER_SALES_ORDER} products.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Money & dates ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment &amp; dispatch</CardTitle>
        </CardHeader>

        <CardContent className="grid gap-5 sm:grid-cols-4">
          {/* Derived, never submitted — the sum of every line. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-2">Order total</span>
            <div className="flex h-10 items-center rounded-md border border-line bg-surface-2 px-3 font-mono text-sm font-medium text-ink tabular">
              {total ? formatCurrency(total) : '—'}
            </div>
            <p className="text-xs text-muted">Calculated automatically</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="paidAmount">Paid amount</Label>
            <Input
              id="paidAmount"
              inputMode="decimal"
              value={paidAmount}
              onChange={(e) => setPaidAmount(e.target.value)}
              placeholder="0.00"
              className="tabular"
            />
            {err('paidAmount') ? (
              <p className="text-xs text-critical">{err('paidAmount')}</p>
            ) : (
              <p className="text-xs text-muted">Partial payments are allowed</p>
            )}
          </div>

          {/* Derived, never submitted — total − paid. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-2">Pending amount</span>
            <div className="flex h-10 items-center rounded-md border border-line bg-surface-2 px-3 font-mono text-sm text-ink tabular">
              {derivedPending ? formatCurrency(derivedPending) : '—'}
            </div>
            <p className="text-xs text-muted">Calculated automatically</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="orderDate">Order date</Label>
            <Input
              id="orderDate"
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
              className="tabular"
            />
            {err('orderDate') && <p className="text-xs text-critical">{err('orderDate')}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dispatchBy">To be dispatched by</Label>
            <Input
              id="dispatchBy"
              type="date"
              value={dispatchBy}
              onChange={(e) => setDispatchBy(e.target.value)}
              className="tabular"
            />
            {err('toBeDispatchedBy') && (
              <p className="text-xs text-critical">{err('toBeDispatchedBy')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={pending} size="lg">
          {pending && <Loader2 className="size-4 animate-spin" />}
          {pending ? 'Creating…' : 'Create order'}
        </Button>
      </div>

      {/* ---------------- Inline customer creation ---------------- */}
      <Dialog open={customerDialogOpen} onOpenChange={setCustomerDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add customer</DialogTitle>
            <DialogDescription>
              This becomes a permanent record in the customer master.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newCustomerName">Customer name *</Label>
              <Input
                id="newCustomerName"
                value={newCustomerName}
                onChange={(e) => setNewCustomerName(e.target.value)}
                placeholder="ABC Wedding Co."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newCustomerType">Customer type</Label>
              <Select
                value={newCustomerType}
                onValueChange={(v) => setNewCustomerType(v as typeof newCustomerType)}
              >
                <SelectTrigger id="newCustomerType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOMER_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {label(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Optional, but worth asking for now: an order that needs chasing
                is far easier to chase with a number attached to it. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newCustomerPhone">Phone *</Label>
                <Input
                  id="newCustomerPhone"
                  inputMode="tel"
                  value={newCustomerPhone}
                  onChange={(e) => setNewCustomerPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="tabular"
                />
                {customerErrors.phone && (
                  <p className="text-xs text-critical">{customerErrors.phone}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newCustomerEmail">Email</Label>
                <Input
                  id="newCustomerEmail"
                  type="email"
                  value={newCustomerEmail}
                  onChange={(e) => setNewCustomerEmail(e.target.value)}
                  placeholder="Optional"
                />
                {customerErrors.email && (
                  <p className="text-xs text-critical">{customerErrors.email}</p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newCustomerAddress">Address</Label>
              <Textarea
                id="newCustomerAddress"
                value={newCustomerAddress}
                onChange={(e) => setNewCustomerAddress(e.target.value)}
                placeholder="Optional"
                rows={2}
              />
              {customerErrors.address && (
                <p className="text-xs text-critical">{customerErrors.address}</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomerDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={createCustomer}
              disabled={creatingCustomer || !customerReady}
            >
              {creatingCustomer && <Loader2 className="size-4 animate-spin" />}
              Add customer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
