'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, MoreHorizontal, Pencil, RotateCcw } from 'lucide-react';
import type { VendorMappingRow } from '@rs/shared';
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
import {
  archiveMappingAction,
  updateMappingAction,
} from '@/app/(app)/vendor-invoices/actions';
import { EditMappingRateDialog } from './mapping-dialogs';

/**
 * Row actions for one vendor↔product mapping.
 *
 * Archiving is soft, and reactivating brings back **the same row** rather than
 * creating a second one — the pair is a single relationship whose price and
 * status change over time, and duplicating it would split that history in two.
 * The backend enforces this with a unique index on the pair; this UI simply
 * never offers an action that would try.
 */
export function MappingActions({
  mapping,
  canEdit,
  canArchive,
}: {
  mapping: VendorMappingRow;
  canEdit: boolean;
  canArchive: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  if (!canEdit && !canArchive) return null;

  function onArchive() {
    setError(null);
    startTransition(async () => {
      const result = await archiveMappingAction(mapping.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  /** Reactivates this same mapping, at the rate it already carries. */
  function onReactivate() {
    setRowError(null);
    startTransition(async () => {
      const result = await updateMappingAction(mapping.id, { isActive: true });
      if (!result.ok) {
        setRowError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            aria-label={`Actions for ${mapping.productTitle}`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          {canEdit && mapping.isActive && (
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil className="size-4" />
              Edit rate
            </DropdownMenuItem>
          )}

          {canEdit && !mapping.isActive && (
            <DropdownMenuItem onSelect={onReactivate}>
              <RotateCcw className="size-4" />
              Reactivate mapping
            </DropdownMenuItem>
          )}

          {canArchive && mapping.isActive && (
            <DropdownMenuItem onSelect={() => setConfirming(true)}>
              <Archive className="size-4" />
              Archive mapping
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {rowError && <p className="mt-1 text-xs text-critical">{rowError}</p>}

      {canEdit && (
        <EditMappingRateDialog open={editing} onOpenChange={setEditing} mapping={mapping} />
      )}

      <AlertDialog open={confirming} onOpenChange={(next) => !pending && setConfirming(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this mapping?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted">
                <p>
                  <strong>{mapping.productTitle}</strong> stops being listed as something{' '}
                  {mapping.vendorName} currently supplies. Nothing is deleted.
                </p>
                <p>
                  Every purchase already recorded keeps the rate it was billed at, and the trade
                  history above is unchanged.
                </p>
                <p>
                  The mapping can be reactivated later and comes back as the same row, keeping its
                  history rather than starting a second one.
                </p>
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
              {pending ? 'Archiving…' : 'Archive mapping'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
