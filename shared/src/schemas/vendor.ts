import { z } from 'zod';

/** §37 — a reusable master entity, never re-created per enquiry. */
export const createVendorSchema = z.object({
  name: z.string().trim().min(2, 'Vendor name is required').max(160),
  contactPerson: z.string().trim().max(120).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number')
    .optional(),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').optional(),
  city: z.string().trim().max(120).optional(),
});

export const updateVendorSchema = createVendorSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const vendorSearchSchema = z.object({
  q: z.string().trim().max(160).optional(),
  active: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type VendorSearchQuery = z.infer<typeof vendorSearchSchema>;

export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
