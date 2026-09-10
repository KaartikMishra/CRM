'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  CUSTOMER_TYPES,
  DIMENSION_UNITS,
  ENQUIRY_SOURCES,
  MAX_PRODUCTS_PER_ENQUIRY,
  WEIGHT_UNITS,
  createEnquirySchema,
  customerAddressSchema,
  customerEmailSchema,
  customerPhoneSchema,
  type CreateEnquiryInput,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { label } from '@/lib/format';
import { createCustomerAction, createEnquiryAction } from '@/app/(app)/product-enquiry/actions';
import { EntityPicker, type PickerOption } from './entity-picker';
import { ImageUploadField } from './image-upload-field';

type Assignee = { id: string; name: string; employeeId: string };

type ProductDraft = {
  key: string;
  name: string;
  quantity: string;
  weightValue: string;
  weightUnit: (typeof WEIGHT_UNITS)[number];
  length: string;
  width: string;
  height: string;
  dimensionUnit: (typeof DIMENSION_UNITS)[number];
  similarOptionNeeded: boolean;
  /** MediaAsset id returned by the upload endpoint, once an image is attached. */
  imageAssetId: string | null;
};

/**
 * Row keys must be identical on the server and on the client.
 *
 * `emptyProduct()` runs inside the initial useState, which executes in both
 * places. `crypto.randomUUID()` gave two different values and React reported a
 * hydration mismatch on every input id derived from them. A module-level
 * counter is no better: the server process keeps counting across requests, so
 * it might render `p4` while a freshly loaded client module starts at `p1`.
 *
 * The key is therefore passed in by the caller, derived from the row's position
 * in the list — the one thing both renders agree on. Rows added later get keys
 * from a counter seeded off the current length, which only ever runs on the
 * client, after hydration.
 */
const emptyProduct = (key: string): ProductDraft => ({
  key,
  name: '',
  quantity: '',
  weightValue: '',
  weightUnit: 'KG',
  length: '',
  width: '',
  height: '',
  dimensionUnit: 'CM',
  similarOptionNeeded: false,
  imageAssetId: null,
});

const num = (v: string): number | undefined => {
  if (v.trim() === '') return undefined;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The create form.
 *
 * Validation runs against the same Zod schema the backend uses (§22/§51), so a
 * field error here is the error the API would have returned — and the API still
 * validates independently. The twenty-product cap is enforced in the UI for
 * comfort; the database enforces it for real.
 */
export function CreateEnquiryForm({
  assignees,
  currentUserId,
}: {
  assignees: Assignee[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Stable across server and client render, and unique per form instance.
  const formId = useId();
  // Seeded past the initial row; advanced only by user interaction.
  const nextKey = useRef(1);

  const [customer, setCustomer] = useState<PickerOption | null>(null);
  const [source, setSource] = useState<(typeof ENQUIRY_SOURCES)[number] | ''>('');
  const [sourceDetail, setSourceDetail] = useState('');
  const [assignedToId, setAssignedToId] = useState(currentUserId);
  const [products, setProducts] = useState<ProductDraft[]>(() => [emptyProduct('p0')]);

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
  // what the server would. A phone number is required here — an enquiry worth
  // following up is worth being able to call back — while email and address
  // stay optional and are simply omitted when blank.
  const nameOk = newCustomerName.trim().length >= 2;
  const phoneOk = customerPhoneSchema.safeParse(newCustomerPhone).success;
  const emailOk =
    newCustomerEmail.trim() === '' || customerEmailSchema.safeParse(newCustomerEmail).success;
  const addressOk =
    newCustomerAddress.trim() === '' ||
    customerAddressSchema.safeParse(newCustomerAddress).success;
  const customerReady = nameOk && phoneOk && emailOk && addressOk;

  const atCap = products.length >= MAX_PRODUCTS_PER_ENQUIRY;

  const updateProduct = (key: string, patch: Partial<ProductDraft>) =>
    setProducts((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const addProduct = () => {
    if (atCap) {
      toast.error(`An enquiry can hold at most ${MAX_PRODUCTS_PER_ENQUIRY} products.`);
      return;
    }
    // Only ever runs from a click, so it is client-side and cannot desync.
    setProducts((list) => [...list, emptyProduct(`p${nextKey.current++}`)]);
  };

  const removeProduct = (key: string) =>
    setProducts((list) => (list.length === 1 ? list : list.filter((p) => p.key !== key)));

  function buildInput(): CreateEnquiryInput | null {
    const candidate = {
      customer: customer ? { customerId: customer.id } : {},
      source: source || undefined,
      ...(sourceDetail.trim() ? { sourceDetail: sourceDetail.trim() } : {}),
      assignedToId,
      products: products.map((p) => {
        const weight = num(p.weightValue);
        const length = num(p.length);
        const width = num(p.width);
        const height = num(p.height);
        return {
          name: p.name.trim(),
          quantity: num(p.quantity) ?? Number.NaN,
          similarOptionNeeded: p.similarOptionNeeded,
          ...(p.imageAssetId ? { imageAssetId: p.imageAssetId } : {}),
          ...(weight !== undefined ? { weight: { value: weight, unit: p.weightUnit } } : {}),
          ...(length !== undefined && width !== undefined && height !== undefined
            ? { dimension: { length, width, height, unit: p.dimensionUnit } }
            : {}),
        };
      }),
    };

    const parsed = createEnquirySchema.safeParse(candidate);

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
      const result = await createEnquiryAction(input);

      if (!result.ok) {
        // The backend is authoritative; surface exactly what it said.
        setFormError({ message: result.message, ...(result.code ? { code: result.code } : {}) });
        if (result.details) {
          setFieldErrors(Object.fromEntries(result.details.map((d) => [d.path, d.message])));
        }
        toast.error(result.message);
        return;
      }

      toast.success(`Enquiry ${result.data.enquiry.enquiryNo} created`);
      router.push(`/product-enquiry/${result.data.enquiry.id}`);
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
      const result = await createCustomerAction({
        name: newCustomerName.trim(),
        type: newCustomerType,
        phone: newCustomerPhone.trim(),
        // Omitted entirely when blank: the schema treats these as optional, and
        // an empty string would fail its format check rather than mean "none".
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

      {/* ---------------- Customer & enquiry ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer &amp; enquiry</CardTitle>
          <CardDescription>
            Search the customer master before adding a new record, so history stays on one customer.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-5 sm:grid-cols-2">
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
            {err('customer.customerId') && (
              <p className="text-xs text-critical">{err('customer.customerId')}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="assignedTo">Towards</Label>
            <Select value={assignedToId} onValueChange={setAssignedToId}>
              <SelectTrigger id="assignedTo">
                <SelectValue placeholder="Select an employee" />
              </SelectTrigger>
              <SelectContent>
                {assignees.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} · {a.employeeId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted">Whose fifteen-minute clock this runs on.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="source">Source</Label>
            <Select value={source} onValueChange={(v) => setSource(v as typeof source)}>
              <SelectTrigger id="source">
                <SelectValue placeholder="How did this arrive?" />
              </SelectTrigger>
              <SelectContent>
                {ENQUIRY_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {label(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {err('source') && <p className="text-xs text-critical">{err('source')}</p>}
          </div>

          {/* §21 — only meaningful for OTHERS, and required there. */}
          {source === 'OTHERS' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sourceDetail">Specify the source</Label>
              <Input
                id="sourceDetail"
                value={sourceDetail}
                onChange={(e) => setSourceDetail(e.target.value)}
                placeholder="Trade fair, referral…"
              />
              {err('sourceDetail') && <p className="text-xs text-critical">{err('sourceDetail')}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Products ---------------- */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Products</CardTitle>
            <CardDescription className="mt-1">
              Everything the customer asked about, one line each.
            </CardDescription>
          </div>
          <span className="shrink-0 font-mono text-sm text-muted tabular">
            {products.length} / {MAX_PRODUCTS_PER_ENQUIRY}
          </span>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {err('products') && <ErrorMessage message={err('products')!} />}

          {products.map((product, index) => (
            <div key={product.key} className="rounded-md border border-line bg-surface-2/40 p-4">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-mono text-xs font-medium uppercase tracking-wider text-muted tabular">
                  Product {String(index + 1).padStart(2, '0')}
                </span>
                {products.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeProduct(product.key)}
                    aria-label={`Remove product ${index + 1}`}
                  >
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-[132px_1fr]">
                <ImageUploadField
                  value={product.imageAssetId}
                  onChange={(assetId) => updateProduct(product.key, { imageAssetId: assetId })}
                />

                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-name-${product.key}`}>Product name</Label>
                    <Input
                      id={`${formId}-name-${product.key}`}
                      value={product.name}
                      onChange={(e) => updateProduct(product.key, { name: e.target.value })}
                      placeholder="Hammered copper water bottle"
                    />
                    {err(`products.${index}.name`) && (
                      <p className="text-xs text-critical">{err(`products.${index}.name`)}</p>
                    )}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${formId}-qty-${product.key}`}>Quantity</Label>
                      <Input
                        id={`${formId}-qty-${product.key}`}
                        inputMode="numeric"
                        value={product.quantity}
                        onChange={(e) => updateProduct(product.key, { quantity: e.target.value })}
                        placeholder="100"
                        className="tabular"
                      />
                      {err(`products.${index}.quantity`) && (
                        <p className="text-xs text-critical">{err(`products.${index}.quantity`)}</p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5 sm:col-span-2">
                      <Label htmlFor={`${formId}-weight-${product.key}`}>Weight</Label>
                      <div className="flex gap-2">
                        <Input
                          id={`${formId}-weight-${product.key}`}
                          inputMode="decimal"
                          value={product.weightValue}
                          onChange={(e) =>
                            updateProduct(product.key, { weightValue: e.target.value })
                          }
                          placeholder="Optional"
                          className="tabular"
                        />
                        <Select
                          value={product.weightUnit}
                          onValueChange={(v) =>
                            updateProduct(product.key, {
                              weightUnit: v as ProductDraft['weightUnit'],
                            })
                          }
                        >
                          <SelectTrigger className="w-24" aria-label="Weight unit">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WEIGHT_UNITS.map((u) => (
                              <SelectItem key={u} value={u}>
                                {u.toLowerCase()}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label>Dimensions</Label>
                    <div className="flex flex-wrap items-center gap-2">
                      {(['length', 'width', 'height'] as const).map((axis) => (
                        <Input
                          key={axis}
                          inputMode="decimal"
                          value={product[axis]}
                          onChange={(e) => updateProduct(product.key, { [axis]: e.target.value })}
                          placeholder={axis[0]!.toUpperCase() + axis.slice(1)}
                          aria-label={axis}
                          className="w-24 tabular"
                        />
                      ))}
                      <Select
                        value={product.dimensionUnit}
                        onValueChange={(v) =>
                          updateProduct(product.key, {
                            dimensionUnit: v as ProductDraft['dimensionUnit'],
                          })
                        }
                      >
                        <SelectTrigger className="w-24" aria-label="Dimension unit">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DIMENSION_UNITS.map((u) => (
                            <SelectItem key={u} value={u}>
                              {u.toLowerCase()}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted">Optional — fill all three or leave blank.</p>
                  </div>

                  <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-ink-2">
                    <Checkbox
                      checked={product.similarOptionNeeded}
                      onCheckedChange={(checked) =>
                        updateProduct(product.key, { similarOptionNeeded: checked === true })
                      }
                    />
                    Other similar option needed
                  </label>
                </div>
              </div>
            </div>
          ))}

          <Button type="button" variant="outline" onClick={addProduct} disabled={atCap}>
            <Plus className="size-4" />
            Add product
          </Button>
          {atCap && (
            <p className="text-xs text-warning">
              An enquiry can hold at most {MAX_PRODUCTS_PER_ENQUIRY} products.
            </p>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={pending} size="lg">
          {pending && <Loader2 className="size-4 animate-spin" />}
          {pending ? 'Creating…' : 'Create enquiry'}
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
              <Label htmlFor="newCustomerName">Customer name</Label>
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
            <Button onClick={createCustomer} disabled={creatingCustomer || !customerReady}>
              {creatingCustomer && <Loader2 className="size-4 animate-spin" />}
              Add customer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
