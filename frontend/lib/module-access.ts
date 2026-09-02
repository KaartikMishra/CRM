import { APP_MODULES, APP_MODULE_LABELS, type AppModule } from '@rs/shared';
import type { CurrentUser } from './current-user';
import { can } from './current-user';

/**
 * Which modules the signed-in person may reach.
 *
 * Resolved from the permission matrix the backend returns, never from the role
 * alone (§59) — a UserModulePermission row can revoke a module from one person
 * without changing their role, and only the matrix reflects that.
 *
 * VIEW is the test because it is what every module's list and detail route
 * requires. Hiding a module here is a courtesy; the API rejects the request
 * again regardless of what the sidebar chose to draw (§6).
 */
export function accessibleModules(user: CurrentUser | null): AppModule[] {
  if (!user) return [];
  return APP_MODULES.filter((module) => can(user, module, 'VIEW'));
}

export function hasModule(user: CurrentUser | null, module: AppModule): boolean {
  return can(user, module, 'VIEW');
}

export const moduleLabel = (module: AppModule): string => APP_MODULE_LABELS[module];

/** Presentation order for the module checkboxes and the sidebar. */
export const MODULE_ORDER: readonly AppModule[] = APP_MODULES;
