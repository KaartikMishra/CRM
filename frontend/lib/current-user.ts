import { cache } from 'react';
import type { AppModule, PermissionAction, Role } from '@rs/shared';
import { apiFetch } from './api-server';

/**
 * The signed-in employee, as the backend reports them.
 *
 * Permissions come from the API rather than from the session token, because the
 * backend resolves them per request from role defaults plus per-user overrides.
 * Reading them from a JWT would mean a revoked capability kept working until the
 * token expired.
 *
 * `cache` deduplicates this within a single render pass, so a page and the
 * components inside it share one round trip.
 */

export type Permission = {
  module: AppModule;
  action: PermissionAction;
  allowed: boolean;
};

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  role: Role;
  permissions: Permission[];
};

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const result = await apiFetch<CurrentUser>('/api/auth/me');
  return result.success ? result.data : null;
});

/**
 * §59 — never decide access with `role === 'ADMIN'` alone. A
 * UserModulePermission row can grant or revoke a capability for one person, and
 * only the resolved matrix reflects that.
 */
export function can(
  user: CurrentUser | null,
  module: AppModule,
  action: PermissionAction,
): boolean {
  if (!user) return false;
  return user.permissions.some((p) => p.module === module && p.action === action && p.allowed);
}

/** Initials for the avatar; two letters at most. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
