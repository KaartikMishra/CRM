/**
 * The customer profile's five sections.
 *
 * Server Components throughout — they ship no JavaScript, because every one of
 * them renders data and nothing here needs state. The tabs are links that
 * change a search parameter rather than client-side state, which also means a
 * tab is shareable as a URL.
 *
 * ### Unavailable is rendered as unavailable
 *
 * A null average order value shows an em dash, never "₹0.00": a customer who
 * has never ordered has no average, and printing zero would put them beside
 * somebody whose orders genuinely came to nothing. The same rule covers a
 * missing phone, a null last-purchase date and an absent source.
 */

import Link from 'next/link';
import type {
  CustomerEnquiryRow,
  CustomerLeadRow,
  CustomerOrderRow,
  CustomerProfile,
  CustomerTimelineEntry,
} from '@rs/shared';
import { categoriseSource, sourceLabel } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** What an absent value looks like. One spelling, used everywhere. */
const NONE = '—';

const text = (value: string | null | undefined): string => (value?.trim() ? value : NONE);

/** Money for display. Already a decimal string from the API; never re-derived. */
function money(amount: string | null): string {
  if (amount === null) return NONE;
  const n = Number(amount);
  if (!Number.isFinite(n)) return NONE;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function date(iso: string | null): string {
  if (!iso) return NONE;
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-sm text-ink">{value}</dd>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-2xl font-medium tabular-nums text-ink">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** The source, with its reporting category and any free text. */
function SourceCell({
  source,
  detail,
  channel,
}: {
  source: string;
  detail: string | null;
  channel: string | null;
}) {
  const categorised = categoriseSource(source, detail);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm text-ink">{categorised.label}</span>
      {/*
        The original stored value is shown alongside the label, because the
        label may be free text or a grouped category and somebody debugging an
        attribution needs to see what is actually in the column.
      */}
      <span className="text-[11px] text-muted">
        {categorised.original}
        {channel ? ` · ${channel}` : ''}
      </span>
    </div>
  );
}

export function OverviewSection({ customer }: { customer: CustomerProfile }) {
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-ink">Identity &amp; contact</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name" value={customer.name} />
          <Field label="Company" value={text(customer.companyName)} />
          <Field label="Type" value={customer.type} />
          <Field label="GSTIN" value={text(customer.gstNumber)} />
          <Field label="Phone" value={text(customer.phone)} />
          <Field label="Email" value={text(customer.email)} />
          <Field label="State" value={text(customer.state)} />
          <Field label="Country" value={text(customer.country)} />
          <Field label="Address" value={text(customer.address)} />
          <Field label="On record since" value={date(customer.createdAt)} />
        </dl>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-ink">Acquisition</h2>
        <p className="mt-1 text-xs text-muted">
          Derived from this customer&apos;s leads and enquiries. These are attribution labels
          somebody recorded, not connected channels.
        </p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              First touch
            </dt>
            <dd className="mt-1">
              <SourceCell
                source={customer.firstTouch.source}
                detail={customer.firstTouch.sourceOther}
                channel={customer.firstTouch.channel}
              />
              <p className="mt-0.5 text-[11px] text-muted">{date(customer.firstTouch.at)}</p>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Last touch</dt>
            <dd className="mt-1">
              <SourceCell
                source={customer.lastTouch.source}
                detail={customer.lastTouch.sourceOther}
                channel={customer.lastTouch.channel}
              />
              <p className="mt-0.5 text-[11px] text-muted">{date(customer.lastTouch.at)}</p>
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-ink">Purchases</h2>
        <p className="mt-1 text-xs text-muted">
          Cancelled orders are excluded; unpaid but valid orders are included. Completed refunds
          are subtracted and pending ones shown separately. {customer.purchase.currency}.
        </p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Valid orders" value={String(customer.purchase.validOrderCount)} />
          <Stat
            label="Verified value"
            value={money(customer.purchase.verifiedPurchaseValue)}
            hint="After completed refunds"
          />
          <Stat
            label="Average order"
            value={money(customer.purchase.averageOrderValue)}
            hint={customer.purchase.validOrderCount === 0 ? 'No valid orders yet' : undefined}
          />
          <Stat label="Last purchase" value={date(customer.purchase.lastPurchaseAt)} />
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Badge variant={customer.purchase.isRepeatCustomer ? 'positive' : 'neutral'}>
            {customer.purchase.isRepeatCustomer ? 'Repeat customer' : 'Not a repeat customer'}
          </Badge>
          {customer.purchase.cancelledOrderCount > 0 && (
            <Badge variant="neutral">
              {customer.purchase.cancelledOrderCount} cancelled
            </Badge>
          )}
          {customer.purchase.pendingRefundValue !== '0.00' && (
            <Badge variant="warning">
              {money(customer.purchase.pendingRefundValue)} refund pending
            </Badge>
          )}
          {customer.hasDuplicateCandidate && (
            <Badge variant="warning">Possible duplicate — awaiting review</Badge>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-ink">Enquiries &amp; conversion</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Enquiries" value={String(customer.enquiryCount)} />
          <Stat label="Last enquiry" value={date(customer.lastEnquiryAt)} />
          <Stat label="Leads" value={String(customer.conversion.leadCount)} />
          <Stat
            label="Converted"
            value={String(customer.conversion.convertedLeadCount)}
            /*
              WON is reported separately and never merged: a lead can be marked
              WON before its order exists, and an order can be cancelled after
              its lead was marked WON. The discrepancy is the useful part.
            */
            hint={`${customer.conversion.wonLeadCount} marked WON`}
          />
        </dl>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-ink">Who holds these records</h2>
        <p className="mt-1 text-xs text-muted">
          Assignment lives on each enquiry and lead. This customer has no single owner — the CRM
          records none.
        </p>
        {customer.assignees.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No records are assigned.</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {customer.assignees.map((person) => (
              <li key={person.userId}>
                <Badge variant="neutral">
                  {person.name} ({person.employeeId}) · {person.recordCount}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function EmptySection({ what }: { what: string }) {
  /*
    "None recorded" rather than "none" — the distinction matters. The CRM holds
    no history for this customer; it does not follow that none ever existed, and
    the copy should not claim otherwise.
  */
  return <p className="py-6 text-sm text-muted">No {what} recorded for this customer.</p>;
}

export function EnquiriesSection({ rows }: { rows: CustomerEnquiryRow[] }) {
  if (rows.length === 0) return <EmptySection what="enquiries" />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Enquiry</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Products</TableHead>
            <TableHead>Assigned to</TableHead>
            <TableHead>Raised</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.enquiryId}>
              <TableCell>
                <Link href={`/product-enquiry/${row.enquiryId}`} className="text-accent hover:underline">
                  {row.enquiryNo}
                </Link>
              </TableCell>
              <TableCell>
                <SourceCell source={row.source} detail={row.sourceDetail} channel={null} />
              </TableCell>
              <TableCell>{row.status}</TableCell>
              <TableCell className="tabular-nums">{row.productCount}</TableCell>
              <TableCell>{row.assignedTo ? row.assignedTo.name : NONE}</TableCell>
              <TableCell>{date(row.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function LeadsSection({ rows }: { rows: CustomerLeadRow[] }) {
  if (rows.length === 0) return <EmptySection what="leads" />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>Requirement</TableHead>
            <TableHead>Deal status</TableHead>
            <TableHead>Converted</TableHead>
            <TableHead>Associate</TableHead>
            <TableHead>Enquiry date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.leadId}>
              <TableCell>
                <Link href={`/leads/${row.leadId}`} className="text-accent hover:underline">
                  <SourceCell
                    source={row.leadSource}
                    detail={row.leadSourceOther}
                    channel={row.channelOther ?? row.channel}
                  />
                </Link>
              </TableCell>
              <TableCell>{row.requirementType}</TableCell>
              <TableCell>{row.dealStatus}</TableCell>
              <TableCell>
                {/* A link to a cancelled order is not a conversion. */}
                <Badge variant={row.isConverted ? 'positive' : 'neutral'}>
                  {row.isConverted ? 'Yes' : 'No'}
                </Badge>
              </TableCell>
              <TableCell>{row.associate ? row.associate.name : NONE}</TableCell>
              <TableCell>{date(row.sourceAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function OrdersSection({ rows }: { rows: CustomerOrderRow[] }) {
  if (rows.length === 0) return <EmptySection what="sales orders" />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Items</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">Refunded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <Link href={`/sales/${row.id}`} className="text-accent hover:underline">
                  {row.orderId}
                </Link>
              </TableCell>
              <TableCell>{date(row.orderDate)}</TableCell>
              <TableCell>
                <Badge variant={row.status === 'CANCELLED' ? 'neutral' : 'positive'}>
                  {row.status}
                </Badge>
              </TableCell>
              <TableCell className="tabular-nums">{row.itemCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(row.activeTotal)}
                {/*
                  A cancelled order is worth 0.00 now but was agreed at a
                  figure. Both are shown, because only the first would make the
                  order look as though it never existed.
                */}
                {row.activeTotal !== row.total && (
                  <span className="block text-[11px] text-muted">
                    ordered {money(row.total)}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{money(row.paid)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(row.refunded)}
                {row.refundPending !== '0.00' && (
                  <span className="block text-[11px] text-muted">
                    {money(row.refundPending)} pending
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function TimelineSection({
  entries,
  truncated,
}: {
  entries: CustomerTimelineEntry[];
  truncated: string[];
}) {
  if (entries.length === 0) return <EmptySection what="activity" />;
  return (
    <div className="flex flex-col gap-3">
      {truncated.length > 0 && (
        /*
          Said out loud. A view that quietly dropped the oldest entries would be
          telling the reader those events never happened.
        */
        <p className="rounded-md border border-line bg-surface-2 p-3 text-xs text-muted">
          This view shows the most recent activity only. Older entries exist for:{' '}
          {truncated.join(', ')}.
        </p>
      )}
      <ol className="flex flex-col gap-3">
        {entries.map((entry) => (
          <li key={entry.id} className="flex gap-3 border-l-2 border-line pl-3">
            <div className="flex-1">
              <p className="text-sm text-ink">
                {entry.href ? (
                  <Link href={entry.href} className="text-accent hover:underline">
                    {entry.summary}
                  </Link>
                ) : (
                  entry.summary
                )}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {dateTime(entry.at)}
                {/* Null actor is a real state: some events have no recorded person. */}
                {entry.actor ? ` · ${entry.actor.name}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The label a timeline kind reads as. Exported so a test can assert coverage. */
export { sourceLabel };
