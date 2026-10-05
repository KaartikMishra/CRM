/**
 * Response contracts for Create Lead / Deal — Phase 1.
 *
 * These describe what crosses the wire, which is not the Prisma row: DateTime
 * arrives as an ISO string, and the customer travels as the existing
 * `CustomerView` rather than as copied fields, so a lead can never disagree
 * with the Customer master about who somebody is.
 */

import type { LeadChannel } from '../constants/index.js';
import type { LeadSource, RequirementType } from '../enums.js';
import type { CustomerView } from './enquiry.js';
import type { IsoDateTime, UserRef } from './enquiry.js';

/** One lead, as the API reports it. */
export type LeadView = {
  id: string;

  leadSource: LeadSource;
  /** The written name, present only when `leadSource` is OTHER. */
  leadSourceOther: string | null;
  /** Free-text reference for the source. Generic by design — see the schema. */
  sourceDetails: string | null;
  /** When the enquiry happened, which is not when the row was created. */
  sourceAt: IsoDateTime;

  requirementType: RequirementType;

  /** The existing Customer master, never a copy of it. */
  customer: CustomerView;

  channel: LeadChannel;
  channelOther: string | null;

  createdBy: UserRef;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

/**
 * What a phone lookup found.
 *
 * A list rather than a single customer, deliberately. Phone is meant to be one
 * customer's identifier, but the live data carries duplicates from dummy and
 * historical rows — so the contract admits the possibility and makes the caller
 * handle it, instead of silently returning the first row and linking a lead to
 * the wrong person.
 *
 *   0 matches  the form offers Add Customer
 *   1 match    shown directly, ready to link
 *   2+ matches every one is listed and somebody has to choose
 */
export type LeadCustomerLookupResult = {
  /** The digits the search actually ran on, so the UI can show what it matched. */
  normalizedPhone: string;
  customers: CustomerView[];
};
