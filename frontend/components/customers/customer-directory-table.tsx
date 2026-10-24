/**
 * The All Customers table.
 *
 * A Server Component: it renders data and nothing more, so it ships no
 * JavaScript. Sorting and paging are links that change search parameters, which
 * also makes any view of the directory shareable as a URL.
 *
 * ### Every column here exists on the API row
 *
 * `CustomerDirectoryRow` is the contract, and nothing below derives a figure of
 * its own. Purchase value and order count are already computed server-side
 * through Sales' own `toMoney`; recomputing anything in the browser would be a
 * second definition of what a customer is worth.
 *
 * ### Absent is rendered as absent
 *
 * A customer who has never ordered shows an em dash for last purchase and for
 * average order value, never a zero or an epoch date. `verifiedPurchaseValue`
 * is genuinely '0.00' for such a customer — a real sum of no orders — so that
 * one does print as ₹0.00, which is the honest reading.
 */

import Link from 'next/link';
import { ArrowDown, ArrowUp, Users } from 'lucide-react';
import type { CustomerDirectoryPage, CustomerDirectoryRow } from '@rs/shared';
import { categoriseSource } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/common/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const NONE = '—';

/** The sorts the API accepts. Mirrors CUSTOMER_DIRECTORY_SORTS. */
const SORTABLE = {
  name: 'Customer',
  lastPurchaseAt: 'Last purchase',
  purchaseValue: 'Purchase value',
  orderCount: 'Orders',
} as const;
type SortKey = keyof typeof SORTABLE;

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

const text = (value: string | null): string => (value?.trim() ? value : NONE);

/**
 * A sortable column header.
 *
 * Clicking the active column flips the direction; clicking another switches to
 * it ascending. The link carries every current filter forward, so sorting never
 * silently drops the search somebody typed.
 */
function SortLink({
  column,
  current,
  direction,
  params,
}: {
  column: SortKey;
  current: string;
  direction: string;
  params: Record<string, string>;
}) {
  const isActive = current === column;
  const next = isActive && direction === 'asc' ? 'desc' : 'asc';
  const query = new URLSearchParams({ ...params, sort: column, direction: next });
  // A new sort starts at the first page: a cursor from the previous ordering
  // would point into a sequence that no longer exists.
  query.delete('cursor');
  query.delete('page');

  return (
    <Link
      href={`/customers?${query.toString()}`}
      className="inline-flex items-center gap-1 hover:text-ink"
      aria-label={`Sort by ${SORTABLE[column]}, ${next}ending`}
    >
      {SORTABLE[column]}
      {isActive &&
        (direction === 'asc' ? (
          <ArrowUp className="size-3" aria-hidden />
        ) : (
          <ArrowDown className="size-3" aria-hidden />
        ))}
    </Link>
  );
}

/** The source cell: the reporting label, with the stored value beneath it. */
function SourceCell({ row }: { row: CustomerDirectoryRow }) {
  const categorised = categoriseSource(row.lastTouch.source, row.lastTouch.sourceOther);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm text-ink">{categorised.label}</span>
      {/*
        The original stored value stays visible beside the grouped label. The
        label may be free text or a reporting category, and anyone checking an
        attribution needs to see what is actually in the column.
      */}
      <span className="text-[11px] text-muted">{categorised.original}</span>
    </div>
  );
}

export function CustomerDirectoryTable({
  rows,
  sort,
  direction,
  params,
  hasFilters,
}: {
  rows: CustomerDirectoryRow[];
  sort: string;
  direction: string;
  params: Record<string, string>;
  /** Whether any filter or search is active, which changes the empty copy. */
  hasFilters: boolean;
}) {
  if (rows.length === 0) {
    /*
      "No customers yet" and "nothing matches this search" are different facts
      and get different copy. Telling somebody the directory is empty when they
      have simply filtered it down to nothing would send them looking for a bug.
    */
    return (
      <Card>
        <EmptyState
          icon={Users}
          title={hasFilters ? 'No customers match these filters' : 'No customers yet'}
          description={
            hasFilters
              ? 'Try a broader search, or clear the filters to see the whole directory.'
              : 'Customers are created from Product Enquiry, Create Lead and Sales. None exist yet.'
          }
        />
      </Card>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <SortLink column="name" current={sort} direction={direction} params={params} />
            </TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Last touch</TableHead>
            <TableHead className="text-right">
              <SortLink
                column="orderCount"
                current={sort}
                direction={direction}
                params={params}
              />
            </TableHead>
            <TableHead className="text-right">
              <SortLink
                column="purchaseValue"
                current={sort}
                direction={direction}
                params={params}
              />
            </TableHead>
            <TableHead>
              <SortLink
                column="lastPurchaseAt"
                current={sort}
                direction={direction}
                params={params}
              />
            </TableHead>
            <TableHead>Last enquiry</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <Link
                    href={`/customers/${row.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {row.name}
                  </Link>
                  <span className="text-[11px] text-muted">
                    {text(row.companyName)} · {row.type}
                  </span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {row.isRepeatCustomer && <Badge variant="positive">Repeat</Badge>}
                    {/*
                      A flag, not a verdict: a pair is waiting for somebody to
                      look at it. Nothing has been merged and no record changed.
                    */}
                    {row.hasDuplicateCandidate && (
                      <Badge variant="warning">Possible duplicate</Badge>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="text-ink">{text(row.phone)}</span>
                  <span className="text-[11px] text-muted">{text(row.email)}</span>
                </div>
              </TableCell>
              <TableCell className="text-sm">
                {text(row.state)}
                {row.country && row.state ? (
                  <span className="block text-[11px] text-muted">{row.country}</span>
                ) : null}
              </TableCell>
              <TableCell>
                <SourceCell row={row} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.validOrderCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(row.verifiedPurchaseValue)}
                {row.averageOrderValue !== null && (
                  <span className="block text-[11px] text-muted">
                    avg {money(row.averageOrderValue)}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-sm">{date(row.lastPurchaseAt)}</TableCell>
              <TableCell className="text-sm">{date(row.lastEnquiryAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Pagination controls that match whichever mode the server used.
 *
 * Keyset gives a cursor and no total — there is no honest page count to show,
 * so it offers "Next" alone. An aggregate sort pages by offset and does know
 * the total, so it shows real page numbers. Rendering page numbers for a keyset
 * response would be inventing information the server did not send.
 */
export function CustomerDirectoryPagination({
  pagination,
  params,
}: {
  pagination: CustomerDirectoryPage['pagination'];
  params: Record<string, string>;
}) {
  const linkTo = (overrides: Record<string, string>): string => {
    const query = new URLSearchParams({ ...params, ...overrides });
    return `/customers?${query.toString()}`;
  };

  if (pagination.mode === 'keyset') {
    if (!pagination.nextCursor) return null;
    return (
      <div className="flex justify-end">
        <Link
          href={linkTo({ cursor: pagination.nextCursor })}
          className="text-sm text-accent hover:underline"
        >
          Next page →
        </Link>
      </div>
    );
  }

  const { page, totalPages, total } = pagination;
  if (totalPages <= 1) {
    return (
      <p className="text-xs text-muted">
        {total} customer{total === 1 ? '' : 's'}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted">
        Page {page} of {totalPages} · {total} customer{total === 1 ? '' : 's'}
      </p>
      <div className="flex gap-3 text-sm">
        {page > 1 && (
          <Link href={linkTo({ page: String(page - 1) })} className="text-accent hover:underline">
            ← Previous
          </Link>
        )}
        {page < totalPages && (
          <Link href={linkTo({ page: String(page + 1) })} className="text-accent hover:underline">
            Next →
          </Link>
        )}
      </div>
    </div>
  );
}
