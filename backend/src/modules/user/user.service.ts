/**
 * §22 — administrator-only user management.
 *
 * The one idea worth stating up front: **module access is not a new concept**.
 * The administrator's checkbox grid speaks in whole modules, while the existing
 * permission table is module × action. This service is the only place the two
 * vocabularies are translated, by writing UserModulePermission override rows
 * that the existing resolver already reads. Nothing here bypasses
 * resolvePermission, and no second RBAC system is introduced.
 *
 * Granting Sales to a USER therefore means: write `allowed: true` rows for the
 * actions a USER is meant to hold, and `allowed: false` rows for the rest.
 * Revoking means writing them all `false` — deleting the rows would fall back
 * to the role default, which for Product Enquiry and Sales is *allowed*, so a
 * revoke implemented by deletion would silently grant.
 */

import bcrypt from 'bcrypt';
import type { Request } from 'express';
import {
  APP_MODULES,
  PERMISSION_ACTIONS,
  type AppModule,
  type CreateUserInput,
  type ManagedUser,
  type PermissionAction,
  type Role,
  type SetUserModulesInput,
  type UpdateUserInput,
  type UserListQuery,
} from '@rs/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import { roleDefault } from '../../services/permission.service.js';

/** §53 — the same cost factor the seed uses. Never diverge from it. */
const BCRYPT_ROUNDS = 12;

/**
 * The actions a USER receives when an administrator grants them a module.
 *
 * Deliberately the shape Product Enquiry and Sales already give a USER by role
 * default (§22): view, create and edit the records they own, while deleting and
 * reassigning stay administrative. Granting a module through this UI therefore
 * produces exactly the access a USER has always had — it does not invent a new,
 * more powerful kind of grant.
 */
const GRANTED_ACTIONS: readonly PermissionAction[] = ['VIEW', 'CREATE', 'EDIT'];

/** Only ever selected columns — passwordHash is not in this list, by design. */
const SAFE_SELECT = {
  id: true,
  employeeId: true,
  name: true,
  email: true,
  mobile: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

type SafeRow = Prisma.UserGetPayload<{ select: typeof SAFE_SELECT }>;

/**
 * Which modules a person can actually reach, resolved exactly as the API
 * resolves it: role default, overridden by any row that exists.
 *
 * A module counts as accessible when VIEW resolves true, because VIEW is what
 * every module's list and detail route requires. An ADMIN therefore reports all
 * seven without needing a single permission row.
 */
function modulesFor(
  role: Role,
  overrides: { module: AppModule; action: PermissionAction; allowed: boolean }[],
): AppModule[] {
  const byKey = new Map(overrides.map((o) => [`${o.module}:${o.action}`, o.allowed]));

  return APP_MODULES.filter(
    (module) => byKey.get(`${module}:VIEW`) ?? roleDefault(role, module, 'VIEW'),
  );
}

function toManagedUser(
  row: SafeRow,
  overrides: { module: AppModule; action: PermissionAction; allowed: boolean }[],
): ManagedUser {
  return {
    id: row.id,
    employeeId: row.employeeId,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    role: row.role,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    modules: modulesFor(row.role, overrides),
  };
}

function userNotFound(): AppError {
  return AppError.notFound('USER_NOT_FOUND', 'That user could not be found.');
}

/**
 * Turns a set of granted modules into the full override matrix for one person.
 *
 * Every module × action pair gets a row, so the result is unambiguous and does
 * not depend on the role default at read time. That matters when a role default
 * later changes: an administrator's explicit decision keeps meaning what they
 * chose, rather than quietly widening.
 */
function permissionRows(
  userId: string,
  granted: AppModule[],
): { userId: string; module: AppModule; action: PermissionAction; allowed: boolean }[] {
  const grantedSet = new Set(granted);

  return APP_MODULES.flatMap((module) =>
    PERMISSION_ACTIONS.map((action) => ({
      userId,
      module,
      action,
      allowed: grantedSet.has(module) && GRANTED_ACTIONS.includes(action),
    })),
  );
}

/**
 * Replaces a person's module access inside a transaction.
 *
 * Delete-then-insert rather than upsert-each: it is one round trip per step
 * instead of thirty-five, and the transaction means no request can ever observe
 * a half-applied permission set.
 */
async function writeModules(
  tx: Prisma.TransactionClient,
  userId: string,
  granted: AppModule[],
): Promise<void> {
  await tx.userModulePermission.deleteMany({ where: { userId } });
  await tx.userModulePermission.createMany({ data: permissionRows(userId, granted) });
}

/** Derives RS-style employee ids when the administrator does not supply one. */
async function nextEmployeeId(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.user.findMany({
    where: { employeeId: { startsWith: 'RS' } },
    select: { employeeId: true },
  });

  const highest = rows.reduce((max, row) => {
    const digits = /^RS(\d+)$/.exec(row.employeeId);
    return digits ? Math.max(max, Number(digits[1])) : max;
  }, 0);

  return `RS${String(highest + 1).padStart(3, '0')}`;
}

export async function listUsers(query: UserListQuery): Promise<ManagedUser[]> {
  const where: Prisma.UserWhereInput = {
    ...(query.role ? { role: query.role } : {}),
    ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' as const } },
            { email: { contains: query.q, mode: 'insensitive' as const } },
            { employeeId: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const rows = await prisma.user.findMany({
    where,
    select: { ...SAFE_SELECT, permissions: { select: { module: true, action: true, allowed: true } } },
    orderBy: [{ role: 'asc' }, { employeeId: 'asc' }],
    take: query.limit,
  });

  return rows.map(({ permissions, ...row }) => toManagedUser(row, permissions));
}

export async function getUser(id: string): Promise<ManagedUser> {
  const row = await prisma.user.findUnique({
    where: { id },
    select: { ...SAFE_SELECT, permissions: { select: { module: true, action: true, allowed: true } } },
  });
  if (!row) throw userNotFound();

  const { permissions, ...rest } = row;
  return toManagedUser(rest, permissions);
}

/**
 * Creates a USER. There is no path here that produces an ADMIN.
 *
 * `role` is not read from the input — the schema has no such field — so a
 * caller who posts `{"role":"ADMIN"}` has that key ignored rather than honoured.
 * The three approved administrator accounts come from the seed alone.
 */
export async function createUser(
  req: Request,
  actorId: string,
  input: CreateUserInput,
): Promise<ManagedUser> {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) {
    throw AppError.conflict('EMAIL_TAKEN', 'An account with that email already exists.');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const created = await prisma.$transaction(async (tx) => {
    const employeeId = input.employeeId ?? (await nextEmployeeId(tx));

    const clash = await tx.user.findUnique({ where: { employeeId }, select: { id: true } });
    if (clash) {
      throw AppError.conflict('EMPLOYEE_ID_TAKEN', 'That employee ID is already in use.');
    }

    const user = await tx.user.create({
      data: {
        employeeId,
        name: input.name,
        email: input.email,
        mobile: input.mobile ?? null,
        passwordHash,
        // Explicit rather than relying on the schema default: this is the line
        // that guarantees the API cannot mint an administrator.
        role: 'USER',
      },
      select: SAFE_SELECT,
    });

    await writeModules(tx, user.id, input.modules);
    return user;
  });

  await recordAudit(req, {
    action: 'user.created',
    entityType: 'User',
    entityId: created.id,
    actorId,
    // Records what was granted, never the password or its hash.
    newValue: { employeeId: created.employeeId, email: created.email, modules: input.modules },
  });

  return getUser(created.id);
}

/**
 * Edits a USER.
 *
 * Role is absent here for the same reason it is absent from create: there is no
 * field, so there is no escalation path. An administrator's own role is
 * likewise unreachable, which is what stops the last administrator from
 * demoting themselves out of the system.
 */
export async function updateUser(
  req: Request,
  actorId: string,
  id: string,
  input: UpdateUserInput,
): Promise<ManagedUser> {
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, isActive: true, employeeId: true },
  });
  if (!target) throw userNotFound();

  // §12 — an administrator must not lock themselves, or the last colleague who
  // could let them back in, out of the CRM.
  if (input.isActive === false && target.role === 'ADMIN') {
    if (target.id === actorId) {
      throw AppError.badRequest(
        'CANNOT_DEACTIVATE_SELF',
        'You cannot deactivate your own administrator account.',
      );
    }

    const remaining = await prisma.user.count({
      where: { role: 'ADMIN', isActive: true, id: { not: id } },
    });
    if (remaining === 0) {
      throw AppError.badRequest(
        'LAST_ADMIN',
        'This is the last active administrator. Promote another before deactivating this one.',
      );
    }
  }

  const data: Prisma.UserUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.mobile !== undefined) data.mobile = input.mobile;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.password !== undefined) {
    data.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.user.update({ where: { id }, data });
    }

    // An absent `modules` means "leave access alone"; an empty array means
    // "revoke everything". The two are deliberately different.
    if (input.modules !== undefined) {
      // Module rows on an ADMIN would be read as a *restriction* by the
      // resolver, quietly removing the full access §13 requires.
      if (target.role === 'ADMIN') {
        throw AppError.badRequest(
          'ADMIN_MODULES_IMMUTABLE',
          'Administrators always have every module. Their access cannot be edited.',
        );
      }
      await writeModules(tx, id, input.modules);
    }
  });

  await recordAudit(req, {
    action: 'user.updated',
    entityType: 'User',
    entityId: id,
    actorId,
    // Field names only for the password — never the value, never the hash.
    newValue: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.password !== undefined ? { passwordChanged: true } : {}),
      ...(input.modules !== undefined ? { modules: input.modules } : {}),
    },
  });

  return getUser(id);
}

/** The checkbox grid's own endpoint. */
export async function setUserModules(
  req: Request,
  actorId: string,
  id: string,
  input: SetUserModulesInput,
): Promise<ManagedUser> {
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!target) throw userNotFound();

  if (target.role === 'ADMIN') {
    throw AppError.badRequest(
      'ADMIN_MODULES_IMMUTABLE',
      'Administrators always have every module. Their access cannot be edited.',
    );
  }

  await prisma.$transaction((tx) => writeModules(tx, id, input.modules));

  await recordAudit(req, {
    action: 'user.modules.updated',
    entityType: 'User',
    entityId: id,
    actorId,
    newValue: { modules: input.modules },
  });

  return getUser(id);
}
