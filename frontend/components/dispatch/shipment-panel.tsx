'use client';

import { useState, useTransition } from 'react';
import { Loader2, PackagePlus, Pencil, Truck } from 'lucide-react';
import { toast } from 'sonner';
import {
  AWB_MAX_LENGTH,
  DISPATCH_CARRIERS,
  DISPATCH_CARRIER_LABELS,
  DISPATCH_CHANNELS,
  DISPATCH_CHANNEL_LABELS,
  type DispatchCarrier,
  type DispatchChannel,
  type DispatchDetail,
  type DispatchView,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { ErrorMessage } from '@/components/common/error-message';
import { formatDateTime } from '@/lib/format';
import {
  cancelDispatchAction,
  completePackingAction,
  createDispatchAction,
  dispatchShipmentAction,
  startPackingAction,
  updateDispatchAction,
} from '@/app/(app)/dispatch/actions';
import { DispatchStatusBadge } from './dispatch-badges';
import {
  canCancel,
  canEditShipment,
  dispatchableQty,
  hasAnythingToPack,
  nextStep,
  validatePack,
  type PackLine,
} from './dispatch-logic';

/**
 * Shipments: opening one, packing it, and sending it.
 *
 * The lifecycle is the backend's — DRAFT → PACKING → PACKED → DISPATCHED, with
 * cancellation available until the goods leave — and this draws one button for
 * whichever step a shipment is actually waiting for rather than offering all of
 * them and letting the API refuse three.
 */
export function ShipmentPanel({
  detail,
  canCreate,
  canEdit,
  onChanged,
}: {
  detail: DispatchDetail;
  canCreate: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [packOpen, setPackOpen] = useState(false);
  const [sending, setSending] = useState<DispatchView | null>(null);
  const [editing, setEditing] = useState<DispatchView | null>(null);
  const [cancelling, setCancelling] = useState<DispatchView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [working, startWorking] = useTransition();

  const somethingToPack = hasAnythingToPack(detail.readiness.lines);

  const advance = (shipment: DispatchView) => {
    const step = nextStep(shipment.status);
    if (step === 'DISPATCH') {
      setSending(shipment);
      return;
    }

    setBusyId(shipment.id);
    startWorking(async () => {
      const result =
        step === 'START_PACKING'
          ? await startPackingAction(shipment.id, detail.salesOrderId)
          : await completePackingAction(shipment.id, detail.salesOrderId);

      setBusyId(null);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(step === 'START_PACKING' ? 'Packing started.' : 'Marked packed.');
      onChanged();
    });
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-ink">Shipments</h2>
            <p className="mt-0.5 text-sm text-muted">
              Parcels opened against this order, and where each one has reached.
            </p>
          </div>

          {canCreate && somethingToPack && (
            <Button onClick={() => setPackOpen(true)}>
              <PackagePlus className="size-4" />
              New shipment
            </Button>
          )}
        </div>

        {detail.dispatches.length === 0 ? (
          <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
            {somethingToPack
              ? 'No shipment opened yet.'
              : 'Nothing is ready to pack on this order yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.dispatches.map((shipment) => (
              <ShipmentRow
                key={shipment.id}
                shipment={shipment}
                canEdit={canEdit}
                busy={busyId === shipment.id && working}
                onAdvance={() => advance(shipment)}
                onEdit={() => setEditing(shipment)}
                onCancel={() => setCancelling(shipment)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <PackDialog
        open={packOpen}
        onOpenChange={setPackOpen}
        detail={detail}
        onDone={onChanged}
      />

      {sending && (
        <SendDialog
          open={sending !== null}
          onOpenChange={(open) => !open && setSending(null)}
          shipment={sending}
          salesOrderId={detail.salesOrderId}
          onDone={onChanged}
        />
      )}

      {editing && (
        <EditDialog
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          shipment={editing}
          salesOrderId={detail.salesOrderId}
          onDone={onChanged}
        />
      )}

      <AlertDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this shipment?</AlertDialogTitle>
            <AlertDialogDescription>
              Its units go back to the order&rsquo;s dispatchable total and can be packed again.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = cancelling;
                if (!target) return;
                startWorking(async () => {
                  const result = await cancelDispatchAction(target.id, detail.salesOrderId);
                  setCancelling(null);
                  if (!result.ok) {
                    toast.error(result.message);
                    return;
                  }
                  toast.success('Shipment cancelled.');
                  onChanged();
                });
              }}
            >
              Cancel shipment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** One shipment's timeline: who did what, when, and how it travels. */
function ShipmentRow({
  shipment,
  canEdit,
  busy,
  onAdvance,
  onEdit,
  onCancel,
}: {
  shipment: DispatchView;
  canEdit: boolean;
  busy: boolean;
  onAdvance: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const step = nextStep(shipment.status);
  const stepLabel =
    step === 'START_PACKING'
      ? 'Start packing'
      : step === 'MARK_PACKED'
        ? 'Mark packed'
        : step === 'DISPATCH'
          ? 'Final dispatch'
          : null;

  return (
    <li className="rounded-md border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <DispatchStatusBadge status={shipment.status} />
        {shipment.isPartial && <span className="text-xs text-warning">Partial shipment</span>}
        <span className="ml-auto text-xs text-muted tabular">
          Opened by {shipment.createdBy.name} · {formatDateTime(shipment.createdAt)}
        </span>
      </div>

      <ul className="mt-2 flex flex-col gap-0.5 text-sm text-ink">
        {shipment.items.map((item) => (
          <li key={item.id} className="flex gap-2">
            <span className="tabular text-muted">{item.quantity}×</span>
            <span>{item.productName}</span>
          </li>
        ))}
      </ul>

      {(shipment.carrier || shipment.awb) && (
        <p className="mt-2 text-sm text-muted">
          {shipment.channel && (
            <>
              {shipment.channel === 'OTHER'
                ? shipment.channelOther
                : DISPATCH_CHANNEL_LABELS[shipment.channel]}
              {' · '}
            </>
          )}
          {shipment.carrier && (
            <>
              {shipment.carrier === 'OTHER'
                ? shipment.carrierOther
                : DISPATCH_CARRIER_LABELS[shipment.carrier]}
            </>
          )}
          {shipment.awb && <span className="tabular"> · AWB {shipment.awb}</span>}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-0.5 text-xs text-muted">
        {shipment.packedBy && shipment.packedAt && (
          <span>
            Packed by {shipment.packedBy.name} · {formatDateTime(shipment.packedAt)}
          </span>
        )}
        {shipment.dispatchedBy && shipment.dispatchedAt && (
          <span>
            Dispatched by {shipment.dispatchedBy.name} · {formatDateTime(shipment.dispatchedAt)}
          </span>
        )}
      </div>

      {canEdit && (stepLabel || canEditShipment(shipment.status) || canCancel(shipment.status)) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {stepLabel && (
            <Button size="sm" onClick={onAdvance} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {stepLabel}
            </Button>
          )}
          {/* Carrier and AWB are often known before the parcel is sealed, so
              they can be recorded while packing rather than only at dispatch.
              The API refuses this on a settled shipment; so does the button. */}
          {canEditShipment(shipment.status) && (
            <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
              <Pencil className="size-4" />
              Carrier &amp; AWB
            </Button>
          )}
          {canCancel(shipment.status) && (
            <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The packing screen: which lines go in this parcel, and how many of each.
 *
 * Quantities are checked here for a friendly message before a round trip, and
 * again by the API under a lock — readiness can change between this screen
 * being drawn and the button being pressed, so the server's answer is the one
 * that counts.
 */
function PackDialog({
  open,
  onOpenChange,
  detail,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: DispatchDetail;
  onDone: () => void;
}) {
  const packable = detail.readiness.lines.filter((line) => dispatchableQty(line) > 0);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const chosen: PackLine[] = packable
    .map((line) => ({
      salesOrderItemId: line.salesOrderItemId,
      quantity: Number(quantities[line.salesOrderItemId] ?? ''),
    }))
    .filter((line) => quantities[line.salesOrderItemId] !== undefined && quantities[line.salesOrderItemId] !== '');

  const problems = validatePack(chosen, detail.readiness.lines);
  const problemFor = (id: string) => problems.find((p) => p.salesOrderItemId === id)?.message;

  const submit = () => {
    setError(null);
    startSaving(async () => {
      const result = await createDispatchAction({
        salesOrderId: detail.salesOrderId,
        items: chosen,
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      toast.success('Shipment opened.');
      setQuantities({});
      onOpenChange(false);
      onDone();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New shipment</DialogTitle>
          <DialogDescription>
            {detail.orderId} · {detail.customer.name}. Choose what goes in this parcel.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {packable.map((line) => {
            const available = dispatchableQty(line);
            const message = problemFor(line.salesOrderItemId);

            return (
              <div
                key={line.salesOrderItemId}
                className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{line.productName}</p>
                  <p className="text-xs text-muted tabular">
                    Required {line.requiredQty} · ready {line.readyQty} · sent{' '}
                    {line.dispatchedQty} · can send {available}
                  </p>
                </div>

                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={available}
                  value={quantities[line.salesOrderItemId] ?? ''}
                  onChange={(e) =>
                    setQuantities((prev) => ({
                      ...prev,
                      [line.salesOrderItemId]: e.target.value,
                    }))
                  }
                  placeholder="0"
                  className="w-24 tabular"
                  aria-label={`Quantity for ${line.productName}`}
                />

                {message && <p className="w-full text-xs text-critical">{message}</p>}
              </div>
            );
          })}
        </div>

        {error && <ErrorMessage message={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || chosen.length === 0 || problems.length > 0}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            Open shipment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How a parcel travels: channel, carrier, and the airway bill.
 *
 * One component for both dialogs that collect them — recording them while
 * packing, and confirming them at dispatch — because they are the same three
 * fields with the same OTHER pairing rules, and two copies would be two places
 * for those rules to drift apart.
 */
type TravelState = {
  channel: DispatchChannel | '';
  channelOther: string;
  carrier: DispatchCarrier | '';
  carrierOther: string;
  awb: string;
};

/** True when the OTHER/free-text pairing is satisfied in both directions. */
function travelComplete(t: TravelState): boolean {
  return (
    t.channel !== '' &&
    t.carrier !== '' &&
    t.awb.trim() !== '' &&
    (t.channel !== 'OTHER' || t.channelOther.trim() !== '') &&
    (t.carrier !== 'OTHER' || t.carrierOther.trim() !== '')
  );
}

function TravelFields({
  value,
  onChange,
}: {
  value: TravelState;
  onChange: (next: TravelState) => void;
}) {
  const set = (patch: Partial<TravelState>) => onChange({ ...value, ...patch });

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="channel">Channel</Label>
        <Select
          value={value.channel}
          onValueChange={(v) => set({ channel: v as DispatchChannel })}
        >
          <SelectTrigger id="channel">
            <SelectValue placeholder="Choose a channel" />
          </SelectTrigger>
          <SelectContent>
            {DISPATCH_CHANNELS.map((option) => (
              <SelectItem key={option} value={option}>
                {DISPATCH_CHANNEL_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {value.channel === 'OTHER' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="channel-other">Name the channel</Label>
          <Input
            id="channel-other"
            value={value.channelOther}
            onChange={(e) => set({ channelOther: e.target.value })}
            maxLength={120}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="carrier">Carrier</Label>
        <Select
          value={value.carrier}
          onValueChange={(v) => set({ carrier: v as DispatchCarrier })}
        >
          <SelectTrigger id="carrier">
            <SelectValue placeholder="Choose a carrier" />
          </SelectTrigger>
          <SelectContent>
            {DISPATCH_CARRIERS.map((option) => (
              <SelectItem key={option} value={option}>
                {DISPATCH_CARRIER_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {value.carrier === 'OTHER' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="carrier-other">Name the carrier</Label>
          <Input
            id="carrier-other"
            value={value.carrierOther}
            onChange={(e) => set({ carrierOther: e.target.value })}
            maxLength={120}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="awb">AWB number</Label>
        {/* Text, not number: AWBs carry leading zeros and vary in format. */}
        <Input
          id="awb"
          value={value.awb}
          onChange={(e) => set({ awb: e.target.value })}
          maxLength={AWB_MAX_LENGTH}
          placeholder="As the courier issued it"
          className="tabular"
        />
      </div>
    </>
  );
}

const travelFrom = (shipment: DispatchView): TravelState => ({
  channel: shipment.channel ?? '',
  channelOther: shipment.channelOther ?? '',
  carrier: shipment.carrier ?? '',
  carrierOther: shipment.carrierOther ?? '',
  awb: shipment.awb ?? '',
});

/**
 * Recording how a parcel travels, before it is sent.
 *
 * The same three fields the dispatch dialog collects, saved through PATCH so a
 * courier chosen on Tuesday does not have to be re-entered on Wednesday. The
 * API refuses this on a shipment that has already left or been cancelled.
 */
function EditDialog({
  open,
  onOpenChange,
  shipment,
  salesOrderId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipment: DispatchView;
  salesOrderId: string;
  onDone: () => void;
}) {
  const [travel, setTravel] = useState<TravelState>(travelFrom(shipment));
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const submit = () => {
    setError(null);
    startSaving(async () => {
      const result = await updateDispatchAction(shipment.id, salesOrderId, {
        ...(travel.channel !== '' ? { channel: travel.channel } : {}),
        ...(travel.channel === 'OTHER' ? { channelOther: travel.channelOther.trim() } : {}),
        ...(travel.carrier !== '' ? { carrier: travel.carrier } : {}),
        ...(travel.carrier === 'OTHER' ? { carrierOther: travel.carrierOther.trim() } : {}),
        ...(travel.awb.trim() !== '' ? { awb: travel.awb.trim() } : {}),
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      toast.success('Shipment details saved.');
      onOpenChange(false);
      onDone();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Carrier &amp; AWB</DialogTitle>
          <DialogDescription>
            Record how this parcel will travel. Nothing is sent yet.
          </DialogDescription>
        </DialogHeader>

        <TravelFields value={travel} onChange={setTravel} />

        {error && <ErrorMessage message={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Final dispatch: the point of no return.
 *
 * Channel, carrier and AWB all become required here — a parcel that has left
 * without them is one nobody can answer a customer about. The AWB is text
 * rather than a number so a leading zero survives, which is why the input is
 * not `type="number"`.
 *
 * The customer's name, address and phone are checked by the API, and its
 * refusal is shown verbatim. A missing email is only a warning there and is
 * deliberately not blocked here either.
 */
function SendDialog({
  open,
  onOpenChange,
  shipment,
  salesOrderId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipment: DispatchView;
  salesOrderId: string;
  onDone: () => void;
}) {
  const [travel, setTravel] = useState<TravelState>(travelFrom(shipment));
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{ path: string; message: string }[]>([]);
  const [saving, startSaving] = useTransition();

  // Here the three fields stop being optional: a parcel that has left without
  // them is one nobody can answer a customer about.
  const incomplete = !travelComplete(travel);

  const submit = () => {
    const { channel, carrier } = travel;
    if (channel === '' || carrier === '') return;
    setError(null);
    setDetails([]);

    startSaving(async () => {
      const result = await dispatchShipmentAction(shipment.id, salesOrderId, {
        channel,
        ...(channel === 'OTHER' ? { channelOther: travel.channelOther.trim() } : {}),
        carrier,
        ...(carrier === 'OTHER' ? { carrierOther: travel.carrierOther.trim() } : {}),
        awb: travel.awb.trim(),
      });

      if (!result.ok) {
        setError(result.message);
        setDetails(result.details ?? []);
        return;
      }

      toast.success('Dispatched.');
      onOpenChange(false);
      onDone();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Final dispatch</DialogTitle>
          <DialogDescription>
            Record how this parcel travels. Once sent, it cannot be recalled.
          </DialogDescription>
        </DialogHeader>

        <TravelFields value={travel} onChange={setTravel} />

        {error && <ErrorMessage message={error} />}
        {details.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-critical">
            {details.map((detail) => (
              <li key={`${detail.path}-${detail.message}`}>{detail.message}</li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || incomplete}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />}
            Dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
