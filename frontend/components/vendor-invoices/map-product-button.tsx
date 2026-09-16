'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MapProductDialog } from './mapping-dialogs';

/**
 * Opens the product-mapping dialog for one vendor.
 *
 * Disabled for an archived vendor, with the reason said rather than left to be
 * discovered: the backend refuses the mapping outright, and a button that
 * always fails is worse than one that explains itself.
 */
export function MapProductButton({
  vendorId,
  vendorName,
  vendorIsActive,
}: {
  vendorId: string;
  vendorName: string;
  vendorIsActive: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!vendorIsActive) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        title="Restore this vendor before mapping new products."
      >
        <Plus className="size-4" />
        Map Product
      </Button>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Map Product
      </Button>
      <MapProductDialog
        open={open}
        onOpenChange={setOpen}
        vendorId={vendorId}
        vendorName={vendorName}
      />
    </>
  );
}
