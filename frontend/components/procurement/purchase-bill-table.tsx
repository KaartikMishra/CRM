'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import type { PurchaseBillSummary } from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatDate } from '@/lib/format';
import {
  BillApprovalBadge,
  BillStatusBadge,
  BillTypeBadge,
  StandingQty,
} from './procurement-badges';

/**
 * The bill list.
 *
 * A whole row is clickable for speed, but each row also carries a real link so
 * keyboard users and middle-click both behave the way they should — the same
 * arrangement the enquiry and sales tables use.
 */
export function PurchaseBillTable({ bills }: { bills: PurchaseBillSummary[] }) {
  const router = useRouter();

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Bill</TableHead>
          <TableHead>Vendor</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Lines</TableHead>
          <TableHead className="text-right">Standing</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead>Date</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {bills.map((bill) => (
          <TableRow
            key={bill.id}
            onClick={() => router.push(`/procurement/${bill.id}`)}
            className="cursor-pointer"
          >
            <TableCell>
              <Link
                href={`/procurement/${bill.id}`}
                className="font-mono text-sm font-medium text-ink hover:text-accent"
                onClick={(e) => e.stopPropagation()}
              >
                {bill.billNumber}
              </Link>
              {bill.isDelayed && (
                <span className="mt-1 flex items-center gap-1 text-[11px] text-critical">
                  <AlertTriangle className="size-3" />
                  Delayed
                </span>
              )}
            </TableCell>
            <TableCell className="text-ink-2">{bill.vendor.name}</TableCell>
            <TableCell><BillTypeBadge type={bill.billType} /></TableCell>
            <TableCell>
              {/*
                Both badges, because they report different things: arrival and
                sign-off. Approved renders nothing, so this column stays quiet
                once a bill is settled and only speaks when something is
                outstanding.
              */}
              <span className="flex flex-wrap items-center gap-1.5">
                <BillStatusBadge status={bill.status} />
                <BillApprovalBadge status={bill.approvalStatus} />
              </span>
            </TableCell>
            <TableCell className="text-right tabular text-ink-2">{bill.itemCount}</TableCell>
            <TableCell className="text-right"><StandingQty qty={bill.totalStandingQty} /></TableCell>
            <TableCell className="text-right tabular text-ink">
              {formatCurrency(bill.billTotal)}
            </TableCell>
            <TableCell className="text-muted">{formatDate(bill.billDate)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
