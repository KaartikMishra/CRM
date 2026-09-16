'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VendorFormDialog } from './vendor-form-dialog';

/**
 * The page's primary call to action.
 *
 * A small Client Component so the page itself can stay a Server Component: only
 * the dialog's open state needs to live in the browser.
 */
export function AddVendorButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Add Vendor
      </Button>
      <VendorFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
