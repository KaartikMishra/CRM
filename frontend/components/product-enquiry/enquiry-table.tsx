'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ImageIcon } from 'lucide-react';
import type { EnquirySummary } from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EfficiencyBadge, StatusBadge } from '@/components/common/status-badge';
import { formatDate, formatTime, label } from '@/lib/format';
import { SlaTimer } from './sla-timer';

/**
 * View V1 — the working list.
 *
 * A whole row is clickable for speed, but each row also carries a real link so
 * keyboard users and middle-click both behave the way they should.
 */
export function EnquiryTable({
  enquiries,
  serverTime,
}: {
  enquiries: EnquirySummary[];
  serverTime: string;
}) {
  const router = useRouter();

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-14">Item</TableHead>
          <TableHead>Enquiry</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Towards</TableHead>
          <TableHead>Deadline</TableHead>
          <TableHead>Efficiency</TableHead>
          <TableHead className="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {enquiries.map((enquiry) => (
          <TableRow
            key={enquiry.id}
            onClick={() => router.push(`/product-enquiry/${enquiry.id}`)}
            className="cursor-pointer"
          >
            <TableCell>
              {enquiry.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={enquiry.thumbnail.secureUrl}
                  alt=""
                  className="size-9 rounded-sm border border-line object-cover"
                />
              ) : (
                <span className="grid size-9 place-items-center rounded-sm border border-line bg-surface-2 text-faint">
                  <ImageIcon className="size-4" />
                </span>
              )}
            </TableCell>

            <TableCell>
              <Link
                href={`/product-enquiry/${enquiry.id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-mono text-[13px] font-medium text-ink tabular hover:text-accent"
              >
                {enquiry.enquiryNo}
              </Link>
              <span className="mt-0.5 block text-xs text-muted">
                {enquiry.respondedCount}/{enquiry.productCount} responded
              </span>
            </TableCell>

            <TableCell>
              <span className="block font-medium text-ink">{enquiry.customer.name}</span>
              <span className="mt-0.5 block text-xs text-muted">
                {label(enquiry.customer.type)} · {label(enquiry.source)}
              </span>
            </TableCell>

            <TableCell>
              <StatusBadge status={enquiry.status} />
            </TableCell>

            <TableCell>
              <span className="block text-ink">{enquiry.assignedTo.name}</span>
              <span className="mt-0.5 block text-xs text-muted tabular">
                {enquiry.assignedTo.employeeId}
              </span>
            </TableCell>

            <TableCell>
              <SlaTimer sla={enquiry.sla} serverTime={serverTime} />
            </TableCell>

            <TableCell>
              <EfficiencyBadge efficiency={enquiry.sla.efficiency} breached={enquiry.sla.breached} />
            </TableCell>

            <TableCell className="text-right">
              <span className="block text-sm tabular">{formatDate(enquiry.sla.createdAt)}</span>
              <span className="mt-0.5 block text-xs text-muted tabular">
                {formatTime(enquiry.sla.createdAt)}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
