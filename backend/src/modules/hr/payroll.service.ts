/**
 * Compensation configuration: salary components, structures and assignments.
 *
 * Payroll *processing* lives in `payroll-run.service.ts`. The split follows
 * Phase 5's `performance.service.ts` / `performance-review.service.ts`: one file
 * for the configuration that exists before any run, one for the run itself.
 *
 * ### Authorization happens here, not in the route table alone
 *
 * The route table decides whether somebody may reach an endpoint. This file
 * decides whether they may perform the action on *this* record — which the route
 * table cannot know, because the answer depends on whose salary it is.
 *
 * `payroll-access.ts` holds those rules as pure functions and this file calls
 * them. Where the rule involves the subject — assigning a salary, recording an
 * adjustment — the subject is refused **first**, before any permission is
 * consulted. An HR administrator who is also an employee holds ASSIGN, and
 * checking the grant first would let them give themselves a raise.
 *
 * ### Append-only assignments
 *
 * `assignSalary` never updates an existing row. It inserts a new one with a
 * later `effectiveFrom` and closes the previous one's `effectiveTo`, in one
 * transaction. That is what keeps a payslip from eight months ago explicable:
 * the assignment that produced it is still there, unmodified.
 *
 * ### No statutory anything
 *
 * A component's rate, cap and floor are whatever the business configured. This
 * file validates that they are internally coherent — a percentage component has
 * a percentage, the base is a fixed earning — and holds no opinion about what
 * any figure should be. See `PAYROLL-SCOPE.md`.
 */

import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_PAYROLL_CURRENCY,
  type AssignEmployeeSalaryInput,
  type CreateSalaryComponentInput,
  type CreateSalaryStructureInput,
  type EmployeeSalaryView,
  type SalaryComponentListQuery,
  type SalaryComponentView,
  type SalaryStructureView,
  type UpdateSalaryComponentInput,
  type UpdateSalaryStructureInput,
} from '@rs/shared';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import * as repo from './payroll.repository.js';
import { TX_OPTIONS } from './payroll.repository.js';
import type { HrActor } from './hr-access.js';
import {
  mayAssignSalary,
  mayEditCompensationConfig,
  mayManageCompensationConfig,
  mayReadSalaryHistory,
  mayViewCompensationConfig,
} from './payroll-access.js';

const notFound = (): AppError =>
  new AppError('NOT_FOUND', 404, 'That record could not be found.');

const decimalToString = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed(2);

const dateToIso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

// ---------------------------------------------------------------------------
//  Presenters
// ---------------------------------------------------------------------------

type ComponentRow = Prisma.SalaryComponentGetPayload<{ select: typeof repo.componentSelect }>;

function presentComponent(row: ComponentRow): SalaryComponentView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    calculation: row.calculation,
    rate: decimalToString(row.rate),
    capAmount: decimalToString(row.capAmount),
    floorAmount: decimalToString(row.floorAmount),
    isBase: row.isBase,
    prorates: row.prorates,
    isTaxable: row.isTaxable,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type StructureRow = Prisma.SalaryStructureGetPayload<{ select: typeof repo.structureSelect }>;

function presentStructure(row: StructureRow): SalaryStructureView {
  const fixedEarnings = row.components.filter(
    (c) => c.component.kind === 'EARNING' && c.component.calculation === 'FIXED',
  );
  // An indicative figure only, and null when the structure is rate-only: summing
  // rate-based components without a base would produce a number that is not the
  // gross and would be read as one.
  const indicativeGross =
    fixedEarnings.length > 0
      ? fixedEarnings
          .reduce((acc, c) => acc.add(c.amount ?? new Prisma.Decimal(0)), new Prisma.Decimal(0))
          .toFixed(2)
      : null;

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    currency: row.currency,
    isActive: row.isActive,
    components: row.components.map((c) => ({
      id: c.id,
      component: presentComponent(c.component),
      amount: decimalToString(c.amount),
      rateOverride: decimalToString(c.rateOverride),
      displayOrder: c.displayOrder,
    })),
    indicativeGross,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type SalaryRow = Prisma.EmployeeSalaryGetPayload<{ select: typeof repo.salarySelect }>;

function presentSalary(row: SalaryRow, today: Date): EmployeeSalaryView {
  const started = row.effectiveFrom <= today;
  const notEnded = row.effectiveTo === null || row.effectiveTo >= today;
  return {
    id: row.id,
    employee: {
      id: row.employee.id,
      employeeId: row.employee.employeeId,
      displayName: `${row.employee.firstName} ${row.employee.lastName}`.trim(),
      departmentName: row.employee.department?.name ?? null,
      designationName: row.employee.designation?.name ?? null,
    },
    structure: row.structure ? presentStructure(row.structure) : null,
    monthlyGross: row.monthlyGross.toFixed(2),
    currency: row.currency,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: dateToIso(row.effectiveTo),
    overrides: row.overrides.map((o) => ({
      id: o.id,
      component: presentComponent(o.component),
      amount: decimalToString(o.amount),
      rateOverride: decimalToString(o.rateOverride),
    })),
    notes: row.notes,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    createdAt: row.createdAt.toISOString(),
    isCurrent: started && notEnded,
  };
}

// ---------------------------------------------------------------------------
//  Salary components
// ---------------------------------------------------------------------------

export async function listComponents(
  actor: HrActor,
  query: SalaryComponentListQuery,
): Promise<{ components: SalaryComponentView[] }> {
  if (!mayViewCompensationConfig(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Reading salary components needs payroll access.');
  }
  const rows = await repo.listComponents({
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.includeInactive ? {} : { isActive: true }),
  });
  return { components: rows.map(presentComponent) };
}

export async function createComponent(
  req: Request,
  actor: HrActor,
  input: CreateSalaryComponentInput,
): Promise<SalaryComponentView> {
  if (!mayManageCompensationConfig(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Creating a salary component needs payroll create rights.');
  }

  const existing = await repo.findComponentByCode(input.code);
  if (existing) {
    throw new AppError('CONFLICT', 409, `A component with the code ${input.code} already exists.`);
  }

  const row = await repo.createComponent({
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    calculation: input.calculation,
    rate: input.rate ?? null,
    capAmount: input.capAmount ?? null,
    floorAmount: input.floorAmount ?? null,
    isBase: input.isBase,
    prorates: input.prorates,
    isTaxable: input.isTaxable,
    displayOrder: input.displayOrder,
    createdById: actor.id,
  });

  await recordAudit(req, {
    action: 'PAYROLL_COMPONENT_CREATED',
    entityType: 'SalaryComponent',
    entityId: row.id,
    actorId: actor.id,
    newValue: { code: row.code, kind: row.kind, calculation: row.calculation },
  });

  return presentComponent(row);
}

export async function updateComponent(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateSalaryComponentInput,
): Promise<SalaryComponentView> {
  if (!mayEditCompensationConfig(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Editing a salary component needs payroll edit rights.');
  }

  const before = await repo.findComponent(id);
  if (!before) throw notFound();

  if (input.code && input.code !== before.code) {
    const clash = await repo.findComponentByCode(input.code);
    if (clash) {
      throw new AppError('CONFLICT', 409, `A component with the code ${input.code} already exists.`);
    }
  }

  const row = await repo.updateComponent(id, {
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.calculation !== undefined ? { calculation: input.calculation } : {}),
    ...(input.rate !== undefined ? { rate: input.rate } : {}),
    ...(input.capAmount !== undefined ? { capAmount: input.capAmount } : {}),
    ...(input.floorAmount !== undefined ? { floorAmount: input.floorAmount } : {}),
    ...(input.isBase !== undefined ? { isBase: input.isBase } : {}),
    ...(input.prorates !== undefined ? { prorates: input.prorates } : {}),
    ...(input.isTaxable !== undefined ? { isTaxable: input.isTaxable } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
  });

  await recordAudit(req, {
    action: 'PAYROLL_COMPONENT_UPDATED',
    entityType: 'SalaryComponent',
    entityId: id,
    actorId: actor.id,
    oldValue: {
      code: before.code,
      rate: decimalToString(before.rate),
      capAmount: decimalToString(before.capAmount),
      isActive: before.isActive,
    },
    newValue: {
      code: row.code,
      rate: decimalToString(row.rate),
      capAmount: decimalToString(row.capAmount),
      isActive: row.isActive,
    },
  });

  return presentComponent(row);
}

/**
 * Deletes a component, but only one nothing references.
 *
 * A component in use is deactivated rather than removed: a historical payslip
 * line names it, and the snapshot explaining that line is keyed on its code.
 */
export async function deleteComponent(req: Request, actor: HrActor, id: string): Promise<void> {
  if (!mayEditCompensationConfig(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Removing a salary component needs payroll edit rights.');
  }
  const before = await repo.findComponent(id);
  if (!before) throw notFound();

  const usage = await repo.componentUsage(id);
  if (usage > 0) {
    throw new AppError(
      'CONFLICT',
      409,
      `${before.code} is used by ${usage} structure or employee record${usage === 1 ? '' : 's'}. Deactivate it instead, so historical payslips keep their meaning.`,
    );
  }

  await repo.deleteComponent(id);
  await recordAudit(req, {
    action: 'PAYROLL_COMPONENT_DELETED',
    entityType: 'SalaryComponent',
    entityId: id,
    actorId: actor.id,
    oldValue: { code: before.code, kind: before.kind },
  });
}

// ---------------------------------------------------------------------------
//  Salary structures
// ---------------------------------------------------------------------------

export async function listStructures(
  actor: HrActor,
  query: { cursor?: string; limit: number },
): Promise<{ structures: SalaryStructureView[]; nextCursor: string | null }> {
  if (!mayViewCompensationConfig(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Reading salary structures needs payroll access.');
  }
  const rows = await repo.listStructures({
    where: {},
    take: query.limit + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  const page = rows.slice(0, query.limit);
  return {
    structures: page.map(presentStructure),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getStructure(actor: HrActor, id: string): Promise<SalaryStructureView> {
  if (!mayViewCompensationConfig(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Reading a salary structure needs payroll access.');
  }
  const row = await repo.findStructure(id);
  if (!row) throw notFound();
  return presentStructure(row);
}

export async function createStructure(
  req: Request,
  actor: HrActor,
  input: CreateSalaryStructureInput,
): Promise<SalaryStructureView> {
  if (!mayManageCompensationConfig(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Creating a salary structure needs payroll create rights.');
  }

  const clash = await repo.findStructureByCode(input.code);
  if (clash) {
    throw new AppError('CONFLICT', 409, `A structure with the code ${input.code} already exists.`);
  }

  await assertComponentsExistAndCohere(input.components.map((c) => c.componentId));

  const id = await repo.prisma.$transaction(async (tx) => {
    const created = await repo.createStructure(tx, {
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      currency: input.currency ?? DEFAULT_PAYROLL_CURRENCY,
      createdById: actor.id,
    });
    await repo.addStructureComponents(
      tx,
      input.components.map((c) => ({
        structureId: created.id,
        componentId: c.componentId,
        amount: c.amount ?? null,
        rateOverride: c.rateOverride ?? null,
        displayOrder: c.displayOrder,
      })),
    );
    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'PAYROLL_STRUCTURE_CREATED',
    entityType: 'SalaryStructure',
    entityId: id,
    actorId: actor.id,
    newValue: { code: input.code, componentCount: input.components.length },
  });

  const row = await repo.findStructure(id);
  if (!row) throw notFound();
  return presentStructure(row);
}

export async function updateStructure(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateSalaryStructureInput,
): Promise<SalaryStructureView> {
  if (!mayEditCompensationConfig(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Editing a salary structure needs payroll edit rights.');
  }

  const before = await repo.findStructure(id);
  if (!before) throw notFound();

  if (input.components) {
    await assertComponentsExistAndCohere(input.components.map((c) => c.componentId));
    /*
      Replacing the component set of a structure that is already assigned would
      silently restate what those employees earn. Refused: a changed structure is
      a new structure, and reassigning employees to it is a deliberate act with
      its own effective date.
    */
    const assigned = await repo.structureAssignmentCount(id);
    if (assigned > 0) {
      throw new AppError(
        'CONFLICT',
        409,
        `${before.code} is assigned to ${assigned} employee${assigned === 1 ? '' : 's'}. Create a new structure and reassign them from a chosen date, so their pay history stays accurate.`,
      );
    }
  }

  await repo.prisma.$transaction(async (tx) => {
    await repo.updateStructure(tx, id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    });
    if (input.components) {
      await repo.clearStructureComponents(tx, id);
      await repo.addStructureComponents(
        tx,
        input.components.map((c) => ({
          structureId: id,
          componentId: c.componentId,
          amount: c.amount ?? null,
          rateOverride: c.rateOverride ?? null,
          displayOrder: c.displayOrder,
        })),
      );
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'PAYROLL_STRUCTURE_UPDATED',
    entityType: 'SalaryStructure',
    entityId: id,
    actorId: actor.id,
    oldValue: { name: before.name, isActive: before.isActive },
    newValue: { name: input.name ?? before.name, isActive: input.isActive ?? before.isActive },
  });

  const row = await repo.findStructure(id);
  if (!row) throw notFound();
  return presentStructure(row);
}

/**
 * Checks that every named component exists, and that the set can be evaluated.
 *
 * The coherence rules — at most one base, at most one balance, percentages have
 * a base to take a percentage of — are properties of the *set* rather than of
 * any row, which is why no CHECK constraint can express them and why they live
 * here.
 */
async function assertComponentsExistAndCohere(componentIds: readonly string[]): Promise<void> {
  const found = await Promise.all(componentIds.map((cid) => repo.findComponent(cid)));
  const missing = componentIds.filter((_, index) => found[index] == null);
  if (missing.length > 0) {
    throw new AppError('VALIDATION_ERROR', 400, `Unknown salary component: ${missing.join(', ')}`);
  }

  const rows = found.filter((r): r is NonNullable<typeof r> => r != null);
  const bases = rows.filter((r) => r.isBase);
  if (bases.length > 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `More than one base component (${bases.map((b) => b.code).join(', ')}). Percentages of the base would be ambiguous.`,
    );
  }
  const needsBase = rows.filter((r) => r.calculation === 'PERCENT_OF_BASE');
  if (needsBase.length > 0 && bases.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `${needsBase.map((r) => r.code).join(', ')} are percentages of the base, but no component in this structure is the base.`,
    );
  }
  const balances = rows.filter((r) => r.calculation === 'FORMULA_BALANCE');
  if (balances.length > 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `More than one balancing component (${balances.map((b) => b.code).join(', ')}). Only one figure can absorb the remainder.`,
    );
  }
}

// ---------------------------------------------------------------------------
//  Employee salary assignment
// ---------------------------------------------------------------------------

export async function listSalaries(
  actor: HrActor,
  query: { employeeId?: string; includeHistory: boolean },
): Promise<{ assignments: EmployeeSalaryView[] }> {
  /*
    An employee reads their own salary history with no payroll grant. Everybody
    is paid, so requiring a grant would mean granting the module to the whole
    company and the grant would stop meaning anything.
  */
  const target = query.employeeId ?? actor.employeeId;
  if (!target) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Your account is not linked to an employee record, so there is no salary to read.',
    );
  }
  if (!mayReadSalaryHistory(actor, target)) {
    // 404 rather than 403: "you may not read employee X's salary" confirms that X
    // is paid and roughly what band they are in.
    throw notFound();
  }

  const rows = await repo.listSalaries({
    employeeId: target,
    ...(query.includeHistory ? {} : { effectiveTo: null }),
  });
  const today = new Date();
  return { assignments: rows.map((r) => presentSalary(r, today)) };
}

/**
 * Assigns a salary, effective from a date.
 *
 * **Append-only.** Inserts a new row and closes the previous one in a single
 * transaction, so there is no moment at which an employee has two open
 * assignments or none.
 *
 * The subject is refused first: somebody cannot set their own salary, whatever
 * grants they hold.
 */
export async function assignSalary(
  req: Request,
  actor: HrActor,
  input: AssignEmployeeSalaryInput,
): Promise<EmployeeSalaryView> {
  if (!mayAssignSalary(actor, input.employeeId)) {
    // Deliberately specific when it is the self-assignment rule, because a
    // generic 403 would send an administrator looking for a missing grant.
    if (actor.employeeId !== null && actor.employeeId === input.employeeId) {
      throw new AppError(
        'FORBIDDEN',
        403,
        'You cannot set your own salary. Somebody else with payroll assign rights has to do it.',
      );
    }
    throw new AppError('FORBIDDEN', 403, 'Assigning a salary needs payroll assign rights.');
  }

  const employee = await repo.findEmployeeRef(input.employeeId);
  if (!employee) throw notFound();

  if (input.structureId) {
    const structure = await repo.findStructure(input.structureId);
    if (!structure) {
      throw new AppError('VALIDATION_ERROR', 400, 'That salary structure does not exist.');
    }
    if (!structure.isActive) {
      throw new AppError('VALIDATION_ERROR', 400, `${structure.code} is not an active structure.`);
    }
  }

  // Normalised to midnight UTC: `effectiveFrom` is a @db.Date and a time
  // component would make two assignments on the same day look distinct to the
  // unique constraint.
  const effectiveFrom = new Date(
    Date.UTC(
      input.effectiveFrom.getUTCFullYear(),
      input.effectiveFrom.getUTCMonth(),
      input.effectiveFrom.getUTCDate(),
    ),
  );

  const clash = await repo.findSalaryAt(input.employeeId, effectiveFrom);
  if (clash) {
    throw new AppError(
      'CONFLICT',
      409,
      'This employee already has a salary assignment effective from that date.',
    );
  }

  if (input.overrides?.length) {
    await assertComponentsExistAndCohere(input.overrides.map((o) => o.componentId));
  }

  const id = await repo.prisma.$transaction(async (tx) => {
    const created = await repo.createSalary(tx, {
      employeeId: input.employeeId,
      structureId: input.structureId ?? null,
      monthlyGross: input.monthlyGross,
      currency: input.currency ?? DEFAULT_PAYROLL_CURRENCY,
      effectiveFrom,
      notes: input.notes ?? null,
      createdById: actor.id,
    });

    if (input.overrides?.length) {
      await repo.addSalaryOverrides(
        tx,
        input.overrides.map((o) => ({
          salaryId: created.id,
          componentId: o.componentId,
          amount: o.amount ?? null,
          rateOverride: o.rateOverride ?? null,
        })),
      );
    }

    /*
      Close the previous open assignment the day before this one starts. Done in
      the same transaction so there is never a moment with two open assignments —
      which `findSalaryOn` would resolve by ordering, but which would make "what
      is this person's salary" ambiguous to anything reading the rows directly.
    */
    const closeAt = new Date(effectiveFrom.getTime() - 24 * 60 * 60 * 1000);
    await repo.closeOpenSalaries(tx, input.employeeId, closeAt, created.id);

    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'PAYROLL_SALARY_ASSIGNED',
    entityType: 'EmployeeSalary',
    entityId: id,
    actorId: actor.id,
    // The figure is audited deliberately: a salary change is exactly the event an
    // audit trail exists for. AuditLog is readable only to administrators, unlike
    // the notification table, which is why an amount is acceptable here and not
    // there.
    newValue: {
      employeeId: input.employeeId,
      monthlyGross: input.monthlyGross,
      effectiveFrom: effectiveFrom.toISOString(),
      structureId: input.structureId ?? null,
    },
  });

  const row = await repo.findSalary(id);
  if (!row) throw notFound();
  return presentSalary(row, new Date());
}
