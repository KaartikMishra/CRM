import { z } from 'zod';
import {
  AWB_MAX_LENGTH,
  DISPATCH_CARRIERS,
  DISPATCH_CHANNELS,
} from '../constants/index.js';
import { cuidSchema, paginationSchema } from './common.js';
import { DISPATCH_STATUSES } from '../enums.js';

/**
 * The Packing & Dispatch contract.
 *
 * Two rules shape everything here, and both exist in the database as well as in
 * these schemas — deliberately, so a row written by any route obeys them:
 *
 *   - **Nothing here moves stock.** Allocation already took the goods out of
 *     free stock when they were committed to the order; dispatch records their
 *     physical movement. There is no quantity field on this module that feeds
 *     any stock figure, and none of these schemas accepts one.
 *
 *   - **A shipment that cannot be traced has not been dispatched.** The carrier
 *     and the airway bill are optional while packing and required at the moment
 *     the goods leave, which is why they live on different schemas below rather
 *     than being optional everywhere.
 */

// ---------------------------------------------------------------------------
//  Shared field shapes
// ---------------------------------------------------------------------------

/**
 * "OTHER" plus a written name is one answer, not two.
 *
 * Every place a channel or carrier is accepted, the free-text partner is
 * required when the answer is OTHER and refused otherwise — a stored
 * `carrierOther` beside a named carrier would be a second, contradictory
 * statement about who is carrying the goods.
 */
const channelShape = {
  channel: z.enum(DISPATCH_CHANNELS),
  channelOther: z.string().trim().min(1).max(120).optional(),
};

const carrierShape = {
  carrier: z.enum(DISPATCH_CARRIERS),
  carrierOther: z.string().trim().min(1).max(120).optional(),
};

/** The airway bill, as the courier issues it. Text: formats vary and carry
    leading zeros, so nothing here parses it as a number. */
const awbSchema = z.string().trim().min(1, 'Enter the AWB number').max(AWB_MAX_LENGTH);

type OtherPair = {
  value: string;
  other?: string | undefined;
  field: 'channel' | 'carrier';
};

/** Adds the OTHER/free-text agreement issue, so both fields report together. */
function checkOther({ value, other, field }: OtherPair, ctx: z.RefinementCtx): void {
  const otherField = `${field}Other` as const;

  if (value === 'OTHER' && !other) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [otherField],
      message: `Name the ${field} when choosing Other`,
    });
  }

  if (value !== 'OTHER' && other) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [otherField],
      message: `Only fill this in when the ${field} is Other`,
    });
  }
}

// ---------------------------------------------------------------------------
//  Creating and packing
// ---------------------------------------------------------------------------

/** One line of an order, and how many of its units this shipment carries. */
export const dispatchItemInputSchema = z.object({
  salesOrderItemId: cuidSchema,
  quantity: z
    .number({ invalid_type_error: 'Quantity must be a number' })
    .int('Quantity must be a whole number')
    .min(1, 'A shipment carries at least one unit'),
});

/**
 * Opening a shipment against an order.
 *
 * Carrier and AWB are deliberately absent: a pack is started before anybody
 * knows how it will travel. They arrive with `updateDispatchSchema` and are
 * enforced at the moment of dispatch.
 */
export const createDispatchSchema = z.object({
  salesOrderId: cuidSchema,
  /**
   * Which lines, and how many of each.
   *
   * Always explicit, even for a shipment carrying the whole order: what a
   * shipment contained is a fact about a parcel somebody sealed, and deriving
   * it later from the order would lose that.
   */
  items: z
    .array(dispatchItemInputSchema)
    .min(1, 'A shipment has to carry at least one product'),
});

/**
 * Filling in how the shipment travels.
 *
 * Every field optional: this is used while packing, and a courier chosen before
 * the AWB is known is an ordinary sequence. What it may *not* do is contradict
 * itself — hence the OTHER checks.
 */
export const updateDispatchSchema = z
  .object({
    channel: channelShape.channel.optional(),
    channelOther: channelShape.channelOther,
    carrier: carrierShape.carrier.optional(),
    carrierOther: carrierShape.carrierOther,
    awb: awbSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.channel) {
      checkOther({ value: value.channel, other: value.channelOther, field: 'channel' }, ctx);
    } else if (value.channelOther) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channelOther'],
        message: 'Choose a channel first',
      });
    }

    if (value.carrier) {
      checkOther({ value: value.carrier, other: value.carrierOther, field: 'carrier' }, ctx);
    } else if (value.carrierOther) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['carrierOther'],
        message: 'Choose a carrier first',
      });
    }
  });

/**
 * Sending the goods.
 *
 * Here the tracing fields stop being optional. A shipment leaving without a
 * carrier and an AWB is one nobody can answer a customer about, so the contract
 * refuses it rather than recording a parcel that cannot be found.
 *
 * The customer's own details — name, address, phone — are checked by the
 * service against the order, not here: this schema describes the request body,
 * and those live on the Customer record.
 */
export const dispatchOrderSchema = z
  .object({
    ...channelShape,
    ...carrierShape,
    awb: awbSchema,
  })
  .superRefine((value, ctx) => {
    checkOther({ value: value.channel, other: value.channelOther, field: 'channel' }, ctx);
    checkOther({ value: value.carrier, other: value.carrierOther, field: 'carrier' }, ctx);
  });

// ---------------------------------------------------------------------------
//  Partial dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch asking whether part of an order may go now.
 *
 * The question itself carries no reason: "these lines are ready and these are
 * not, may we send what is ready" is fully stated by the order's own state. The
 * reason belongs to the answer.
 *
 * `reason` and `poa` are here for the one case where the question and the answer
 * are the same act — an administrator, who needs nobody's permission and whose
 * request is therefore allowed the moment it is made. They are optional in the
 * schema because a USER raising an ordinary request supplies neither; the
 * service requires the reason of an administrator, because that is a rule about
 * who is asking, which a body schema cannot see.
 */
export const createPartialDispatchRequestSchema = z.object({
  salesOrderId: cuidSchema,
  /** Optional context for the procurement person reading it. */
  note: z.string().trim().max(1000).optional(),
  /** Required of an administrator, whose request decides itself. */
  reason: z.string().trim().min(1).max(2000).optional(),
  /** Always optional: an allowed dispatch needs no alternative plan. */
  poa: z.string().trim().max(2000).optional(),
});

/**
 * Procurement's answer.
 *
 * The asymmetry is the business rule, and it is enforced here and by the
 * database's own CHECK constraints so neither can drift:
 *
 *   ALLOW     reason required, plan of action optional — permitting needs no
 *             alternative plan, but it does need a justification on record.
 *   DISALLOW  reason required AND plan of action required — refusing leaves
 *             goods sitting, so somebody has to say what happens instead.
 */
export const decidePartialDispatchSchema = z
  .object({
    decision: z.enum(['ALLOW', 'DISALLOW']),
    reason: z.string().trim().min(1, 'A reason is required').max(2000),
    poa: z.string().trim().max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'DISALLOW' && !value.poa) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['poa'],
        message: 'A plan of action is required when refusing a partial dispatch',
      });
    }
  });

// ---------------------------------------------------------------------------
//  Reading
// ---------------------------------------------------------------------------

export const dispatchListQuerySchema = paginationSchema.extend({
  status: z.enum(DISPATCH_STATUSES).optional(),
  /** Matches the order number, the customer's name, or an AWB. */
  q: z.string().trim().max(200).optional(),
});

export const dispatchIdParamSchema = z.object({ id: cuidSchema });

export type DispatchItemInput = z.infer<typeof dispatchItemInputSchema>;
export type CreateDispatchInput = z.infer<typeof createDispatchSchema>;
export type UpdateDispatchInput = z.infer<typeof updateDispatchSchema>;
export type DispatchOrderInput = z.infer<typeof dispatchOrderSchema>;
export type CreatePartialDispatchRequestInput = z.infer<
  typeof createPartialDispatchRequestSchema
>;
export type DecidePartialDispatchInput = z.infer<typeof decidePartialDispatchSchema>;
export type DispatchListQuery = z.infer<typeof dispatchListQuerySchema>;
