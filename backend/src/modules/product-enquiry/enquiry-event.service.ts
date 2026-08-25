/**
 * §25 — the enquiry timeline.
 *
 * Append-only by construction: this module exposes no update or delete, so
 * nothing already recorded can be rewritten. Every write takes the transaction
 * client, so an event and the change it describes commit together or not at all.
 *
 * Uses the existing EnquiryEventType values unchanged. There is deliberately no
 * FIRST_SUBMITTED value: the first submit is recorded as PARTIAL_SUBMITTED or
 * FULL_SUBMITTED, and a late one additionally emits DEADLINE_BREACHED.
 */

import type { Prisma } from '@rs/database';
import type { EnquiryEventType } from '@rs/shared';

export type EventInput = {
  enquiryId: string;
  type: EnquiryEventType;
  /** Null means the system acted — the SLA sweeper, for instance. */
  actorId?: string | null;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export async function recordEvent(
  tx: Prisma.TransactionClient,
  input: EventInput,
): Promise<void> {
  await tx.enquiryEvent.create({
    data: {
      enquiryId: input.enquiryId,
      type: input.type,
      actorId: input.actorId ?? null,
      field: input.field ?? null,
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
      metadata: input.metadata,
    },
  });
}

export async function recordEvents(
  tx: Prisma.TransactionClient,
  inputs: EventInput[],
): Promise<void> {
  await tx.enquiryEvent.createMany({
    data: inputs.map((input) => ({
      enquiryId: input.enquiryId,
      type: input.type,
      actorId: input.actorId ?? null,
      field: input.field ?? null,
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
      metadata: input.metadata,
    })),
  });
}
