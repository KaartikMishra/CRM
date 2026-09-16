'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, MoreHorizontal, Pencil, Receipt } from 'lucide-react';
import type { VendorListRow } from '@rs/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { archiveVendorAction } from '@/app/(app)/vendor-invoices/actions';
import { VendorFormDialog } from './vendor-form-dialog';
import { mappedProductsLabel } from './vendor-format';

/**
 * Row actions: view trades, edit, archive.
 *
 * Archive is deliberately not called Delete, because nothing is deleted — the
 * request is a POST to /archive, and there is no DELETE endpoint to call even
 * if somebody wanted one. The confirmation says what is preserved rather than
 * asking "are you sure?": somebody reaching for this needs to know the purchase
 * history stays readable and the product mappings stay with it.
 */
export function VendorActions({
  vendor,
  canEdit,
  canArchive,
  onViewTrades,
}: {
  vendor: VendorListRow;
  canEdit: boolean;
  canArchive: boolean;
  /** Opens the trade drawer for this vendor. */
  onViewTrades: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const alreadyArchived = !vendor.isActive;

  function onArchive() {
    setError(null);
    startTransition(async () => {
      const result = await archiveVendorAction(vendor.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Actions for ${vendor.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onViewTrades}>
            <Receipt className="size-4" />
            View trades
          </DropdownMenuItem>

          {canEdit && (
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil className="size-4" />
              Edit vendor
            </DropdownMenuItem>
          )}

          {canArchive && !alreadyArchived && (
            <DropdownMenuItem onSelect={() => setConfirming(true)}>
              <Archive className="size-4" />
              Archive vendor
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {canEdit && (
        <VendorFormDialog open={editing} onOpenChange={setEditing} vendor={vendor} />
      )}

      <AlertDialog open={confirming} onOpenChange={(next) => !pending && setConfirming(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive “{vendor.name}”?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted">
                <p>
                  The vendor is marked <strong>Archived</strong> and stops appearing as active. They
                  are <strong>not deleted</strong>.
                </p>
                <p>
                  Every purchase bill that names them stays readable, and the whole trade history is
                  preserved exactly as recorded — nothing in Procurement changes.
                </p>
                <p>
                  Their product mappings are kept too ({mappedProductsLabel(
                    vendor.mappedProductCount,
                  ).toLowerCase()}), so restoring the vendor later restores what they supply.
                </p>
                <p>New products cannot be mapped to an archived vendor until they are restored.</p>
                {error && <p className="text-critical">{error}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                onArchive();
              }}
              disabled={pending}
            >
              {pending ? 'Archiving…' : 'Archive vendor'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
