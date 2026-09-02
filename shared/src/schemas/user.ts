import { z } from 'zod';
import { APP_MODULES, PERMISSION_ACTIONS, ROLES } from '../enums.js';
import { cuidSchema } from './common.js';

/**
 * §22 — administrator-only user management.
 *
 * The module-access UI speaks in whole modules ("give Devansh Sales"), while
 * the permission table underneath is module × action. This file is where the
 * two vocabularies meet: `moduleAccessSchema` is a list of modules, and the
 * service expands each one into the action rows the existing resolver already
 * understands. No second permission system is introduced.
 *
 * Role is deliberately absent from every input below. Creating an administrator
 * is not something the API does — the three approved ADMIN accounts come from
 * the seed — so there is no field an escalating caller could set.
 */

/** Shared by create and edit, so the two cannot drift apart. */
export const userNameSchema = z.string().trim().min(2, 'Name is required').max(120);

/**
 * The password rule for accounts an administrator creates.
 *
 * Longer than the 8 the seed enforces, because these are set by one person for
 * another and are far more likely to be something short and guessable.
 */
export const userPasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long');

/** Which modules a person may reach. Order and duplicates do not matter. */
export const moduleAccessSchema = z
  .array(z.enum(APP_MODULES))
  .max(APP_MODULES.length)
  .transform((modules) => [...new Set(modules)]);

export const createUserSchema = z
  .object({
    name: userNameSchema,
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    /** Optional: generated from the name when the administrator leaves it blank. */
    employeeId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{3,20}$/, 'Employee ID may use letters, numbers and hyphens')
      .toUpperCase()
      .optional(),
    mobile: z
      .string()
      .trim()
      .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid mobile number')
      .optional(),
    password: userPasswordSchema,
    confirmPassword: z.string(),
    modules: moduleAccessSchema.default([]),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

/**
 * Every field optional — an administrator changing only the active flag should
 * not have to resend the name. An absent `modules` leaves access untouched,
 * which is why it is distinct from an empty array (revoke everything).
 */
export const updateUserSchema = z
  .object({
    name: userNameSchema.optional(),
    mobile: z
      .string()
      .trim()
      .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid mobile number')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    password: userPasswordSchema.optional(),
    confirmPassword: z.string().optional(),
    modules: moduleAccessSchema.optional(),
  })
  .refine(
    (value) => value.password === undefined || value.password === value.confirmPassword,
    { path: ['confirmPassword'], message: 'Passwords do not match' },
  )
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to update',
  });

/** The dedicated module-access endpoint, for the checkbox grid alone. */
export const setUserModulesSchema = z.object({ modules: moduleAccessSchema });

export const userListQuerySchema = z.object({
  q: z.string().trim().max(160).optional(),
  role: z.enum(ROLES).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const userIdParamSchema = z.object({ id: cuidSchema });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type SetUserModulesInput = z.infer<typeof setUserModulesSchema>;
export type UserListQuery = z.infer<typeof userListQuerySchema>;

/**
 * A user as the API reports them. There is no passwordHash field, and there is
 * no code path that could add one — the shape is the contract.
 */
export type ManagedUser = {
  id: string;
  employeeId: string;
  name: string;
  email: string;
  mobile: string | null;
  role: (typeof ROLES)[number];
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** The modules this person can reach, resolved the same way the API resolves them. */
  modules: (typeof APP_MODULES)[number][];
};

/** Present so a compile error fires if PERMISSION_ACTIONS ever changes shape. */
export type ManagedPermissionAction = (typeof PERMISSION_ACTIONS)[number];
