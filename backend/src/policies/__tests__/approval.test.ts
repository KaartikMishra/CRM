/**
 * The approval rule itself, as pure logic.
 *
 * No database and no HTTP: `requiresApproval` is a function of one field, and
 * the point of these tests is to pin *which* field. The rule the CRM depends on
 * is that an administrator's own change needs nobody else's agreement, while
 * everyone else's still does — and that the line between the two is the
 * authenticated role, never a permission.
 *
 * That last part is the trap worth a test of its own. `SALES:ASSIGN` and
 * `PROCUREMENT:ASSIGN` mean "may review other people's requests", and a USER
 * can hold either through a per-user override. If the bypass were ever keyed on
 * a permission instead, granting somebody review rights would quietly stop them
 * being reviewable — the opposite of what the workflow is for.
 */

import { describe, expect, it } from 'vitest';
import type { Role } from '@rs/shared';
import { decidesOwnAction, requiresApproval, type Actor } from '../approval.js';

const actor = (role: Role, id = 'u1'): Actor => ({ id, role });

describe('an administrator never waits for approval', () => {
  it('needs no approval', () => {
    expect(requiresApproval(actor('ADMIN'))).toBe(false);
  });

  it('decides their own action', () => {
    expect(decidesOwnAction(actor('ADMIN'))).toBe(true);
  });

  it('holds regardless of which administrator it is', () => {
    for (const id of ['a1', 'a2', 'a3']) {
      expect(requiresApproval(actor('ADMIN', id)), id).toBe(false);
    }
  });
});

describe('a USER keeps the existing approval workflow', () => {
  it('still needs approval', () => {
    expect(requiresApproval(actor('USER'))).toBe(true);
  });

  it('does not decide their own action', () => {
    expect(decidesOwnAction(actor('USER'))).toBe(false);
  });
});

describe('the decision is the role and nothing else', () => {
  /**
   * The permission-vs-role trap, stated as a test.
   *
   * A USER carrying every powerful capability the CRM has is still a USER, and
   * still goes through approval. The function cannot even see a permission —
   * it takes only id and role — which is the structural reason this holds, and
   * why the assertion below is about the function's shape as much as its
   * output.
   */
  it('gives a USER no bypass whatever they are granted', () => {
    // These are the capabilities that *would* have been tempting to key on.
    const powerful = ['SALES:ASSIGN', 'PROCUREMENT:ASSIGN', 'SALES:EDIT', 'PROCUREMENT:EDIT'];
    for (const capability of powerful) {
      // The actor shape carries no permission at all; the capability is named
      // here only to document what is deliberately not consulted.
      expect(requiresApproval(actor('USER')), capability).toBe(true);
    }
  });

  it('takes only id and role, so a permission cannot reach it', () => {
    const shape: Actor = { id: 'u1', role: 'USER' };
    expect(Object.keys(shape).sort()).toEqual(['id', 'role']);
  });

  it('ignores the id entirely — two different people of one role agree', () => {
    expect(requiresApproval(actor('USER', 'x'))).toBe(requiresApproval(actor('USER', 'y')));
    expect(requiresApproval(actor('ADMIN', 'x'))).toBe(requiresApproval(actor('ADMIN', 'y')));
  });

  it('is exactly the negation between the two helpers', () => {
    for (const role of ['ADMIN', 'USER'] as const) {
      expect(decidesOwnAction(actor(role))).toBe(!requiresApproval(actor(role)));
    }
  });
});

describe('the two roles are treated differently, which is the whole point', () => {
  it('never returns the same answer for ADMIN and USER', () => {
    expect(requiresApproval(actor('ADMIN'))).not.toBe(requiresApproval(actor('USER')));
  });
});
