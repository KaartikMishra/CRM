'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { Loader2, Mail, Phone, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  CUSTOMER_TYPES,
  GST_RATES,
  GST_RATE_LABELS,
  HSN_CODE_MAX_LENGTH,
  COUNTRIES,
  DEFAULT_COUNTRY,
  INDIA_STATES,
  MAX_ITEMS_PER_SALES_ORDER,
  createSalesOrderSchema,
  customerAddressSchema,
  customerCompanySchema,
  customerEmailSchema,
  customerGstSchema,
  customerPhoneSchema,
  customerStateSchema,
  isValidAmount,
  lineTotal,
  subtractAmount,
  computeSalesTotals,
  sumItemTotals,
  GST_MODES,
  GST_MODE_LABELS,
  type CreateSalesOrderInput,
  type GstMode,
  type GstRate,
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
import {
  RsProductPicker,
  type PickedProduct,
} from '@/components/products/rs-product-picker';
import { ErrorMessage } from '@/components/common/error-message';
import { EntityPicker, type PickerOption } from '@/components/product-enquiry/entity-picker';
import { ImageUploadField } from '@/components/product-enquiry/image-upload-field';
import { ChargesEditor, usableCharges } from './charges-editor';
import type { ChargeDraft } from './charges-editor';
import { MoneyBreakdown } from './money-breakdown';
import { cn } from '@/lib/utils';
import { formatCurrency, label } from '@/lib/format';
import { createSalesCustomerAction, createSalesOrderAction } from '@/app/(app)/sales/actions';

const today = (): string => new Date().toISOString().slice(0, 10);

type ItemDraft = {
  key: string;
  productName: string;
  quantity: string;
  price: string;
  imageAssetId: string | null;
  /**
   * The RS Product this line is for, if the picker was used.
   *
   * Its `id` is what the API stores as `rsProductId` — the CRM's one product
   * identity, and what Procurement matches purchased stock against. Free text
   * stays valid when this is null: an order records what a customer asked for,
   * and that is not always something in the catalogue.
   */
  rsProduct: PickedProduct | null;

  /** As typed. Text throughout: a leading zero must survive to the API. */
  hsnCode: string;

  /**
   * The rate chosen for this line, always one of GST_RATES.
   *
   * Starts at 'NONE', which is a real answer rather than a placeholder — and
   * deliberately not '0': "no GST applies" and "exempt, at zero percent" are
   * different statements, and the form never turns one into the other.
   */
  gstRate: GstRate;
  gstMode: GstMode;
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
  productName: '',
  quantity: '',
  price: '',
  imageAssetId: null,
  rsProduct: null,
  hsnCode: '',
  gstRate: 'NONE',
  gstMode: 'EXCLUSIVE',
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
export function CreateSalesOrderForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const formId = useId();
  const nextKey = useRef(1);

  const [orderId, setOrderId] = useState('');
  const [customer, setCustomer] = useState<PickerOption | null>(null);
  const [items, setItems] = useState<ItemDraft[]>(() => [emptyItem('i0')]);

  const [charges, setCharges] = useState<ChargeDraft[]>([]);
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
  /** Empty means "not recorded", and is what makes the Select show its placeholder. */
  const [newCustomerState, setNewCustomerState] = useState('');
  /** Blank means the customer bills under their own name. */
  const [newCustomerCompany, setNewCustomerCompany] = useState('');
  /** Nearly every customer is domestic, so the form starts on India. */
  const [newCustomerCountry, setNewCustomerCountry] = useState<string>(DEFAULT_COUNTRY);
  const [newCustomerGst, setNewCustomerGst] = useState('');
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [customerErrors, setCustomerErrors] = useState<Record<string, string>>({});

  // Validated with the same schemas the API uses, so the dialog refuses exactly
  // what the server would. Phone is required here — an order that needs chasing
  // is far easier to chase with a number on it — while email, address, state and
  // GST number stay optional.
  const nameOk = newCustomerName.trim().length >= 2;
  const phoneOk = customerPhoneSchema.safeParse(newCustomerPhone).success;
  const emailOk =
    newCustomerEmail.trim() === '' || customerEmailSchema.safeParse(newCustomerEmail).success;
  const addressOk =
    newCustomerAddress.trim() === '' ||
    customerAddressSchema.safeParse(newCustomerAddress).success;
  // The dropdown can only offer names the schema accepts, so this holds
  // by construction; it is checked anyway so the rule lives in one place and a
  // future change to the options cannot quietly diverge from the server.
  const stateOk = newCustomerState === '' || customerStateSchema.safeParse(newCustomerState).success;
  const companyOk =
    newCustomerCompany.trim() === '' ||
    customerCompanySchema.safeParse(newCustomerCompany).success;
  const gstOk =
    newCustomerGst.trim() === '' || customerGstSchema.safeParse(newCustomerGst).success;
  const customerReady =
    nameOk && companyOk && phoneOk && emailOk && addressOk && stateOk && gstOk;

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

  /*
    The whole preview, from the same function the API and the create schema
    use. It is not a second statement of the arithmetic — it is the same one,
    so what the form shows is what the server will compute.

    Each line is read on its own terms — its own slab and its own mode — so a
    5% exclusive line and an 18% inclusive line on the same order each come
    out right.

    The split is assumed intra-state here. The browser does not know the
    seller's registered State, and CGST+SGST versus IGST changes only which
    heads the tax is posted to, never the payable. The API reports the real
    split back on the created order.
  */
  const totals = allPriceable
    ? computeSalesTotals({
        split: 'CGST_SGST',
        items: items.map((i) => ({
          quantity: Number(i.quantity),
          price: i.price.trim(),
          gstRate: i.gstRate ?? null,
          gstMode: i.gstMode,
        })),
        charges: usableCharges(charges),
      })
    : null;

  /** What the customer owes. Was the bare line sum before GST entered it. */
  const total = totals ? totals.payable : null;

  /** The goods alone, still shown so a reader can see where the tax started. */
  const goodsTotal = allPriceable
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
        // Fields are listed rather than spread, so the picker's whole object
        // cannot reach the API by accident — only its id travels, as the one
        // product identity the CRM has. Omitted rather than sent as null when
        // nothing was picked: the schema reads an absent key as "not mapped".
        ...(item.rsProduct ? { rsProductId: item.rsProduct.id } : {}),
        quantity: item.quantity.trim() === '' ? Number.NaN : Number(item.quantity),
        price: item.price.trim(),
        ...(item.imageAssetId ? { productImageAssetId: item.imageAssetId } : {}),
        // An untouched HSN box is omitted rather than sent as '': the schema's
        // optional fields mean "absent", and a blank string would record an
        // empty code where nobody entered one.
        ...(item.hsnCode.trim() ? { hsnCode: item.hsnCode.trim() } : {}),
        // Always sent, and always the stable string. 'NONE' travels as 'NONE'
        // — never as 0, and never converted to a number.
        gstRate: item.gstRate,
        // Always sent, and per line: this order may mix the two readings.
        gstMode: item.gstMode,
      })),
      // Order level, and only these: GST now travels on each line.
      charges: usableCharges(charges),
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
    if (!stateOk) errors.state = 'Choose a state';
    if (!gstOk) {
      errors.gstNumber =
        customerGstSchema.safeParse(newCustomerGst).error?.issues[0]?.message ??
        'Enter a valid 15-character GSTIN';
    }
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
        ...(newCustomerCompany.trim() ? { companyName: newCustomerCompany.trim() } : {}),
        ...(newCustomerState ? { state: newCustomerState } : {}),
        ...(newCustomerCountry ? { country: newCustomerCountry } : {}),
        // Sent as typed; the shared schema trims and uppercases it server-side,
        // so the canonical casing is decided in exactly one place.
        ...(newCustomerGst.trim() ? { gstNumber: newCustomerGst.trim() } : {}),
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
      setNewCustomerState('');
      setNewCustomerGst('');
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
                <div className="flex flex-col gap-2">
                  <ImageUploadField
                    value={item.imageAssetId}
                    onChange={(assetId) => updateItem(item.key, { imageAssetId: assetId })}
                  />

                  {/*
                    The catalogue's own photograph, shown beside the upload
                    rather than inside it: the uploaded image is the one that
                    travels with the order, and replacing it with a picture the
                    line does not carry would misrepresent what was saved.
                    Nothing is uploaded or copied here — it is the existing
                    Shopify CDN reference, displayed.
                  */}
                  {item.rsProduct?.imageUrl && (
                    <figure className="flex flex-col gap-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.rsProduct.imageUrl}
                        alt={item.rsProduct.title}
                        loading="lazy"
                        className="aspect-square w-full rounded-md border border-line object-cover"
                      />
                      <figcaption className="text-[11px] text-muted">Catalogue image</figcaption>
                    </figure>
                  )}
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-name-${item.key}`}>Product name</Label>
                    {/*
                      The catalogue is a suggestion, not a constraint. Searching
                      RS Products copies the chosen title onto the line; typing
                      a product that is not in the catalogue still works exactly
                      as before, and the box below stays available for it.

                      The chosen product's id travels with the line as
                      `rsProductId`. That is what lets Procurement match
                      purchased stock to this requirement by identity rather
                      than by spelling — and it is the only product identity the
                      CRM has, so there is nothing to translate it into.
                    */}
                    <RsProductPicker
                      id={`${formId}-name-${item.key}`}
                      value={item.rsProduct}
                      triggerLabel={item.productName}
                      placeholder="Search products by name or SKU"
                      onChange={(product) =>
                        updateItem(item.key, {
                          rsProduct: product,
                          // The title becomes the line's label; the id travels
                          // separately as rsProductId — see above.
                          productName: product?.title ?? '',
                        })
                      }
                    />

                    {/*
                      The free-text fallback, kept because Sales has always
                      allowed an off-catalogue line. Typing here clears any
                      catalogue selection, so the label and the selected product
                      can never disagree.
                    */}
                    <Input
                      aria-label={`Or type a product name for line ${index + 1}`}
                      value={item.productName}
                      onChange={(e) =>
                        updateItem(item.key, { productName: e.target.value, rsProduct: null })
                      }
                      placeholder="…or type a product not in the catalogue"
                    />

                    {item.rsProduct && (
                      <p className="text-xs text-muted">
                        From the catalogue
                        {item.rsProduct.sku ? ` · SKU ${item.rsProduct.sku}` : ''}
                      </p>
                    )}
                    {err(`items.${index}.productName`) && (
                      <p className="text-xs text-critical">{err(`items.${index}.productName`)}</p>
                    )}
                  </div>

                  {/*
                    Tax details, kept on their own row above the figures.

                    Neither takes part in any total: the line total below is
                    quantity × price, exactly as it was before these existed.
                    Selecting a rate records what the line should be taxed at;
                    it does not compute tax anywhere in the CRM.
                  */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${formId}-hsn-${item.key}`}>HSN Code</Label>
                      <Input
                        id={`${formId}-hsn-${item.key}`}
                        value={item.hsnCode}
                        onChange={(e) => updateItem(item.key, { hsnCode: e.target.value })}
                        placeholder="7418"
                        // Text, never numeric: inputMode="numeric" would invite
                        // a number pad and a leading zero would not survive the
                        // round trip. Codes like 7418AB are legitimate.
                        maxLength={HSN_CODE_MAX_LENGTH}
                        autoComplete="off"
                      />
                      {err(`items.${index}.hsnCode`) ? (
                        <p className="text-xs text-critical">{err(`items.${index}.hsnCode`)}</p>
                      ) : (
                        <p className="text-xs text-muted">Optional.</p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${formId}-gst-${item.key}`}>GST</Label>
                      <Select
                        value={item.gstRate}
                        onValueChange={(value) =>
                          updateItem(item.key, { gstRate: value as GstRate })
                        }
                      >
                        <SelectTrigger
                          id={`${formId}-gst-${item.key}`}
                          aria-label={`GST rate for product ${index + 1}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {/*
                            Driven by the shared constant, so the six options
                            here are the six the API accepts. Adding a rate is
                            one edit in @rs/shared, and this list follows.
                          */}
                          {GST_RATES.map((rate) => (
                            <SelectItem key={rate} value={rate}>
                              {GST_RATE_LABELS[rate]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {err(`items.${index}.gstRate`) ? (
                        <p className="text-xs text-critical">{err(`items.${index}.gstRate`)}</p>
                      ) : (
                        <p className="text-xs text-muted">The slab for this product.</p>
                      )}
                    </div>

                    {/*
                      Per line, and deliberately. One order routinely carries a
                      product quoted plus tax beside one quoted all-in; forcing
                      a single reading on the document made somebody re-type a
                      quotation to say what it already said.
                    */}
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${formId}-gstmode-${item.key}`}>GST mode</Label>
                      <Select
                        value={item.gstMode}
                        onValueChange={(value) =>
                          updateItem(item.key, { gstMode: value as GstMode })
                        }
                        disabled={item.gstRate === 'NONE'}
                      >
                        <SelectTrigger
                          id={`${formId}-gstmode-${item.key}`}
                          aria-label={`GST mode for product ${index + 1}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GST_MODES.map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {GST_MODE_LABELS[mode]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted">
                        {item.gstRate === 'NONE'
                          ? 'No GST on this line.'
                          : item.gstMode === 'INCLUSIVE'
                            ? 'Price already contains the GST.'
                            : 'GST is added to the price.'}
                      </p>
                    </div>
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

      {/* ---------------- GST, charges and the payable ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GST &amp; charges</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label>Additional charges &amp; adjustments</Label>
            <ChargesEditor charges={charges} onChange={setCharges} disabled={pending} />
          </div>

          {/* The preview, from the same function the server will use. */}
          <div className="rounded-md border border-line p-4 sm:max-w-md sm:self-end">
            {totals ? (
              <MoneyBreakdown
                taxSplit={totals.split}
                taxableSubtotal={totals.taxableSubtotal}
                taxTotal={totals.taxTotal}
                cgstTotal={totals.cgstTotal}
                sgstTotal={totals.sgstTotal}
                igstTotal={totals.igstTotal}
                byRate={totals.byRate}
                chargesTotal={totals.chargesTotal}
                discountTotal={totals.discountTotal}
                charges={usableCharges(charges)}
                payable={totals.payable}
              />
            ) : (
              <p className="text-sm text-muted">
                Enter a quantity and price on every line to see the breakup.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------------- Money & dates ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment &amp; dispatch</CardTitle>
        </CardHeader>

        <CardContent className="grid gap-5 sm:grid-cols-4">
          {/* Derived, never submitted — goods + GST + charges − discount. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-2">Total payable</span>
            <div className="flex h-10 items-center rounded-md border border-line bg-surface-2 px-3 font-mono text-sm font-medium text-ink tabular">
              {total ? formatCurrency(total) : '—'}
            </div>
            <p className="text-xs text-muted">
              {goodsTotal ? `Goods ${formatCurrency(goodsTotal)} + GST and charges` : 'Calculated automatically'}
            </p>
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newCustomerCompany">Company Name</Label>
              <Input
                id="newCustomerCompany"
                value={newCustomerCompany}
                onChange={(e) => setNewCustomerCompany(e.target.value)}
                placeholder="Optional — who the invoice is made out to"
              />
              {customerErrors.companyName && (
                <p className="text-xs text-critical">{customerErrors.companyName}</p>
              )}
            </div>

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

            {/* All three optional. The State decides whether a sale is taxed
                CGST + SGST or IGST, and a retail customer has no GSTIN. */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newCustomerState">State</Label>
                <Select value={newCustomerState} onValueChange={setNewCustomerState}>
                  <SelectTrigger id="newCustomerState">
                    <SelectValue placeholder="Select state" />
                  </SelectTrigger>
                  <SelectContent>
                    {INDIA_STATES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {customerErrors.state && (
                  <p className="text-xs text-critical">{customerErrors.state}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newCustomerCountry">Country</Label>
                <Select value={newCustomerCountry} onValueChange={setNewCustomerCountry}>
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
                {customerErrors.country && (
                  <p className="text-xs text-critical">{customerErrors.country}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newCustomerGst">GST Number (optional)</Label>
                <Input
                  id="newCustomerGst"
                  value={newCustomerGst}
                  onChange={(e) => setNewCustomerGst(e.target.value)}
                  placeholder="Optional"
                  autoComplete="off"
                  spellCheck={false}
                  className="tabular"
                />
                {customerErrors.gstNumber && (
                  <p className="text-xs text-critical">{customerErrors.gstNumber}</p>
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
