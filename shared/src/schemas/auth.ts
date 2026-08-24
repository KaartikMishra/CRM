import { z } from 'zod';
import { APP_MODULES, PERMISSION_ACTIONS, ROLES } from '../enums.js';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

/** Shape returned by /api/auth/me — drives every client-side permission check. */
export const sessionUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  employeeId: z.string(),
  role: z.enum(ROLES),
  permissions: z.array(
    z.object({
      module: z.enum(APP_MODULES),
      action: z.enum(PERMISSION_ACTIONS),
      allowed: z.boolean(),
    }),
  ),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
