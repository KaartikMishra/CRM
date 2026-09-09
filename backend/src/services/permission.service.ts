/**
 * §20–21 — permission resolution in two layers.
 *
 *     role default  →  UserModulePermission override
 *
 * An absent override row means "use the role default", so v1 runs with no
 * permission rows at all while the mechanism is already in place for the six
 * modules that arrive later. There is exactly one permission table and one
 * resolver; controllers never decide access for themselves.
 */

import type { AppModule, PermissionAction, Role } from '@rs/shared';
import { prisma } from '../config/database.js';

type ActionSet = Partial<Record<PermissionAction, boolean>>;
type ModuleMatrix = Partial<Record<AppModule, ActionSet>>;

const ALL: ActionSet = { VIEW: true, CREATE: true, EDIT: true, DELETE: true, ASSIGN: true };

/**
 * §22 — the approved defaults.
 *
 * ADMIN holds every action on every module. USER holds view, create and edit on
 * Product Enquiry; the ownership rules in enquiry-access.ts narrow "edit" to
 * records the person actually owns. Reassigning Towards is ASSIGN, and is
 * ADMIN-only.
 *
 * The six later modules deny USER by default. That is not a business rule about
 * them — it is the safe default until their requirements arrive.
 */
const ROLE_DEFAULTS: Record<Role, ModuleMatrix> = {
  ADMIN: {
    PRODUCT_ENQUIRY: ALL,
    SALES: ALL,
    PROCUREMENT: ALL,
    PACKING_DISPATCH: ALL,
    CUSTOMER_BILLING: ALL,
    VENDOR_INVOICE: ALL,
    POST_SALES: ALL,
  },
  USER: {
    PRODUCT_ENQUIRY: { VIEW: true, CREATE: true, EDIT: true, DELETE: false, ASSIGN: false },
    // Sales mirrors Product Enquiry: employees record and maintain their own
    // orders, while deleting one and reassigning stay with administrators. The
    // ownership rules in sales-access.ts narrow "edit" to orders they created.
    SALES: { VIEW: true, CREATE: true, EDIT: true, DELETE: false, ASSIGN: false },
  },
};

export function roleDefault(role: Role, module: AppModule, action: PermissionAction): boolean {
  return ROLE_DEFAULTS[role][module]?.[action] ?? false;
}

/**
 * Resolves one capability. The override is authoritative when a row exists —
 * including when it exists and says `false`, which is how access is revoked for
 * a single person without changing their role.
 */
export async function resolvePermission(
  userId: string,
  role: Role,
  module: AppModule,
  action: PermissionAction,
): Promise<boolean> {
  const override = await prisma.userModulePermission.findUnique({
    where: { userId_module_action: { userId, module, action } },
    select: { allowed: true },
  });

  return override ? override.allowed : roleDefault(role, module, action);
}

/** The effective matrix for one person, for /api/auth/me. */
export async function effectivePermissions(
  userId: string,
  role: Role,
): Promise<{ module: AppModule; action: PermissionAction; allowed: boolean }[]> {
  const overrides = await prisma.userModulePermission.findMany({
    where: { userId },
    select: { module: true, action: true, allowed: true },
  });

  const overrideMap = new Map(overrides.map((o) => [`${o.module}:${o.action}`, o.allowed]));
  const modules = Object.keys(ROLE_DEFAULTS.ADMIN) as AppModule[];
  const actions: PermissionAction[] = ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'ASSIGN'];

  return modules.flatMap((module) =>
    actions.map((action) => ({
      module,
      action,
      allowed: overrideMap.get(`${module}:${action}`) ?? roleDefault(role, module, action),
    })),
  );
}

/**
 * Everyone who can currently do one thing — the reverse of the question above.
 *
 * Needed because a notification has to be addressed. "Tell procurement" means
 * nothing until it resolves to a list of people, and the only honest source
 * for that list is the same two-layer rule every request already obeys.
 *
 * The override table alone is the wrong answer, and quietly so. Absent rows
 * mean "inherit the role default", and most people have no rows at all — an
 * administrator holds PROCUREMENT because ADMIN does, not because a row says
 * so. Querying only overrides would therefore address a notice to nobody while
 * appearing to work. So the set is:
 *
 *   (people whose role allows it, minus those revoked by an override)
 *     ∪ (people whose role denies it, but who were granted it by an override)
 *
 * Two queries regardless of how many users exist, resolved in memory. Inactive
 * users are excluded here rather than by the caller: someone who cannot sign
 * in cannot act on what they are told.
 */
export async function usersWithPermission(
  module: AppModule,
  action: PermissionAction,
): Promise<{ id: string; role: Role }[]> {
  const [users, overrides] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, role: true },
    }),
    prisma.userModulePermission.findMany({
      where: { module, action },
      select: { userId: true, allowed: true },
    }),
  ]);

  // An override is authoritative when present — including when it says false,
  // which is how one person's access is revoked without changing their role.
  const overrideByUser = new Map(overrides.map((o) => [o.userId, o.allowed]));

  return users.filter((user) => overrideByUser.get(user.id) ?? roleDefault(user.role, module, action));
}
