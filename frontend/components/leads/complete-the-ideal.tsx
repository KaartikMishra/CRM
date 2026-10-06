'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Package, Plus } from 'lucide-react';
import type { LeadRequirementView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MatchedProduct, RequirementCard } from './requirement-card';
import { summaryOf } from './requirement-logic';

/**
 * Complete the Ideal — every requirement on one lead.
 *
 * What the customer actually wants, which a lead can hold several of: a wedding
 * gifting enquiry might be a brass dinner set matched exactly, a copper dispenser
 * matched to something similar, and a custom thali with no catalogue product at
 * all. All three stand together, and adding a fourth disturbs none of them.
 *
 * The rows arrive with the lead — image and matched product already attached by
 * the same query — so this renders a whole section without a request of its own.
 * Mutations go through server actions that revalidate the page, which is what
 * refreshes the list rather than this component holding a second copy of it.
 */
export function CompleteTheIdeal({
  leadId,
  requirements,
  canEdit,
}: {
  leadId: string;
  requirements: LeadRequirementView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  /** Which existing line is open for editing. One at a time, by id. */
  const [editing, setEditing] = useState<string | null>(null);

  /*
    After a write the server action has already revalidated this path; refreshing
    pulls the new list down. The cards hold no local copy of the data, so there
    is nothing here that can disagree with what the API returned.
  */
  const done = (): void => {
    setAdding(false);
    setEditing(null);
    router.refresh();
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold text-ink">Complete the Ideal</h2>
          <p className="text-xs text-muted">
            What the customer wants — captured even when the RoyalStuffs product is not yet known.
          </p>
        </div>

        {canEdit && !adding && (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            Add requirement
          </Button>
        )}
      </div>

      {requirements.length === 0 && !adding && (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line-2 px-4 py-8 text-center">
          <Package className="size-5 text-faint" aria-hidden />
          <p className="text-sm text-muted">No requirements captured yet</p>
          {canEdit ? (
            <p className="text-xs text-faint">
              Add what the customer asked for, with or without a catalogue match.
            </p>
          ) : (
            // Read-only visitors are told why there is no button, rather than
            // shown an empty space that looks broken.
            <p className="text-xs text-faint">You do not have permission to add requirements.</p>
          )}
        </div>
      )}

      {requirements.length > 0 && (
        <ul className="flex flex-col gap-3">
          {requirements.map((requirement) =>
            editing === requirement.id ? (
              <li key={requirement.id}>
                <RequirementCard
                  leadId={leadId}
                  requirement={requirement}
                  canEdit={canEdit}
                  onDone={done}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li
                key={requirement.id}
                className="flex flex-col gap-2 rounded-md border border-line-2 bg-surface p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">
                      <span className="text-muted">{requirement.lineNo}.</span>{' '}
                      {requirement.productName}
                    </p>
                    <p className="text-xs text-muted">{summaryOf(requirement).join(' · ')}</p>
                  </div>

                  {canEdit && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(requirement.id)}
                    >
                      Edit
                    </Button>
                  )}
                </div>

                <MatchedProduct requirement={requirement} />
              </li>
            ),
          )}
        </ul>
      )}

      {adding && canEdit && (
        <RequirementCard
          leadId={leadId}
          canEdit={canEdit}
          onDone={done}
          onCancel={() => setAdding(false)}
        />
      )}
    </Card>
  );
}
