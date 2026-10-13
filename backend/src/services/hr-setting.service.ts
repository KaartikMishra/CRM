/**
 * HR settings — policy the business owns, stored rather than compiled in.
 *
 * Working hours, week-off patterns, leave quotas, probation lengths and payroll
 * cycles all change by business decision rather than by deployment. A constant in
 * code means a release to change a number somebody in HR should be able to edit.
 *
 * ### Why this is not a generic AppSetting for the whole CRM
 *
 * Every existing module's constants live in `shared/src/constants`, and the
 * database enforces the important ones again as CHECK constraints — the sales
 * item cap, the delivery-days minimum, the non-negative stock rule. Making those
 * editable at runtime would let somebody set a value the schema still refuses, so
 * the write would succeed and the next insert would fail with a constraint error
 * nobody can explain.
 *
 * This table is for policy the business owns. The constants are contracts the code
 * owns. Keeping them apart is the point.
 *
 * ### Why key/value and not a column per setting
 *
 * HR alone needs dozens, and they arrive one at a time as each sub-module is
 * built. A column each means a migration per policy, and a table of sixty mostly
 * null columns. `value` is Json so a setting can be a number, a string, a list of
 * week-off days or a nested object without five typed columns that are null four
 * times out of five.
 *
 * The cost is that nothing type-checks a setting's shape at the boundary, which is
 * why `readSetting` below takes a parser rather than returning `unknown` and
 * trusting the caller.
 */

import type { Prisma } from '@prisma/client';
import type { HrModule } from '@rs/shared';
import { prisma } from '../config/database.js';
import { AppError } from '../utils/AppError.js';

const settingSelect = {
  id: true,
  module: true,
  key: true,
  value: true,
  description: true,
  updatedById: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true } },
} as const;

export type HRSettingView = Prisma.HRSettingGetPayload<{ select: typeof settingSelect }>;

/**
 * Writes a setting, creating it if it does not exist.
 *
 * An upsert on the (module, key) unique index rather than a read-then-write:
 * two administrators saving the same settings screen at once would otherwise
 * both see "no row", both insert, and the second would fail on the constraint.
 */
export async function upsertSetting(
  actorId: string,
  input: {
    module: HrModule;
    key: string;
    value: unknown;
    description?: string;
  },
): Promise<HRSettingView> {
  return prisma.hRSetting.upsert({
    where: { module_key: { module: input.module, key: input.key } },
    create: {
      module: input.module,
      key: input.key,
      value: input.value as Prisma.InputJsonValue,
      description: input.description ?? null,
      updatedById: actorId,
    },
    update: {
      value: input.value as Prisma.InputJsonValue,
      // Only overwrite the description when one was supplied, so saving a value
      // does not silently erase the note explaining what it controls.
      ...(input.description === undefined ? {} : { description: input.description }),
      updatedById: actorId,
    },
    select: settingSelect,
  });
}

/** Every setting a module owns, for a settings screen. Not paginated — see below. */
export async function listSettings(module?: HrModule): Promise<HRSettingView[]> {
  /*
    Deliberately unpaginated, unlike every other list in this codebase. Settings
    are a bounded set a business configures once, counted in dozens; a settings
    form needs all of them at once to render, and paging would mean the second
    page's values are not on screen when the first page is saved.
  */
  return prisma.hRSetting.findMany({
    where: module ? { module } : {},
    orderBy: [{ module: 'asc' }, { key: 'asc' }],
    select: settingSelect,
  });
}

/**
 * One setting's raw stored value, or null when it has never been set.
 *
 * Null means "not configured", which is distinct from a stored null — and is why
 * the Zod value schema refuses null: clearing a setting is deleting its row, not
 * storing an absence every reader then has to special-case twice.
 */
export async function findSetting(module: HrModule, key: string): Promise<unknown | null> {
  const row = await prisma.hRSetting.findUnique({
    where: { module_key: { module, key } },
    select: { value: true },
  });

  return row ? row.value : null;
}

/**
 * One setting, parsed, with a fallback.
 *
 * This is the function callers should use, and the reason it exists is the one
 * real weakness of a Json key/value store: a setting written as `"8"` and read as
 * a number is a bug that surfaces hours later in arithmetic, not at the read.
 * Passing a parser means a malformed or stale value is caught at the boundary and
 * the caller gets the default instead of a string where it expected a number.
 *
 * A bad stored value falls back rather than throwing. A settings row somebody
 * edited into the wrong shape should not take down payroll — it should behave as
 * though unconfigured, which is a state every caller must already handle.
 */
export async function readSetting<T>(
  module: HrModule,
  key: string,
  parse: (value: unknown) => T,
  fallback: T,
): Promise<T> {
  const raw = await findSetting(module, key);
  if (raw === null) return fallback;

  try {
    return parse(raw);
  } catch {
    return fallback;
  }
}

/** Removes a setting, returning it to whatever the code's default is. */
export async function deleteSetting(module: HrModule, key: string): Promise<void> {
  const existing = await prisma.hRSetting.findUnique({
    where: { module_key: { module, key } },
    select: { id: true },
  });

  if (!existing) {
    throw AppError.notFound('SETTING_NOT_FOUND', 'That setting could not be found.');
  }

  await prisma.hRSetting.delete({ where: { id: existing.id } });
}
