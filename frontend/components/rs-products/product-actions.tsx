'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Archive, MoreHorizontal, Pencil } from 'lucide-react';
import type { RsProductListRow } from '@rs/shared';
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
import { archiveRsProductAction } from '@/app/(app)/rs-products/actions';

/**
 * Row actions: edit, and archive.
 *
 * Archive is deliberately not called Delete, because nothing is deleted. The
 * confirmation says so in full rather than asking "are you sure?" — somebody
 * reaching for this needs to know that the product stays, its variants and
 * images stay, and Shopify is not touched at all.
 */
export function ProductActions({
  product,
  canEdit,
  canArchive,
}: {
  product: RsProductListRow;
  canEdit: boolean;
  canArchive: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canEdit && !canArchive) return null;

  const alreadyArchived = product.status === 'ARCHIVED';

  function onArchive() {
    setError(null);
    startTransition(async () => {
      const result = await archiveRsProductAction(product.id);
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
          <Button variant="ghost" size="sm" aria-label={`Actions for ${product.title}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          {canEdit && (
            <DropdownMenuItem asChild>
              <Link href={`/rs-products/${product.id}/edit`}>
                <Pencil className="size-4" />
                Edit product
              </Link>
            </DropdownMenuItem>
          )}

          {canArchive && !alreadyArchived && (
            <DropdownMenuItem onSelect={() => setConfirming(true)}>
              <Archive className="size-4" />
              Archive product
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive “{product.title}”?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted">
                <p>
                  The product is marked <strong>Archived</strong> and stops appearing as active. It
                  is <strong>not deleted</strong>.
                </p>
                <p>
                  Its variants, images, stock figures and history are all kept, and nothing in
                  Sales, Procurement or Product Enquiry changes.
                </p>
                {product.source === 'SHOPIFY' && (
                  <p>
                    This affects the CRM only — the product is <strong>not</strong> removed or
                    changed in Shopify, and a later sync may set it back to active.
                  </p>
                )}
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
              {pending ? 'Archiving…' : 'Archive product'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
