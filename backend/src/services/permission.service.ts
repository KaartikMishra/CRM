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

import { PERMISSION_ACTIONS, type AppModule, type PermissionAction, type Role } from '@rs/shared';
import { prisma } from '../config/database.js';

type ActionSet = Partial<Record<PermissionAction, boolean>>;
type ModuleMatrix = Partial<Record<AppModule, ActionSet>>;

/**
 * The original five actions, granted together.
 *
 * Called ALL until APPROVE, EXPORT and SELF were added for HR. `ActionSet` is a
 * Partial, so those three compiled without touching a single entry below — and
 * that is exactly why the rename matters: a constant named ALL would have gone
 * on reading as "everything" while quietly meaning "everything except the three
 * newest", with no compile error anywhere to say so. The name now states its
 * contents, and the nine modules that use it keep precisely the effective
 * permissions they had before those actions existed.
 *
 * A module that genuinely needs APPROVE, EXPORT or SELF names it explicitly.
 */
const CRUD_ASSIGN: ActionSet = {
  VIEW: true,
  CREATE: true,
  EDIT: true,
  DELETE: true,
  ASSIGN: true,
};

/** CRUD_ASSIGN plus the three HR actions — full authority over an HR namespace. */
const CRUD_ASSIGN_APPROVE_EXPORT: ActionSet = {
  ...CRUD_ASSIGN,
  APPROVE: true,
  EXPORT: true,
  /*
    SELF is deliberately absent even here. It does not widen access — it narrows
    it, meaning "your own record only". An administrator who already holds VIEW
    over everybody's records gains nothing from it, and granting it would make
    `can(user, module, 'SELF')` true for someone whose access is not self-scoped
    at all, which is the opposite of what any caller asking that question wants.
  */
};

/**
 * §22 — the approved defaults.
 *
 * ADMIN holds every action on every module. USER holds view, create and edit on
 * Product Enquiry; the ownership rules in enquiry-access.ts narrow "edit" to
 * records the person actually owns. Reassigning Towards is ASSIGN, and is
 * ADMIN-only.
 *
 * The later modules deny USER by default. That is not a business rule about
 * them — it is the safe default until their requirements arrive.
 *
 * Every module must appear under ADMIN, and not merely as a convention:
 * effectivePermissions below derives the entire module list from the keys of
 * this entry. A module omitted here is absent from /api/auth/me, and therefore
 * from the sidebar, hasModule and requireModule — for administrators too.
 */
const ROLE_DEFAULTS: Record<Role, ModuleMatrix> = {
  ADMIN: {
    PRODUCT_ENQUIRY: CRUD_ASSIGN,
    SALES: CRUD_ASSIGN,
    PROCUREMENT: CRUD_ASSIGN,
    RS_PRODUCTS: CRUD_ASSIGN,
    PACKING_DISPATCH: CRUD_ASSIGN,
    CUSTOMER_BILLING: CRUD_ASSIGN,
    VENDOR_INVOICE: CRUD_ASSIGN,
    POST_SALES: CRUD_ASSIGN,
    /*
      Mandatory, not merely conventional: `effectivePermissions` derives the
      whole module list from Object.keys(ROLE_DEFAULTS.ADMIN), so a module
      missing here is invisible to /api/auth/me — and therefore to the sidebar,
      hasModule and requireModule — even for an administrator.
    */
    LEAD_DEAL: CRUD_ASSIGN,

    /*
      HR — the same mandatory rule, which is why these are here in Phase 0.5
      rather than waiting for Phase 1's pages. A namespace omitted from this
      object does not exist as far as /api/auth/me is concerned, so an
      administrator could not be granted it even deliberately.

      APPROVE and EXPORT are granted here and nowhere else. That is the whole of
      the deny-by-default decision: the two actions exist, exactly one role on
      exactly these seven namespaces holds them, and every other module in the
      system is unchanged.
    */
    HR_EMPLOYEE: CRUD_ASSIGN_APPROVE_EXPORT,
    HR_ATTENDANCE: CRUD_ASSIGN_APPROVE_EXPORT,
    HR_LEAVE: CRUD_ASSIGN_APPROVE_EXPORT,
    HR_PAYROLL: CRUD_ASSIGN_APPROVE_EXPORT,
    HR_RECRUITMENT: CRUD_ASSIGN_APPROVE_EXPORT,
    HR_PERFORMANCE: CRUD_ASSIGN_APPROVE_EXPORT,
    HR_ADMIN: CRUD_ASSIGN_APPROVE_EXPORT,
    /*
      Training, Phase 4. Mandatory here rather than conventional:
      `effectivePermissions` derives the whole module list from
      Object.keys(ROLE_DEFAULTS.ADMIN), so a namespace missing from this object is
      invisible to /api/auth/me — and therefore to the sidebar, hasModule and
      requireModule — even for an administrator who holds it.

      USER stays absent, as with every other HR namespace: deny by default, granted
      through the existing overrides screen.
    */
    HR_TRAINING: CRUD_ASSIGN_APPROVE_EXPORT,
  },
  USER: {
    PRODUCT_ENQUIRY: { VIEW: true, CREATE: true, EDIT: true, DELETE: false, ASSIGN: false },
    // Sales mirrors Product Enquiry: employees record and maintain their own
    // orders, while deleting one and reassigning stay with administrators. The
    // ownership rules in sales-access.ts narrow "edit" to orders they created.
    SALES: { VIEW: true, CREATE: true, EDIT: true, DELETE: false, ASSIGN: false },

    /*
      No HR entry, deliberately.

      The tempting default is `HR_LEAVE: { SELF: true }` so every employee can
      apply for their own leave. It is withheld for two reasons. A role default
      is granted to everybody at once and silently: it would take effect the
      moment Phase 1 mounts a route, on every existing account, before anybody
      decided that was wanted. And Phase 0.5 ships no HR endpoint, so such a
      default could not be tested against a real request — only asserted to
      exist, which §27 of the brief is precisely about.

      HR access therefore comes only from an explicit UserModulePermission row
      until Phase 1 brings the screens. The mechanism for that already works:
      a USER holds no PROCUREMENT by default either.
    */
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
  /*
    PERMISSION_ACTIONS rather than a literal list. The literal was five actions
    typed out by hand, so APPROVE, EXPORT and SELF would have been absent from
    /api/auth/me — and therefore false everywhere `can()` is asked — while
    ROLE_DEFAULTS said otherwise. Reading the enum means the matrix cannot fall
    behind it again.
  */
  const actions: readonly PermissionAction[] = PERMISSION_ACTIONS;

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
