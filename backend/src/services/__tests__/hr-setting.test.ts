/**
 * HR settings against the real database.
 *
 * Two things are being pinned here, and only the first is obvious.
 *
 * The obvious one: a setting round-trips, and the (module, key) uniqueness means
 * writing twice updates rather than duplicates.
 *
 * The less obvious one, and the reason `readSetting` takes a parser: a Json
 * key/value store type-checks nothing. A value written as the string `"8"` and
 * read as a number is a bug that surfaces hours later inside arithmetic rather
 * than at the read, which is the one real weakness of this design. The tests at
 * the bottom are about that boundary.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../config/database.js';
import {
  deleteSetting,
  findSetting,
  listSettings,
  readSetting,
  upsertSetting,
} from '../hr-setting.service.js';
import { cleanup, makeUser, type TestUser } from '../../__tests__/helpers/fixtures.js';
import { AppError } from '../../utils/AppError.js';

let admin: TestUser;

/** Keys are namespaced per test so no two share a (module, key) row. */
let counter = 0;
const key = (name: string): string => {
  counter += 1;
  return `zz_test.${name}_${counter}`;
};

beforeAll(async () => {
  admin = await makeUser('ADMIN');
});

afterAll(async () => {
  await prisma.hRSetting.deleteMany({ where: { key: { startsWith: 'zz_test.' } } });
  await cleanup();
});

describe('storing a setting', () => {
  it('round-trips a number', async () => {
    const k = key('working_hours_per_day');
    await upsertSetting(admin.id, { module: 'HR_ATTENDANCE', key: k, value: 8 });

    expect(await findSetting('HR_ATTENDANCE', k)).toBe(8);
  });

  it('round-trips a list, which is why value is Json', async () => {
    const k = key('week_off_days');
    // A column per setting could not hold this without a join table or a
    // comma-separated string, and both are worse than Json here.
    await upsertSetting(admin.id, {
      module: 'HR_ATTENDANCE',
      key: k,
      value: ['SATURDAY', 'SUNDAY'],
    });

    expect(await findSetting('HR_ATTENDANCE', k)).toEqual(['SATURDAY', 'SUNDAY']);
  });

  it('round-trips a nested object', async () => {
    const k = key('shift');
    await upsertSetting(admin.id, {
      module: 'HR_ATTENDANCE',
      key: k,
      value: { start: '09:30', end: '18:30', graceMinutes: 15 },
    });

    expect(await findSetting('HR_ATTENDANCE', k)).toEqual({
      start: '09:30',
      end: '18:30',
      graceMinutes: 15,
    });
  });

  it('records who last changed it', async () => {
    const k = key('probation_months');
    const setting = await upsertSetting(admin.id, {
      module: 'HR_EMPLOYEE',
      key: k,
      value: 6,
    });

    expect(setting.updatedById).toBe(admin.id);
    expect(setting.updatedBy?.name).toBe(admin.name);
  });
});

describe('writing the same key twice', () => {
  it('updates in place rather than creating a second row', async () => {
    const k = key('annual_quota');
    const first = await upsertSetting(admin.id, { module: 'HR_LEAVE', key: k, value: 18 });
    const second = await upsertSetting(admin.id, { module: 'HR_LEAVE', key: k, value: 21 });

    // Same row, new value. This is what makes a setting a setting rather than an
    // append-only log of attempts to set it.
    expect(second.id).toBe(first.id);
    expect(await findSetting('HR_LEAVE', k)).toBe(21);

    const rows = await prisma.hRSetting.count({ where: { module: 'HR_LEAVE', key: k } });
    expect(rows).toBe(1);
  });

  it('keeps the description when a value is saved without one', async () => {
    const k = key('carry_forward_cap');
    await upsertSetting(admin.id, {
      module: 'HR_LEAVE',
      key: k,
      value: 10,
      description: 'Days an employee may carry into the next year',
    });

    const updated = await upsertSetting(admin.id, { module: 'HR_LEAVE', key: k, value: 12 });

    // Changing a number must not silently erase the note explaining what it
    // controls — six months later that note is the only thing that does.
    expect(updated.description).toBe('Days an employee may carry into the next year');
    expect(updated.value).toBe(12);
  });

  it('separates the same key under two modules', async () => {
    const k = key('shared_key_name');
    await upsertSetting(admin.id, { module: 'HR_LEAVE', key: k, value: 'leave' });
    await upsertSetting(admin.id, { module: 'HR_PAYROLL', key: k, value: 'payroll' });

    // Uniqueness is on the pair, so a module namespaces its own keys.
    expect(await findSetting('HR_LEAVE', k)).toBe('leave');
    expect(await findSetting('HR_PAYROLL', k)).toBe('payroll');
  });
});

describe('reading a setting that is not configured', () => {
  it('returns null from findSetting', async () => {
    expect(await findSetting('HR_PAYROLL', key('never_set'))).toBeNull();
  });

  it('returns the fallback from readSetting', async () => {
    const value = await readSetting('HR_PAYROLL', key('never_set'), Number, 30);
    expect(value).toBe(30);
  });
});

describe('readSetting guards the Json boundary', () => {
  it('parses a stored value through the caller’s parser', async () => {
    const k = key('payroll_cycle_day');
    await upsertSetting(admin.id, { module: 'HR_PAYROLL', key: k, value: 1 });

    const parse = (raw: unknown): number => {
      if (typeof raw !== 'number') throw new Error('not a number');
      return raw;
    };

    expect(await readSetting('HR_PAYROLL', k, parse, 25)).toBe(1);
  });

  it('falls back when the stored value is the wrong shape', async () => {
    const k = key('misconfigured');
    // Somebody edited the row and left a string where a number belongs.
    await upsertSetting(admin.id, { module: 'HR_PAYROLL', key: k, value: 'the first' });

    const parse = (raw: unknown): number => {
      if (typeof raw !== 'number') throw new Error('not a number');
      return raw;
    };

    /*
      Falls back rather than throwing, deliberately. A settings row somebody
      edited into the wrong shape should not take payroll down — it should behave
      as though unconfigured, which is a state every caller already has to handle.
      Throwing would turn one bad row into an outage.
    */
    expect(await readSetting('HR_PAYROLL', k, parse, 25)).toBe(25);
  });
});

describe('listing and deleting', () => {
  it('lists only the requested module’s settings', async () => {
    const leaveKey = key('list_leave');
    const payrollKey = key('list_payroll');
    await upsertSetting(admin.id, { module: 'HR_LEAVE', key: leaveKey, value: 1 });
    await upsertSetting(admin.id, { module: 'HR_PAYROLL', key: payrollKey, value: 2 });

    const keys = (await listSettings('HR_LEAVE')).map((s) => s.key);
    expect(keys).toContain(leaveKey);
    expect(keys).not.toContain(payrollKey);
  });

  it('returns a setting to the code default when deleted', async () => {
    const k = key('deletable');
    await upsertSetting(admin.id, { module: 'HR_LEAVE', key: k, value: 5 });

    await deleteSetting('HR_LEAVE', k);

    // Not configured, which is distinct from configured-as-null — and why the
    // Zod value schema refuses null in the first place.
    expect(await findSetting('HR_LEAVE', k)).toBeNull();
  });

  it('reports a missing setting rather than succeeding silently', async () => {
    await expect(deleteSetting('HR_LEAVE', key('not_there'))).rejects.toThrow(AppError);
  });
});

describe('the database refuses a keyless setting', () => {
  it('rejects a blank key written straight through Prisma', async () => {
    /*
      Bypassing the service on purpose: the Zod schema rejects this at the edge,
      and the CHECK must reject it again so no script or console can store a key
      that is unreachable by any reader that trims its input.
    */
    await expect(
      prisma.hRSetting.create({
        data: { module: 'HR_LEAVE', key: '   ', value: 1, updatedById: admin.id },
      }),
    ).rejects.toThrow();
  });
});
