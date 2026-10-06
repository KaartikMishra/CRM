import Link from 'next/link';
import type { PostSalesCaseRow } from '@rs/shared';
import {
  POST_SALES_CASE_TYPE_LABELS,
  POST_SALES_ISSUE_CATEGORY_LABELS,
} from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ContentScrollArea, contentCard } from '@/components/common/content-page';
import { EmptyState } from '@/components/common/empty-state';
import { formatDateTime } from '@/lib/format';
import { CasePriorityBadge, CaseStatusBadge } from './post-sales-badges';

/**
 * The case board.
 *
 * Eleven columns, which is wider than a laptop viewport — the `Table` component
 * brings its own `.scroll-x` container, so they scroll sideways without anything
 * added here, exactly as the Sales and Lead boards do.
 *
 * Every figure comes from the API. `lastActivityAt` in particular is derived
 * server-side from the activity rows the same batched query already read; nothing
 * here recomputes it, and the board deliberately cannot sort by it.
 *
 * Phase 1 shows no SLA countdown, no return/refund/replacement status and no CSAT.
 * None of that data exists yet, and a plausible-looking placeholder would be worse
 * than an absent column.
 */
export function CaseTable({
  cases,
  filtered,
}: {
  cases: PostSalesCaseRow[];
  /** Whether any filter or search is active, so "none" can say which kind. */
  filtered: boolean;
}) {
  if (cases.length === 0) {
    return (
      <div className={contentCard}>
        <EmptyState
          title={filtered ? 'No cases match those filters' : 'No post-sales cases yet'}
          description={
            filtered
              ? 'Try a different status, priority or search term.'
              : 'Raise a case when a customer reports a problem after a sale.'
          }
        />
      </div>
    );
  }

  return (
    <div className={contentCard}>
      <ContentScrollArea>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="min-w-[140px]">Case ID</TableHead>
              <TableHead className="min-w-[90px]">Date</TableHead>
              <TableHead className="min-w-[160px]">Customer</TableHead>
              <TableHead className="min-w-[110px]">Order</TableHead>
              <TableHead className="min-w-[160px]">Product</TableHead>
              <TableHead className="min-w-[130px]">Case Type</TableHead>
              <TableHead className="min-w-[150px]">Issue</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="min-w-[130px]">Assigned To</TableHead>
              <TableHead className="min-w-[120px]">Last Activity</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {cases.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  {/*
                    The case number is the link, which is how every other board in
                    the CRM opens a record — not a separate "view" column.
                  */}
                  <Link
                    href={`/post-sales/cases/${row.id}`}
                    className="block font-medium tabular text-ink hover:text-accent hover:underline"
                  >
                    {row.caseNumber}
                  </Link>
                </TableCell>

                <TableCell className="tabular text-xs text-muted">
                  {formatDateTime(row.createdAt)}
                </TableCell>

                <TableCell>
                  <span className="block text-sm text-ink">{row.customer.name}</span>
                  {row.customer.phone && (
                    <span className="block text-xs tabular text-muted">{row.customer.phone}</span>
                  )}
                </TableCell>

                <TableCell className="tabular text-xs">
                  {/* Null means the case needs no order — a care question, say. */}
                  {row.orderId ?? <span className="text-muted">—</span>}
                </TableCell>

                <TableCell className="text-sm">
                  {row.product ? (
                    <>
                      <span className="block truncate text-ink">{row.product.name}</span>
                      {row.product.more > 0 && (
                        <span className="text-xs text-muted">+{row.product.more} more</span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </TableCell>

                <TableCell className="text-sm text-ink-2">
                  {POST_SALES_CASE_TYPE_LABELS[row.caseType]}
                </TableCell>

                <TableCell className="text-xs text-muted">
                  {POST_SALES_ISSUE_CATEGORY_LABELS[row.issueCategory]}
                </TableCell>

                <TableCell>
                  <CasePriorityBadge priority={row.priority} />
                </TableCell>

                <TableCell>
                  <CaseStatusBadge status={row.status} />
                </TableCell>

                <TableCell className="text-sm">
                  {row.assignedTo ? (
                    row.assignedTo.name
                  ) : (
                    <span className="text-muted">Unassigned</span>
                  )}
                </TableCell>

                <TableCell className="tabular text-xs text-muted">
                  {formatDateTime(row.lastActivityAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ContentScrollArea>
    </div>
  );
}
