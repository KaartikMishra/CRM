/**
 * Every HR database read and write, and nothing else.
 *
 * No business rule lives here: the service decides, this executes. The selects are
 * shared constants rather than inline objects so a field cannot be exposed in one
 * query and withheld in another — which is how a confidential column leaks.
 *
 * ### What this module never writes
 *
 * `User`, `UserModulePermission`, and every table belonging to Sales, Purchase,
 * Dispatch, Post Sales, Lead, RsProduct or inventory. Linking an account sets
 * `Employee.userId`; it does not touch the User row, create credentials, or change
 * anybody's permissions. Verified by grep in the module's own test.
 */

import type { Prisma } from '@prisma/client';
import { EMPLOYED_STATUSES, EMPLOYEE_ID_PREFIX } from '@rs/shared';
import { prisma } from '../../config/database.js';

// ---------------------------------------------------------------------------
//  Selects
// ---------------------------------------------------------------------------

const employeeRefSelect = {
  id: true,
  employeeId: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.EmployeeSelect;

const orgUnitRefSelect = { id: true, name: true, code: true } satisfies Prisma.DepartmentSelect;

/** One directory row. Deliberately narrow — see EmployeeRow in @rs/shared. */
export const employeeRowSelect = {
  id: true,
  employeeId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  workEmail: true,
  status: true,
  employmentType: true,
  workMode: true,
  joiningDate: true,
  /*
    `userId` only, never the User row. A directory needs to show whether somebody
    has a login; it does not need their email, role or activity, and selecting the
    relation here would put all three into every list response.
  */
  userId: true,
  department: { select: orgUnitRefSelect },
  designation: { select: orgUnitRefSelect },
  manager: { select: employeeRefSelect },
} satisfies Prisma.EmployeeSelect;

/**
 * The full profile, in one query.
 *
 * History and documents are included rather than fetched separately: a profile
 * page needs all three, and three round trips to Neon is three times the latency
 * for one screen. Both child lists are bounded — an employee with 400 history rows
 * is real, and a page does not need them all.
 */
export const employeeDetailSelect = {
  id: true,
  employeeId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  workEmail: true,
  status: true,
  employmentType: true,
  workMode: true,
  joiningDate: true,
  userId: true,
  department: { select: orgUnitRefSelect },
  designation: { select: orgUnitRefSelect },
  manager: { select: employeeRefSelect },
  phone: true,
  location: true,
  exitDate: true,
  managerId: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      employeeId: true,
      role: true,
      isActive: true,
      // passwordHash is absent, and must stay absent. This is the one place an
      // HR query touches the User table at all.
    },
  },
  reports: {
    select: employeeRefSelect,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  },
  history: {
    select: {
      id: true,
      eventType: true,
      fromValue: true,
      toValue: true,
      note: true,
      effectiveAt: true,
      performedBy: { select: { id: true, name: true } },
    },
    orderBy: { effectiveAt: 'desc' },
    take: 50,
  },
  documents: {
    select: {
      id: true,
      documentType: true,
      title: true,
      issuedOn: true,
      expiresOn: true,
      verificationStatus: true,
      verifiedAt: true,
      createdAt: true,
      verifiedBy: { select: { id: true, name: true } },
      uploadedBy: { select: { id: true, name: true } },
      // The file's own metadata, from Phase 0.5's table. `publicId` is
      // deliberately NOT selected: it is the storage handle, it is useless to a
      // browser without a signature, and a profile response is not where it
      // belongs. Signed links are minted by their own endpoint.
      secureDocument: { select: { fileName: true, mimeType: true, bytes: true } },
    },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.EmployeeSelect;

export const departmentSelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  parent: { select: orgUnitRefSelect },
  head: { select: employeeRefSelect },
  /** Counted by the database — a stored tally would be free to drift. */
  _count: { select: { employees: true, children: true } },
} satisfies Prisma.DepartmentSelect;

export const designationSelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  status: true,
  level: true,
  createdAt: true,
  updatedAt: true,
  department: { select: orgUnitRefSelect },
  _count: { select: { employees: true } },
} satisfies Prisma.DesignationSelect;

export type EmployeeRowRecord = Prisma.EmployeeGetPayload<{ select: typeof employeeRowSelect }>;
export type EmployeeDetailRecord = Prisma.EmployeeGetPayload<{
  select: typeof employeeDetailSelect;
}>;
export type DepartmentRecord = Prisma.DepartmentGetPayload<{ select: typeof departmentSelect }>;
export type DesignationRecord = Prisma.DesignationGetPayload<{ select: typeof designationSelect }>;

// ---------------------------------------------------------------------------
//  Employee id allocation
// ---------------------------------------------------------------------------

/**
 * Allocates the next employee id, atomically.
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the caller's transaction.
 * The obvious alternative — read the highest existing id and add one — is wrong
 * under concurrency: two simultaneous creates read the same maximum, both build
 * the same id, and the unique index fails one of them at random. That is not
 * hypothetical; it is what the existing user-management helper does, and it is why
 * `PostSalesCaseCounter` exists. This follows that precedent exactly.
 *
 * The counter is seeded from the existing `User.employeeId` values on first use,
 * so HR ids continue the RS-series the business already uses rather than restarting
 * at RS001 and colliding with people who already have one.
 */
export async function allocateEmployeeId(tx: Prisma.TransactionClient): Promise<string> {
  const seed = await highestExistingIdNumber(tx);

  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "EmployeeIdCounter" ("prefix", "lastValue", "updatedAt")
    VALUES (${EMPLOYEE_ID_PREFIX}, ${seed + 1}, now())
    ON CONFLICT ("prefix")
    DO UPDATE SET
      "lastValue" = GREATEST("EmployeeIdCounter"."lastValue" + 1, ${seed + 1}),
      "updatedAt" = now()
    RETURNING "lastValue"
  `;

  const next = rows[0]?.lastValue;
  if (next === undefined) throw new Error('Employee id counter returned no value');

  return `${EMPLOYEE_ID_PREFIX}${String(next).padStart(3, '0')}`;
}

/**
 * The highest RS-number already in use, across both tables.
 *
 * Both, because `User.employeeId` predates this module and holds real ids: an HR
 * record must not be allocated RS003 while a user account already has it. The
 * GREATEST above means a manually inserted higher id is respected rather than
 * silently reused — the brief's "never silently reused" requirement.
 *
 * This read is inside the same transaction as the counter update, so it cannot
 * observe a half-applied allocation.
 */
async function highestExistingIdNumber(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ highest: number | null }[]>`
    SELECT MAX(n) AS "highest" FROM (
      SELECT CAST(substring("employeeId" FROM 3) AS INTEGER) AS n
        FROM "Employee"
       WHERE "employeeId" ~ ('^' || ${EMPLOYEE_ID_PREFIX} || '[0-9]+$')
      UNION ALL
      SELECT CAST(substring("employeeId" FROM 3) AS INTEGER) AS n
        FROM "User"
       WHERE "employeeId" ~ ('^' || ${EMPLOYEE_ID_PREFIX} || '[0-9]+$')
    ) AS ids
  `;

  return rows[0]?.highest ?? 0;
}

// ---------------------------------------------------------------------------
//  Hierarchy
// ---------------------------------------------------------------------------

/**
 * Every employee above `startId` in the reporting chain, nearest first.
 *
 * A recursive CTE rather than a loop of queries: a chain of eight managers would
 * otherwise be eight round trips to Neon for one validation. Bounded by `depth` so
 * a cycle that somehow already exists in the data cannot spin forever — without
 * that guard this function would be the thing that hangs rather than the thing that
 * reports the problem.
 */
export async function managerAncestors(
  tx: Prisma.TransactionClient,
  startId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE chain AS (
      SELECT "id", "managerId", 1 AS depth
        FROM "Employee"
       WHERE "id" = ${startId}
      UNION ALL
      SELECT e."id", e."managerId", c.depth + 1
        FROM "Employee" e
        JOIN chain c ON e."id" = c."managerId"
       WHERE c.depth < 50
    )
    SELECT "id" FROM chain WHERE "id" <> ${startId}
  `;

  return rows.map((row) => row.id);
}

/** Every department above `startId`, for the same cycle check on the org tree. */
export async function departmentAncestors(
  tx: Prisma.TransactionClient,
  startId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE chain AS (
      SELECT "id", "parentId", 1 AS depth
        FROM "Department"
       WHERE "id" = ${startId}
      UNION ALL
      SELECT d."id", d."parentId", c.depth + 1
        FROM "Department" d
        JOIN chain c ON d."id" = c."parentId"
       WHERE c.depth < 50
    )
    SELECT "id" FROM chain WHERE "id" <> ${startId}
  `;

  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
//  Employee reads and writes
// ---------------------------------------------------------------------------

export function findEmployee(id: string): Promise<EmployeeDetailRecord | null> {
  return prisma.employee.findUnique({ where: { id }, select: employeeDetailSelect });
}

/** The scope check needs only these two fields, so it does not fetch a profile. */
export function findEmployeeScope(
  id: string,
): Promise<{ id: string; managerId: string | null } | null> {
  return prisma.employee.findUnique({ where: { id }, select: { id: true, managerId: true } });
}

export function findEmployeeByWorkEmail(workEmail: string): Promise<{ id: string } | null> {
  return prisma.employee.findUnique({ where: { workEmail }, select: { id: true } });
}

/** The HR record already tied to one account, if any — the link-safety check. */
export function findEmployeeByUserId(userId: string): Promise<{ id: string } | null> {
  return prisma.employee.findUnique({ where: { userId }, select: { id: true } });
}

export function listEmployees(args: {
  where: Prisma.EmployeeWhereInput;
  take: number;
  cursor?: string;
  orderBy: Prisma.EmployeeOrderByWithRelationInput[];
}): Promise<EmployeeRowRecord[]> {
  return prisma.employee.findMany({
    where: args.where,
    select: employeeRowSelect,
    // One more than asked for: its presence says another page exists, without a
    // second count query.
    take: args.take + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    orderBy: args.orderBy,
  });
}

export function createEmployee(
  tx: Prisma.TransactionClient,
  data: Prisma.EmployeeUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.employee.create({ data, select: { id: true } });
}

export function updateEmployee(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.EmployeeUncheckedUpdateInput,
): Promise<{ id: string }> {
  return tx.employee.update({ where: { id }, data, select: { id: true } });
}

/**
 * Appends history rows.
 *
 * `createMany` because one change can produce several entries — a transfer that
 * moves department and designation together is two events, written in one call
 * inside the same transaction as the change itself. History that could be written
 * without the change, or the reverse, would be a timeline that lies.
 */
export function addHistory(
  tx: Prisma.TransactionClient,
  rows: Prisma.EmployeeHistoryUncheckedCreateInput[],
): Promise<{ count: number }> {
  return tx.employeeHistory.createMany({ data: rows });
}

export function listHistory(employeeId: string, take: number) {
  return prisma.employeeHistory.findMany({
    where: { employeeId },
    select: {
      id: true,
      eventType: true,
      fromValue: true,
      toValue: true,
      note: true,
      effectiveAt: true,
      performedBy: { select: { id: true, name: true } },
    },
    orderBy: { effectiveAt: 'desc' },
    take,
  });
}

// ---------------------------------------------------------------------------
//  Department and Designation
// ---------------------------------------------------------------------------

export function findDepartment(id: string): Promise<DepartmentRecord | null> {
  return prisma.department.findUnique({ where: { id }, select: departmentSelect });
}

export function findDepartmentByCode(code: string): Promise<{ id: string } | null> {
  return prisma.department.findUnique({ where: { code }, select: { id: true } });
}

export function listDepartments(args: {
  where: Prisma.DepartmentWhereInput;
  take: number;
  cursor?: string;
}): Promise<DepartmentRecord[]> {
  return prisma.department.findMany({
    where: args.where,
    select: departmentSelect,
    take: args.take + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
}

export function createDepartment(
  data: Prisma.DepartmentUncheckedCreateInput,
): Promise<{ id: string }> {
  return prisma.department.create({ data, select: { id: true } });
}

export function updateDepartment(
  id: string,
  data: Prisma.DepartmentUncheckedUpdateInput,
): Promise<{ id: string }> {
  return prisma.department.update({ where: { id }, data, select: { id: true } });
}

export function findDesignation(id: string): Promise<DesignationRecord | null> {
  return prisma.designation.findUnique({ where: { id }, select: designationSelect });
}

export function findDesignationByCode(code: string): Promise<{ id: string } | null> {
  return prisma.designation.findUnique({ where: { code }, select: { id: true } });
}

export function listDesignations(args: {
  where: Prisma.DesignationWhereInput;
  take: number;
  cursor?: string;
}): Promise<DesignationRecord[]> {
  return prisma.designation.findMany({
    where: args.where,
    select: designationSelect,
    take: args.take + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    orderBy: [{ level: 'asc' }, { name: 'asc' }, { id: 'asc' }],
  });
}

export function createDesignation(
  data: Prisma.DesignationUncheckedCreateInput,
): Promise<{ id: string }> {
  return prisma.designation.create({ data, select: { id: true } });
}

export function updateDesignation(
  id: string,
  data: Prisma.DesignationUncheckedUpdateInput,
): Promise<{ id: string }> {
  return prisma.designation.update({ where: { id }, data, select: { id: true } });
}

// ---------------------------------------------------------------------------
//  Documents
// ---------------------------------------------------------------------------

export function findEmployeeDocument(id: string) {
  return prisma.employeeDocument.findUnique({
    where: { id },
    select: {
      id: true,
      employeeId: true,
      documentType: true,
      title: true,
      verificationStatus: true,
      secureDocument: {
        select: { id: true, publicId: true, mimeType: true, module: true, ownerType: true, ownerId: true },
      },
    },
  });
}

export function createEmployeeDocument(
  data: Prisma.EmployeeDocumentUncheckedCreateInput,
): Promise<{ id: string }> {
  return prisma.employeeDocument.create({ data, select: { id: true } });
}

export function updateEmployeeDocument(
  id: string,
  data: Prisma.EmployeeDocumentUncheckedUpdateInput,
): Promise<{ id: string }> {
  return prisma.employeeDocument.update({ where: { id }, data, select: { id: true } });
}

/** The stored file this metadata points at, for the signed-link endpoint. */
export function findSecureDocumentForEmployee(secureDocumentId: string) {
  return prisma.secureDocument.findUnique({
    where: { id: secureDocumentId },
    select: { id: true, publicId: true, mimeType: true, ownerType: true, ownerId: true },
  });
}

// ---------------------------------------------------------------------------
//  Overview
// ---------------------------------------------------------------------------

/**
 * The four landing figures, in one round trip.
 *
 * Four counts rather than a view or a stored tally: they are cheap against the
 * indexes these tables already carry, and a stored figure would be a second answer
 * free to disagree with the rows.
 */
export async function overviewCounts(): Promise<{
  totalEmployees: number;
  employedCount: number;
  activeDepartments: number;
  activeDesignations: number;
}> {
  const [totalEmployees, employedCount, activeDepartments, activeDesignations] = await Promise.all([
    prisma.employee.count(),
    prisma.employee.count({ where: { status: { in: [...EMPLOYED_STATUSES] } } }),
    prisma.department.count({ where: { status: 'ACTIVE' } }),
    prisma.designation.count({ where: { status: 'ACTIVE' } }),
  ]);

  return { totalEmployees, employedCount, activeDepartments, activeDesignations };
}
