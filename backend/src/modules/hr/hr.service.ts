/**
 * HR Phase 1 — Employee & Organization business rules.
 *
 * Every decision this module makes lives here: the repository executes, the
 * controller translates HTTP, and the route table states who may call what. The
 * rules worth naming up front, because they shape everything below:
 *
 *   - **Nothing is deleted.** An employee who leaves becomes EXITED; a department
 *     that is dissolved becomes ARCHIVED. HR records are the business's history
 *     of its people, and a DELETE endpoint would make that history optional.
 *   - **Every meaningful change writes history, in the same transaction.** If the
 *     change commits and the history row does not, the timeline is a lie — so
 *     they commit together or not at all.
 *   - **Derived values are never stored.** Head count, employee count per
 *     department, document expiry and display names are computed on read. A
 *     stored tally is a second answer free to drift from the rows.
 *   - **Notifications go out after commit.** A notice about a change that then
 *     rolled back is worse than no notice.
 */

import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  EMPLOYED_STATUSES,
  type AppModule,
  type PermissionAction,
  type AssignManagerInput,
  type ChangeEmployeeStatusInput,
  type CreateDepartmentInput,
  type CreateDesignationInput,
  type CreateEmployeeDocumentInput,
  type CreateEmployeeInput,
  type DepartmentListQuery,
  type DepartmentPage,
  type DepartmentView,
  type DesignationListQuery,
  type DesignationPage,
  type DesignationView,
  type EmployeeDetail,
  type EmployeeDocumentLink,
  type EmployeeDocumentView,
  type EmployeeHistoryEntry,
  type EmployeeListQuery,
  type EmployeePage,
  type EmployeeRef,
  type EmployeeRow,
  type HrOverview,
  type LinkEmployeeUserInput,
  type UpdateDepartmentInput,
  type UpdateDesignationInput,
  type UpdateEmployeeInput,
  type VerifyEmployeeDocumentInput,
} from '@rs/shared';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import { resolvePermission } from '../../services/permission.service.js';
import { signedUrlFor } from '../../services/secure-document.service.js';
import * as notifications from './hr.notify.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import * as repo from './hr.repository.js';
import {
  managerAssignmentError,
  mayViewEmployee,
  scopeFor,
  visibleEmployeeFilter,
  type HrActor,
} from './hr-access.js';

/** Matching the budget every other module's transactions use. */
export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/** Bounded, so a long-serving employee's timeline cannot become an unbounded read. */
const HISTORY_PAGE = 100;

// ---------------------------------------------------------------------------
//  Actor construction
// ---------------------------------------------------------------------------

/**
 * Resolves the acting person's HR capabilities and their own employee record.
 *
 * Permissions are resolved through the shared two-layer resolver, never read off
 * the role, so a per-user override that revokes HR access actually revokes it.
 * Both HR namespaces are resolved up front because the scope rules consult them
 * together and a lazy per-question lookup would mean several round trips per
 * request.
 */
export async function hrActor(user: AuthenticatedUser): Promise<HrActor> {
  /*
    Phase 2 widened this set rather than changing how it works: attendance and
    leave need HR_ATTENDANCE and HR_LEAVE resolved too, and the scope rules in
    attendance-access.ts consult them together. Resolved up front in one batch
    because a lazy per-question lookup would mean a round trip per capability.

    The pairs are listed once, so adding a capability is one line rather than
    three — the previous shape repeated each name in a tuple and again in the map,
    which is how the two drift apart.
  */
  const capabilities: [AppModule, PermissionAction][] = [
    ['HR_EMPLOYEE', 'VIEW'],
    ['HR_EMPLOYEE', 'EDIT'],
    ['HR_EMPLOYEE', 'APPROVE'],
    ['HR_ADMIN', 'VIEW'],
    ['HR_ADMIN', 'EDIT'],
    ['HR_ATTENDANCE', 'VIEW'],
    ['HR_ATTENDANCE', 'CREATE'],
    ['HR_ATTENDANCE', 'EDIT'],
    ['HR_ATTENDANCE', 'APPROVE'],
    ['HR_LEAVE', 'VIEW'],
    ['HR_LEAVE', 'CREATE'],
    ['HR_LEAVE', 'EDIT'],
    ['HR_LEAVE', 'APPROVE'],
    /*
      Phase 3 widens it again, the same way. Four pairs rather than one
      HR_RECRUITMENT grant, because recruitment has the sharpest internal split in
      HR so far: an interviewer needs to read the application they are interviewing
      against, and must not be able to publish a role, make an offer or read a
      background-check result. VIEW/CREATE/EDIT/APPROVE separate those.

      APPROVE is the one that carries the real weight here. It gates selecting a
      candidate, issuing and withdrawing an offer, deciding a probation and
      recording a verification result — the actions that commit the business to
      somebody or end their prospects.
    */
    ['HR_RECRUITMENT', 'VIEW'],
    ['HR_RECRUITMENT', 'CREATE'],
    ['HR_RECRUITMENT', 'EDIT'],
    ['HR_RECRUITMENT', 'APPROVE'],
    /*
      Phase 4 widens it again, and this list is the reason a capability has to be
      declared here to exist at all: `can()` answers from `granted`, which is built
      from exactly these pairs. A pair that is missing resolves to `false` for
      everybody — including an administrator who holds it by role default — so the
      route table would admit the request and the service would then refuse it.

      Five pairs, because training's five actions do genuinely different work:
      ASSIGN puts other people into courses with deadlines, and APPROVE clears
      somebody to do live customer work. Neither is the same privilege as writing
      the course.
    */
    ['HR_TRAINING', 'VIEW'],
    ['HR_TRAINING', 'CREATE'],
    ['HR_TRAINING', 'EDIT'],
    ['HR_TRAINING', 'ASSIGN'],
    ['HR_TRAINING', 'APPROVE'],
    /*
      Phase 5 widens it again, and the warning on the Phase 4 block applies with
      more force here: a pair missing from this list resolves to `false` for
      everybody, including an administrator who holds it by role default. Phase 4
      shipped with exactly that gap — the route table admitted the request and the
      service then 403'd, while typechecks and forty-five unit tests stayed green,
      because only an HTTP request can surface it.

      Five pairs, and the separation between EDIT and APPROVE is the whole point of
      the phase. EDIT writes a manager review. APPROVE *finalises* one, which locks
      the figure of record and ends the employee's ability to respond. Somebody
      trusted to appraise their team is not thereby trusted to close the appraisal
      — and the service additionally refuses an approver who is the review's own
      subject, whatever grants they hold.
    */
    ['HR_PERFORMANCE', 'VIEW'],
    ['HR_PERFORMANCE', 'CREATE'],
    ['HR_PERFORMANCE', 'EDIT'],
    ['HR_PERFORMANCE', 'ASSIGN'],
    ['HR_PERFORMANCE', 'APPROVE'],
  ];

  const resolved = await Promise.all(
    capabilities.map(([module, action]) =>
      resolvePermission(user.id, user.role, module, action),
    ),
  );

  const granted = new Map<string, boolean>(
    capabilities.map(([module, action], index) => [
      `${module}:${action}`,
      resolved[index] ?? false,
    ]),
  );

  // Their own HR record, which is what makes the manager scope possible: a manager
  // is identified by being somebody's manager, a fact about employee rows rather
  // than a permission.
  const own = await repo.findEmployeeByUserId(user.id);

  return {
    id: user.id,
    role: user.role,
    can: (module, action) => granted.get(`${module}:${action}`) ?? false,
    employeeId: own?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
//  Presentation
// ---------------------------------------------------------------------------

/**
 * How a person is named everywhere in the UI.
 *
 * Derived, never stored. A stored display name drifts the moment somebody is
 * married, corrected or transliterated differently, and then two screens disagree
 * about what to call the same colleague.
 */
function displayName(person: {
  firstName: string;
  middleName?: string | null;
  lastName: string;
}): string {
  return [person.firstName, person.middleName, person.lastName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ');
}

function toEmployeeRef(row: {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
}): EmployeeRef {
  return { id: row.id, employeeId: row.employeeId, displayName: displayName(row) };
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function toEmployeeRow(row: repo.EmployeeRowRecord): EmployeeRow {
  return {
    id: row.id,
    employeeId: row.employeeId,
    displayName: displayName(row),
    workEmail: row.workEmail,
    department: row.department,
    designation: row.designation,
    manager: row.manager ? toEmployeeRef(row.manager) : null,
    status: row.status,
    employmentType: row.employmentType,
    workMode: row.workMode,
    joiningDate: row.joiningDate.toISOString(),
    // A boolean, not the account. Whether somebody has a login is directory
    // information; which login it is, is not.
    hasAccount: row.userId !== null,
  };
}

function toHistoryEntry(row: {
  id: string;
  eventType: EmployeeHistoryEntry['eventType'];
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  effectiveAt: Date;
  performedBy: { id: string; name: string } | null;
}): EmployeeHistoryEntry {
  return {
    id: row.id,
    eventType: row.eventType,
    fromValue: row.fromValue,
    toValue: row.toValue,
    note: row.note,
    performedBy: row.performedBy,
    effectiveAt: row.effectiveAt.toISOString(),
  };
}

function toDocumentView(row: repo.EmployeeDetailRecord['documents'][number]): EmployeeDocumentView {
  return {
    id: row.id,
    documentType: row.documentType,
    title: row.title,
    fileName: row.secureDocument.fileName,
    mimeType: row.secureDocument.mimeType,
    bytes: row.secureDocument.bytes,
    issuedOn: iso(row.issuedOn),
    expiresOn: iso(row.expiresOn),
    // Derived against the clock rather than stored, so it cannot go stale: a
    // stored flag would say "valid" the day after expiry until something
    // recomputed it.
    isExpired: row.expiresOn !== null && row.expiresOn.getTime() < Date.now(),
    verificationStatus: row.verificationStatus,
    verifiedBy: row.verifiedBy,
    verifiedAt: iso(row.verifiedAt),
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function toEmployeeDetail(
  row: repo.EmployeeDetailRecord,
  options: { includeDocuments: boolean },
): EmployeeDetail {
  return {
    ...toEmployeeRow(row),
    firstName: row.firstName,
    middleName: row.middleName,
    lastName: row.lastName,
    phone: row.phone,
    location: row.location,
    exitDate: iso(row.exitDate),
    account: row.user,
    reports: row.reports.map(toEmployeeRef),
    history: row.history.map(toHistoryEntry),
    /*
      Documents are withheld rather than redacted when the reader lacks the HR
      module. A manager may see who is on their team; an identity proof or a
      contract is confidential in a way a department name is not.
    */
    documents: options.includeDocuments ? row.documents.map(toDocumentView) : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDepartmentView(row: repo.DepartmentRecord): DepartmentView {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status,
    parent: row.parent,
    head: row.head ? toEmployeeRef(row.head) : null,
    employeeCount: row._count.employees,
    childCount: row._count.children,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDesignationView(row: repo.DesignationRecord): DesignationView {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status,
    department: row.department,
    level: row.level,
    employeeCount: row._count.employees,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
//  Shared guards
// ---------------------------------------------------------------------------

const notFound = (): AppError =>
  AppError.notFound('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');

/**
 * Loads an employee the actor is allowed to see, or refuses.
 *
 * Scope failures are reported as 404 rather than 403, deliberately: telling
 * somebody "this employee exists but is not yours to read" leaks the existence and
 * the id of a colleague's record. A reader outside scope should not be able to
 * enumerate the directory by probing ids.
 */
async function loadVisibleEmployee(
  actor: HrActor,
  id: string,
): Promise<repo.EmployeeDetailRecord> {
  const scope = scopeFor(actor);
  const employee = await repo.findEmployee(id);
  if (!employee) throw notFound();
  if (!mayViewEmployee(scope, { id: employee.id, managerId: employee.managerId })) throw notFound();
  return employee;
}

/** Validates that a referenced department exists and is usable. */
async function assertDepartmentUsable(id: string): Promise<string> {
  const department = await repo.findDepartment(id);
  if (!department) {
    throw AppError.badRequest('DEPARTMENT_NOT_FOUND', 'That department could not be found.');
  }
  if (department.status === 'ARCHIVED') {
    throw AppError.badRequest(
      'DEPARTMENT_ARCHIVED',
      'That department is archived, so new employees cannot be placed in it.',
    );
  }
  return department.name;
}

async function assertDesignationUsable(id: string): Promise<string> {
  const designation = await repo.findDesignation(id);
  if (!designation) {
    throw AppError.badRequest('DESIGNATION_NOT_FOUND', 'That designation could not be found.');
  }
  if (designation.status === 'ARCHIVED') {
    throw AppError.badRequest(
      'DESIGNATION_ARCHIVED',
      'That designation is archived, so it cannot be assigned.',
    );
  }
  return designation.name;
}

// ---------------------------------------------------------------------------
//  Employees — reads
// ---------------------------------------------------------------------------

export async function listEmployees(
  actor: HrActor,
  query: EmployeeListQuery,
): Promise<EmployeePage> {
  const scope = scopeFor(actor);

  /*
    The scope filter is ANDed into the query rather than applied to the page after
    it returns. Post-filtering would make a page of 25 arrive with 3 rows while the
    cursor advanced past the other 22, so a manager's team would silently appear to
    end early — correct-looking and wrong.
  */
  const where: Prisma.EmployeeWhereInput = {
    ...(visibleEmployeeFilter(scope) as Prisma.EmployeeWhereInput),
    ...(query.status ? { status: query.status } : {}),
    ...(query.employedOnly ? { status: { in: [...EMPLOYED_STATUSES] } } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.designationId ? { designationId: query.designationId } : {}),
    ...(query.managerId ? { managerId: query.managerId } : {}),
    ...(query.employmentType ? { employmentType: query.employmentType } : {}),
    ...(query.workMode ? { workMode: query.workMode } : {}),
    ...(query.q
      ? {
          OR: [
            { firstName: { contains: query.q, mode: 'insensitive' as const } },
            { lastName: { contains: query.q, mode: 'insensitive' as const } },
            { workEmail: { contains: query.q, mode: 'insensitive' as const } },
            { employeeId: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const direction = query.direction ?? 'asc';
  const orderBy: Prisma.EmployeeOrderByWithRelationInput[] =
    query.sort === 'joiningDate'
      ? [{ joiningDate: direction }, { id: 'asc' }]
      : query.sort === 'employeeId'
        ? [{ employeeId: direction }, { id: 'asc' }]
        // `id` last in every case: cursor pagination needs a total order, and two
        // people genuinely share a surname.
        : [{ lastName: direction }, { firstName: direction }, { id: 'asc' }];

  const rows = await repo.listEmployees({
    where,
    take: query.limit,
    cursor: query.cursor,
    orderBy,
  });

  const page = rows.slice(0, query.limit);

  return {
    employees: page.map(toEmployeeRow),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getEmployee(actor: HrActor, id: string): Promise<EmployeeDetail> {
  const employee = await loadVisibleEmployee(actor, id);
  return toEmployeeDetail(employee, {
    includeDocuments: actor.can('HR_EMPLOYEE', 'VIEW'),
  });
}

export async function getEmployeeHistory(
  actor: HrActor,
  id: string,
): Promise<EmployeeHistoryEntry[]> {
  // Loaded through the scope check first, so history cannot be read for somebody
  // the caller may not see.
  await loadVisibleEmployee(actor, id);
  const rows = await repo.listHistory(id, HISTORY_PAGE);
  return rows.map(toHistoryEntry);
}

export async function overview(): Promise<HrOverview> {
  return repo.overviewCounts();
}

// ---------------------------------------------------------------------------
//  Employees — writes
// ---------------------------------------------------------------------------

export async function createEmployee(
  req: Request,
  actor: HrActor,
  input: CreateEmployeeInput,
): Promise<EmployeeDetail> {
  // Checked before the transaction so the caller gets a useful message rather than
  // a unique-constraint error, and again by the index so a race cannot slip past.
  const existing = await repo.findEmployeeByWorkEmail(input.workEmail);
  if (existing) {
    throw AppError.conflict(
      'WORK_EMAIL_TAKEN',
      'An employee with that work email already exists.',
    );
  }

  const departmentName = input.departmentId
    ? await assertDepartmentUsable(input.departmentId)
    : null;
  const designationName = input.designationId
    ? await assertDesignationUsable(input.designationId)
    : null;

  let managerName: string | null = null;
  if (input.managerId) {
    const manager = await repo.findEmployee(input.managerId);
    if (!manager) {
      throw AppError.badRequest('MANAGER_NOT_FOUND', 'That manager could not be found.');
    }
    // A departed employee cannot be given new reports. No cycle check is needed:
    // this employee does not exist yet, so it cannot be in anybody's chain.
    if (manager.status === 'EXITED') {
      throw AppError.badRequest(
        'MANAGER_NOT_EMPLOYED',
        'That person has left, so they cannot be set as a manager.',
      );
    }
    managerName = displayName(manager);
  }

  const id = await prisma.$transaction(async (tx) => {
    // Inside the transaction, so two simultaneous creates cannot receive the same
    // id — the counter's whole purpose.
    const employeeId = await repo.allocateEmployeeId(tx);

    const created = await repo.createEmployee(tx, {
      employeeId,
      firstName: input.firstName,
      middleName: input.middleName ?? null,
      lastName: input.lastName,
      workEmail: input.workEmail,
      phone: input.phone ?? null,
      departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null,
      managerId: input.managerId ?? null,
      employmentType: input.employmentType ?? 'FULL_TIME',
      workMode: input.workMode ?? 'ON_SITE',
      location: input.location ?? null,
      joiningDate: input.joiningDate,
      // Status is not accepted from the caller: a new record is ACTIVE, and
      // everything else goes through the status endpoint so it writes history.
      status: 'ACTIVE',
    });

    /*
      The joining entry, plus one per detail that was set at creation. Written in
      the same transaction as the employee: history that could commit without the
      change, or the reverse, would be a timeline that lies.
    */
    const rows: Prisma.EmployeeHistoryUncheckedCreateInput[] = [
      {
        employeeId: created.id,
        eventType: 'JOINED',
        toValue: employeeId,
        performedById: actor.id,
        effectiveAt: input.joiningDate,
      },
    ];
    if (departmentName) {
      rows.push({
        employeeId: created.id,
        eventType: 'DEPARTMENT_CHANGED',
        toValue: departmentName,
        performedById: actor.id,
      });
    }
    if (designationName) {
      rows.push({
        employeeId: created.id,
        eventType: 'DESIGNATION_CHANGED',
        toValue: designationName,
        performedById: actor.id,
      });
    }
    if (managerName) {
      rows.push({
        employeeId: created.id,
        eventType: 'MANAGER_CHANGED',
        toValue: managerName,
        performedById: actor.id,
      });
    }
    await repo.addHistory(tx, rows);

    return created.id;
  }, TX_OPTIONS);

  const employee = await repo.findEmployee(id);
  if (!employee) throw notFound();

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_CREATED',
    entityType: 'Employee',
    entityId: id,
    actorId: actor.id,
    // Identity and placement only. No personal contact detail, and there is no
    // salary, bank or tax field in Phase 1 to leak even by accident.
    newValue: {
      employeeId: employee.employeeId,
      departmentId: employee.department?.id ?? null,
      designationId: employee.designation?.id ?? null,
      status: employee.status,
    },
  });

  // After commit: a notice about a change that then rolled back is worse than none.
  await notifyManagerOfReport(employee.managerId, id);

  return toEmployeeDetail(employee, { includeDocuments: true });
}

export async function updateEmployee(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateEmployeeInput,
): Promise<EmployeeDetail> {
  const before = await repo.findEmployee(id);
  if (!before) throw notFound();

  if (input.workEmail && input.workEmail !== before.workEmail) {
    const clash = await repo.findEmployeeByWorkEmail(input.workEmail);
    if (clash && clash.id !== id) {
      throw AppError.conflict(
        'WORK_EMAIL_TAKEN',
        'An employee with that work email already exists.',
      );
    }
  }

  const departmentName =
    input.departmentId === undefined || input.departmentId === null
      ? null
      : await assertDepartmentUsable(input.departmentId);
  const designationName =
    input.designationId === undefined || input.designationId === null
      ? null
      : await assertDesignationUsable(input.designationId);

  await prisma.$transaction(async (tx) => {
    await repo.updateEmployee(tx, id, {
      ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
      ...(input.middleName === undefined ? {} : { middleName: input.middleName }),
      ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
      ...(input.workEmail === undefined ? {} : { workEmail: input.workEmail }),
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
      ...(input.designationId === undefined ? {} : { designationId: input.designationId }),
      ...(input.employmentType === undefined ? {} : { employmentType: input.employmentType }),
      ...(input.workMode === undefined ? {} : { workMode: input.workMode }),
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.joiningDate === undefined ? {} : { joiningDate: input.joiningDate }),
    });

    /*
      Only the changes that are events in somebody's employment. A corrected phone
      number or spelling is not one, and recording it would bury the transfers and
      promotions somebody actually scans this timeline for.
    */
    const rows: Prisma.EmployeeHistoryUncheckedCreateInput[] = [];
    if (input.departmentId !== undefined && input.departmentId !== before.department?.id) {
      rows.push({
        employeeId: id,
        eventType: 'DEPARTMENT_CHANGED',
        fromValue: before.department?.name ?? null,
        toValue: departmentName,
        performedById: actor.id,
      });
    }
    if (input.designationId !== undefined && input.designationId !== before.designation?.id) {
      rows.push({
        employeeId: id,
        eventType: 'DESIGNATION_CHANGED',
        fromValue: before.designation?.name ?? null,
        toValue: designationName,
        performedById: actor.id,
      });
    }
    if (input.employmentType !== undefined && input.employmentType !== before.employmentType) {
      rows.push({
        employeeId: id,
        eventType: 'EMPLOYMENT_TYPE_CHANGED',
        fromValue: before.employmentType,
        toValue: input.employmentType,
        performedById: actor.id,
      });
    }
    if (input.workMode !== undefined && input.workMode !== before.workMode) {
      rows.push({
        employeeId: id,
        eventType: 'WORK_MODE_CHANGED',
        fromValue: before.workMode,
        toValue: input.workMode,
        performedById: actor.id,
      });
    }
    if (rows.length) await repo.addHistory(tx, rows);
  }, TX_OPTIONS);

  const after = await repo.findEmployee(id);
  if (!after) throw notFound();

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_UPDATED',
    entityType: 'Employee',
    entityId: id,
    actorId: actor.id,
    oldValue: auditShape(before),
    newValue: auditShape(after),
  });

  return toEmployeeDetail(after, { includeDocuments: true });
}

/**
 * What an employee change records in the audit trail.
 *
 * Structural facts only: placement, employment terms, status. Deliberately no
 * contact details and no name — the audit trail answers "who moved this person
 * where", and a log that accumulates personal data becomes its own disclosure
 * risk. Phase 1 holds no salary, bank or tax field to exclude.
 */
function auditShape(row: repo.EmployeeDetailRecord): Record<string, unknown> {
  return {
    departmentId: row.department?.id ?? null,
    designationId: row.designation?.id ?? null,
    managerId: row.managerId,
    employmentType: row.employmentType,
    workMode: row.workMode,
    status: row.status,
    location: row.location,
  };
}

/**
 * Moves somebody's reporting line.
 *
 * The cycle check is the reason this is its own operation. `managerAncestors`
 * walks the proposed manager's chain in one recursive query; if this employee
 * appears in it, the assignment would close a loop and make the hierarchy
 * unwalkable. The database can only refuse the trivial self-reference case, so the
 * rest is decided here — in a pure function, against a list the repository
 * fetched, so it is testable without a database.
 */
export async function assignManager(
  req: Request,
  actor: HrActor,
  id: string,
  input: AssignManagerInput,
): Promise<EmployeeDetail> {
  const before = await repo.findEmployee(id);
  if (!before) throw notFound();

  let managerName: string | null = null;

  if (input.managerId !== null) {
    const manager = await repo.findEmployee(input.managerId);
    if (!manager) {
      throw AppError.badRequest('MANAGER_NOT_FOUND', 'That manager could not be found.');
    }
    if (manager.status === 'EXITED') {
      throw AppError.badRequest(
        'MANAGER_NOT_EMPLOYED',
        'That person has left, so they cannot be set as a manager.',
      );
    }

    const ancestors = await repo.managerAncestors(prisma, input.managerId);
    const error = managerAssignmentError(id, input.managerId, ancestors);
    if (error) throw AppError.badRequest('INVALID_MANAGER', error);

    managerName = displayName(manager);
  }

  if (before.managerId === input.managerId) {
    // Nothing to do, and writing a history row saying "changed from X to X" would
    // be noise in the one place that must stay signal.
    return toEmployeeDetail(before, { includeDocuments: true });
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateEmployee(tx, id, { managerId: input.managerId });
    await repo.addHistory(tx, [
      {
        employeeId: id,
        eventType: 'MANAGER_CHANGED',
        fromValue: before.manager ? displayName(before.manager) : null,
        toValue: managerName,
        note: input.note ?? null,
        performedById: actor.id,
      },
    ]);
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_MANAGER_CHANGED',
    entityType: 'Employee',
    entityId: id,
    actorId: actor.id,
    oldValue: { managerId: before.managerId },
    newValue: { managerId: input.managerId },
  });

  await notifyManagerOfReport(input.managerId, id);

  const after = await repo.findEmployee(id);
  if (!after) throw notFound();
  return toEmployeeDetail(after, { includeDocuments: true });
}

/**
 * Changes employment status.
 *
 * `exitDate` is written only for EXITED and cleared otherwise, so the stored date
 * can never contradict the stored status — the same pairing the
 * employee_exit_date_matches_status CHECK enforces at the database level.
 */
export async function changeStatus(
  req: Request,
  actor: HrActor,
  id: string,
  input: ChangeEmployeeStatusInput,
): Promise<EmployeeDetail> {
  const before = await repo.findEmployee(id);
  if (!before) throw notFound();

  if (before.status === input.status) {
    throw AppError.badRequest(
      'STATUS_UNCHANGED',
      `That employee is already ${input.status.toLowerCase().replace(/_/g, ' ')}.`,
    );
  }

  if (input.status === 'EXITED' && input.exitDate && input.exitDate < before.joiningDate) {
    throw AppError.badRequest(
      'EXIT_BEFORE_JOINING',
      'The last working day cannot be before the joining date.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateEmployee(tx, id, {
      status: input.status,
      exitDate: input.status === 'EXITED' ? (input.exitDate ?? null) : null,
    });
    await repo.addHistory(tx, [
      {
        employeeId: id,
        eventType: 'STATUS_CHANGED',
        fromValue: before.status,
        toValue: input.status,
        note: input.note ?? null,
        performedById: actor.id,
        ...(input.status === 'EXITED' && input.exitDate ? { effectiveAt: input.exitDate } : {}),
      },
    ]);
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_STATUS_CHANGED',
    entityType: 'Employee',
    entityId: id,
    actorId: actor.id,
    oldValue: { status: before.status, exitDate: iso(before.exitDate) },
    newValue: { status: input.status, exitDate: input.exitDate?.toISOString() ?? null },
  });

  /*
    The manager is told, because somebody they manage leaving or going on notice
    changes what they can plan. Only for an employed manager with an account —
    there is nobody to notify otherwise.
  */
  if (before.managerId) {
    const manager = await repo.findEmployee(before.managerId);
    if (manager?.user?.id && manager.user.isActive) {
      await notifications.notifyHrEmployeeStatusChanged(manager.user.id, id);
    }
  }

  const after = await repo.findEmployee(id);
  if (!after) throw notFound();
  return toEmployeeDetail(after, { includeDocuments: true });
}

// ---------------------------------------------------------------------------
//  User account linking
// ---------------------------------------------------------------------------

/**
 * Ties a CRM account to an HR record.
 *
 * Four things are checked, and the third and fourth are the ones that matter:
 *
 *   1. The account exists.
 *   2. This employee has no account already.
 *   3. That account is not already another employee's — enforced by the unique
 *      index as well, so a race cannot produce two HR records for one login.
 *   4. The employee has not left.
 *
 * What this deliberately does NOT do: create an account, set a password, grant a
 * permission, or change the User row in any way. Creating logins is user
 * management's job and goes through its own audited endpoint. Linking records a
 * correspondence between two rows that already exist.
 */
export async function linkUser(
  req: Request,
  actor: HrActor,
  id: string,
  input: LinkEmployeeUserInput,
): Promise<EmployeeDetail> {
  const employee = await repo.findEmployee(id);
  if (!employee) throw notFound();

  if (employee.user) {
    throw AppError.conflict(
      'EMPLOYEE_ALREADY_LINKED',
      'That employee already has an account linked. Unlink it first.',
    );
  }
  if (employee.status === 'EXITED') {
    throw AppError.badRequest(
      'EMPLOYEE_NOT_EMPLOYED',
      'That employee has left, so an account cannot be linked.',
    );
  }

  const account = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, name: true, isActive: true },
  });
  if (!account) {
    throw AppError.badRequest('USER_NOT_FOUND', 'That user account could not be found.');
  }

  const alreadyLinked = await repo.findEmployeeByUserId(input.userId);
  if (alreadyLinked) {
    throw AppError.conflict(
      'USER_ALREADY_LINKED',
      'That account is already linked to another employee.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateEmployee(tx, id, { userId: input.userId });
    await repo.addHistory(tx, [
      {
        employeeId: id,
        eventType: 'USER_LINKED',
        toValue: account.name,
        note: input.note ?? null,
        performedById: actor.id,
      },
    ]);
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_USER_LINKED',
    entityType: 'Employee',
    entityId: id,
    actorId: actor.id,
    // The account id, never its email, role or any credential.
    newValue: { userId: input.userId },
  });

  if (account.isActive) {
    await notifications.notifyHrEmployeeAccountLinked(input.userId, id);
  }

  const after = await repo.findEmployee(id);
  if (!after) throw notFound();
  return toEmployeeDetail(after, { includeDocuments: true });
}

/**
 * Breaks the link.
 *
 * The HR record and the account both survive — this clears a correspondence, and
 * is how a mistaken link is corrected. The account keeps every permission it had;
 * revoking access is user management's job, and doing it here would make "fix a
 * data-entry error" silently also mean "remove somebody's CRM access".
 */
export async function unlinkUser(
  req: Request,
  actor: HrActor,
  id: string,
  note?: string,
): Promise<EmployeeDetail> {
  const employee = await repo.findEmployee(id);
  if (!employee) throw notFound();
  if (!employee.user) {
    throw AppError.badRequest(
      'EMPLOYEE_NOT_LINKED',
      'That employee has no account linked.',
    );
  }

  const previousName = employee.user.name;

  await prisma.$transaction(async (tx) => {
    await repo.updateEmployee(tx, id, { userId: null });
    await repo.addHistory(tx, [
      {
        employeeId: id,
        eventType: 'USER_UNLINKED',
        fromValue: previousName,
        note: note ?? null,
        performedById: actor.id,
      },
    ]);
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_USER_UNLINKED',
    entityType: 'Employee',
    entityId: id,
    actorId: actor.id,
    oldValue: { userId: employee.user.id },
  });

  const after = await repo.findEmployee(id);
  if (!after) throw notFound();
  return toEmployeeDetail(after, { includeDocuments: true });
}

// ---------------------------------------------------------------------------
//  Departments
// ---------------------------------------------------------------------------

export async function listDepartments(query: DepartmentListQuery): Promise<DepartmentPage> {
  const where: Prisma.DepartmentWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.parentId ? { parentId: query.parentId } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' as const } },
            { code: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const rows = await repo.listDepartments({ where, take: query.limit, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  return {
    departments: page.map(toDepartmentView),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getDepartment(id: string): Promise<DepartmentView> {
  const department = await repo.findDepartment(id);
  if (!department) {
    throw AppError.notFound('DEPARTMENT_NOT_FOUND', 'That department could not be found.');
  }
  return toDepartmentView(department);
}

export async function createDepartment(
  req: Request,
  actor: HrActor,
  input: CreateDepartmentInput,
): Promise<DepartmentView> {
  // The code is uppercased by the schema, so this catches "eng" against "ENG"
  // rather than letting two departments exist that read as one.
  const clash = await repo.findDepartmentByCode(input.code);
  if (clash) {
    throw AppError.conflict('DEPARTMENT_CODE_TAKEN', 'A department with that code already exists.');
  }

  if (input.parentId) await assertDepartmentUsable(input.parentId);
  if (input.headId) {
    const head = await repo.findEmployeeScope(input.headId);
    if (!head) throw AppError.badRequest('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
  }

  const created = await repo.createDepartment({
    name: input.name,
    code: input.code,
    description: input.description ?? null,
    parentId: input.parentId ?? null,
    headId: input.headId ?? null,
  });

  await recordAudit(req, {
    action: 'HR_DEPARTMENT_CREATED',
    entityType: 'Department',
    entityId: created.id,
    actorId: actor.id,
    newValue: { name: input.name, code: input.code, parentId: input.parentId ?? null },
  });

  return getDepartment(created.id);
}

export async function updateDepartment(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateDepartmentInput,
): Promise<DepartmentView> {
  const before = await repo.findDepartment(id);
  if (!before) {
    throw AppError.notFound('DEPARTMENT_NOT_FOUND', 'That department could not be found.');
  }

  if (input.parentId) {
    if (input.parentId === id) {
      throw AppError.badRequest('INVALID_PARENT', 'A department cannot be its own parent.');
    }
    await assertDepartmentUsable(input.parentId);

    /*
      The same cycle problem as the manager hierarchy: making A the child of its own
      descendant makes the tree unwalkable. One recursive query up from the proposed
      parent answers it.
    */
    const ancestors = await repo.departmentAncestors(prisma, input.parentId);
    if (ancestors.includes(id)) {
      throw AppError.badRequest(
        'INVALID_PARENT',
        'That would create a loop: the chosen parent already sits under this department.',
      );
    }
  }

  if (input.headId) {
    const head = await repo.findEmployeeScope(input.headId);
    if (!head) throw AppError.badRequest('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
  }

  await repo.updateDepartment(id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.headId === undefined ? {} : { headId: input.headId }),
  });

  await recordAudit(req, {
    action: 'HR_DEPARTMENT_UPDATED',
    entityType: 'Department',
    entityId: id,
    actorId: actor.id,
    oldValue: { name: before.name, status: before.status, parentId: before.parent?.id ?? null },
    newValue: { name: input.name ?? before.name, status: input.status ?? before.status },
  });

  return getDepartment(id);
}

// ---------------------------------------------------------------------------
//  Designations
// ---------------------------------------------------------------------------

export async function listDesignations(query: DesignationListQuery): Promise<DesignationPage> {
  const where: Prisma.DesignationWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' as const } },
            { code: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const rows = await repo.listDesignations({ where, take: query.limit, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  return {
    designations: page.map(toDesignationView),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getDesignation(id: string): Promise<DesignationView> {
  const designation = await repo.findDesignation(id);
  if (!designation) {
    throw AppError.notFound('DESIGNATION_NOT_FOUND', 'That designation could not be found.');
  }
  return toDesignationView(designation);
}

export async function createDesignation(
  req: Request,
  actor: HrActor,
  input: CreateDesignationInput,
): Promise<DesignationView> {
  const clash = await repo.findDesignationByCode(input.code);
  if (clash) {
    throw AppError.conflict(
      'DESIGNATION_CODE_TAKEN',
      'A designation with that code already exists.',
    );
  }

  if (input.departmentId) await assertDepartmentUsable(input.departmentId);

  const created = await repo.createDesignation({
    name: input.name,
    code: input.code,
    description: input.description ?? null,
    departmentId: input.departmentId ?? null,
    level: input.level ?? 0,
  });

  await recordAudit(req, {
    action: 'HR_DESIGNATION_CREATED',
    entityType: 'Designation',
    entityId: created.id,
    actorId: actor.id,
    newValue: { name: input.name, code: input.code, level: input.level ?? 0 },
  });

  return getDesignation(created.id);
}

export async function updateDesignation(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateDesignationInput,
): Promise<DesignationView> {
  const before = await repo.findDesignation(id);
  if (!before) {
    throw AppError.notFound('DESIGNATION_NOT_FOUND', 'That designation could not be found.');
  }

  if (input.departmentId) await assertDepartmentUsable(input.departmentId);

  await repo.updateDesignation(id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
    ...(input.level === undefined ? {} : { level: input.level }),
  });

  await recordAudit(req, {
    action: 'HR_DESIGNATION_UPDATED',
    entityType: 'Designation',
    entityId: id,
    actorId: actor.id,
    oldValue: { name: before.name, status: before.status, level: before.level },
    newValue: { name: input.name ?? before.name, status: input.status ?? before.status },
  });

  return getDesignation(id);
}

// ---------------------------------------------------------------------------
//  Documents
// ---------------------------------------------------------------------------

/**
 * Records an already-stored confidential file against an employee.
 *
 * The bytes went through the Phase 0.5 secure-document service, which stores them
 * as authenticated Cloudinary objects with no public URL. This adds only the HR
 * metadata. The ownership check is the important part: a caller must not be able to
 * attach somebody else's stored document — or a document owned by a User — to an
 * employee record and thereby read it through this module.
 */
export async function addDocument(
  req: Request,
  actor: HrActor,
  employeeId: string,
  input: CreateEmployeeDocumentInput,
): Promise<EmployeeDocumentView[]> {
  const employee = await repo.findEmployee(employeeId);
  if (!employee) throw notFound();

  const stored = await repo.findSecureDocumentForEmployee(input.secureDocumentId);
  if (!stored) {
    throw AppError.badRequest('DOCUMENT_NOT_FOUND', 'That stored document could not be found.');
  }

  /*
    The file must already belong to this employee. Phase 0.5 records ownership as
    ownerType/ownerId, and the upload endpoint sets it; accepting a document owned
    by anybody else would turn this endpoint into a way to read arbitrary stored
    files through an employee profile.
  */
  if (stored.ownerType !== 'Employee' || stored.ownerId !== employeeId) {
    throw AppError.badRequest(
      'DOCUMENT_OWNER_MISMATCH',
      'That document was not stored against this employee.',
    );
  }

  const created = await repo.createEmployeeDocument({
    employeeId,
    secureDocumentId: input.secureDocumentId,
    documentType: input.documentType,
    title: input.title,
    issuedOn: input.issuedOn ?? null,
    expiresOn: input.expiresOn ?? null,
    uploadedById: actor.id,
  });

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_DOCUMENT_ADDED',
    entityType: 'EmployeeDocument',
    entityId: created.id,
    actorId: actor.id,
    // What kind of document, never its contents and never a link to them.
    newValue: { employeeId, documentType: input.documentType, title: input.title },
  });

  const after = await repo.findEmployee(employeeId);
  return after ? after.documents.map(toDocumentView) : [];
}

/** Records that somebody checked a document against its original. */
export async function verifyDocument(
  req: Request,
  actor: HrActor,
  employeeId: string,
  documentId: string,
  input: VerifyEmployeeDocumentInput,
): Promise<EmployeeDocumentView[]> {
  const document = await repo.findEmployeeDocument(documentId);
  if (!document || document.employeeId !== employeeId) {
    throw AppError.notFound('DOCUMENT_NOT_FOUND', 'That document could not be found.');
  }

  const decided = input.verificationStatus !== 'PENDING';

  await repo.updateEmployeeDocument(documentId, {
    verificationStatus: input.verificationStatus,
    // Written together with the status, satisfying the
    // employee_document_verification_consistency CHECK: a decided document always
    // names who decided and when, and a pending one never does.
    verifiedById: decided ? actor.id : null,
    verifiedAt: decided ? new Date() : null,
  });

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_DOCUMENT_VERIFIED',
    entityType: 'EmployeeDocument',
    entityId: documentId,
    actorId: actor.id,
    oldValue: { verificationStatus: document.verificationStatus },
    newValue: { verificationStatus: input.verificationStatus },
  });

  const after = await repo.findEmployee(employeeId);
  return after ? after.documents.map(toDocumentView) : [];
}

/**
 * Mints a short-lived signed link to one stored document.
 *
 * The link is created per request, after the caller's permission has been
 * resolved, and expires. That is the entire reason SecureDocument stores no URL:
 * a stored link outlives every access check and cannot be revoked.
 */
export async function documentLink(
  req: Request,
  actor: HrActor,
  employeeId: string,
  documentId: string,
): Promise<EmployeeDocumentLink> {
  const document = await repo.findEmployeeDocument(documentId);
  if (!document || document.employeeId !== employeeId) {
    throw AppError.notFound('DOCUMENT_NOT_FOUND', 'That document could not be found.');
  }

  const { url, expiresAt } = signedUrlFor({
    publicId: document.secureDocument.publicId,
    mimeType: document.secureDocument.mimeType,
  });

  /*
    Audited as an access event, not merely as a change. Reading somebody's identity
    proof is exactly the thing an HR audit needs to show afterwards, and the link
    itself is deliberately not recorded — logging it would put a working credential
    into the audit table.
  */
  await recordAudit(req, {
    action: 'HR_EMPLOYEE_DOCUMENT_ACCESSED',
    entityType: 'EmployeeDocument',
    entityId: documentId,
    actorId: actor.id,
    newValue: { employeeId, documentType: document.documentType },
  });

  return { url, expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
//  Notification helpers
// ---------------------------------------------------------------------------

/** Tells a manager they have gained a report, where there is somebody to tell. */
async function notifyManagerOfReport(
  managerId: string | null,
  employeeId: string,
): Promise<void> {
  if (!managerId) return;
  const manager = await repo.findEmployee(managerId);
  // Only an employed manager with an active account: there is nobody to notify
  // otherwise, and a notice addressed to a disabled login is never read.
  if (!manager?.user?.id || !manager.user.isActive) return;
  await notifications.notifyHrEmployeeAssignedToManager(manager.user.id, employeeId);
}
