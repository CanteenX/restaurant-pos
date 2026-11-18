import {
  canManageControlStaff,
  CONTROL_PERMISSIONS,
  CONTROL_ROLE_PRESETS,
  controlPermissionSatisfied,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  permissionSatisfied,
} from '@nventra/types';

const actor = {
  staffId: '111111aa-1111-4111-8111-111111111111',
  grants: ['cc.staff.manage', 'cc.business.read', 'cc.ticket.read'],
};
const subject = {
  staffId: '222222bb-2222-4222-8222-222222222222',
  grants: ['cc.business.read'],
};

describe('Control permission registry', () => {
  it('registers only explicit Control keys separately from the POS catalog', () => {
    expect(CONTROL_PERMISSIONS).toEqual([
      'cc.staff.read',
      'cc.staff.manage',
      'cc.business.read',
      'cc.business.manage',
      'cc.plan.read',
      'cc.plan.manage',
      'cc.audit.read',
      'cc.billing.read',
      'cc.billing.manage',
      'cc.hosted.read',
      'cc.hosted.manage',
      'cc.portal.read',
      'cc.portal.manage',
      'cc.ticket.read',
      'cc.ticket.manage',
      'cc.ticket.reply',
    ]);
    expect(Object.isFrozen(CONTROL_PERMISSIONS)).toBe(true);

    const posKeys = PERMISSIONS.map(({ key }) => key);
    expect(posKeys).toContain('staff.manage');
    expect(posKeys.filter((key) => key.startsWith('cc.'))).toEqual([]);
    expect(DEFAULT_ROLE_PERMISSIONS.OWNER).toEqual(posKeys);
    expect(DEFAULT_ROLE_PERMISSIONS.ADMINISTRATOR).toEqual(posKeys);
    for (const keys of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      expect(keys.every((key) => posKeys.includes(key))).toBe(true);
    }
    expect(permissionSatisfied(['menu.manage'], 'menu.view')).toBe(true);
  });

  it('provides explicit owner, support and sales presets for initial grants', () => {
    expect(CONTROL_ROLE_PRESETS.OWNER).toEqual(CONTROL_PERMISSIONS);
    expect(CONTROL_ROLE_PRESETS.SUPPORT).toEqual([
      'cc.business.read',
      'cc.plan.read',
      'cc.ticket.read',
      'cc.ticket.manage',
      'cc.ticket.reply',
    ]);
    expect(CONTROL_ROLE_PRESETS.SALES).toEqual([
      'cc.business.read',
      'cc.business.manage',
      'cc.plan.read',
    ]);
    expect(Object.isFrozen(CONTROL_ROLE_PRESETS)).toBe(true);
    expect(Object.values(CONTROL_ROLE_PRESETS).every(Object.isFrozen)).toBe(
      true,
    );
  });

  it('checks only explicit grants and rejects malformed or mixed-product scope', () => {
    expect(controlPermissionSatisfied(actor.grants, 'cc.staff.manage')).toBe(
      true,
    );
    expect(
      controlPermissionSatisfied(['cc.ticket.manage'], 'cc.ticket.read'),
    ).toBe(false);
    expect(controlPermissionSatisfied(['OWNER'], 'cc.staff.manage')).toBe(
      false,
    );
    expect(
      controlPermissionSatisfied('cc.staff.manage', 'cc.staff.manage'),
    ).toBe(false);
    expect(
      controlPermissionSatisfied(
        ['cc.staff.manage', 'staff.manage'],
        'cc.staff.manage',
      ),
    ).toBe(false);
    expect(
      controlPermissionSatisfied(
        ['cc.staff.manage', 'cc.future.manage'],
        'cc.staff.manage',
      ),
    ).toBe(false);
  });
});

describe('Control staff grant ceiling', () => {
  it('accepts a distinct subordinate subject and an explicitly held requested subset', () => {
    expect(canManageControlStaff(actor, subject, ['cc.ticket.read'])).toBe(
      true,
    );
    expect(canManageControlStaff(actor, subject, [])).toBe(true);
    expect(
      canManageControlStaff(actor, { ...subject, grants: [] }, actor.grants),
    ).toBe(true);
  });

  it('requires staff management even when the actor has the owner role label', () => {
    const namedOwner = {
      ...actor,
      role: 'OWNER',
      grants: ['cc.business.read', 'cc.ticket.read'],
    };
    expect(canManageControlStaff(namedOwner, subject, ['cc.ticket.read'])).toBe(
      false,
    );
  });

  it('denies self-management and blank subject or actor identity', () => {
    expect(
      canManageControlStaff(actor, { ...subject, staffId: actor.staffId }, []),
    ).toBe(false);
    expect(canManageControlStaff(actor, { ...subject, staffId: ' ' }, [])).toBe(
      false,
    );
    expect(canManageControlStaff({ ...actor, staffId: '' }, subject, [])).toBe(
      false,
    );
  });

  it.each([
    ['non-UUID actor ID', 'actor', subject.staffId],
    ['non-UUID subject ID', actor.staffId, 'subject'],
    [
      'uppercase spelling of the actor UUID',
      actor.staffId,
      actor.staffId.toUpperCase(),
    ],
    ['UUID with a trailing newline', actor.staffId, subject.staffId + '\n'],
  ])('rejects %s', (_reason, actorId, subjectId) => {
    expect(
      canManageControlStaff(
        { ...actor, staffId: actorId },
        { ...subject, staffId: subjectId },
        [],
      ),
    ).toBe(false);
  });

  it('denies peer, superior and incomparable scopes regardless of duplicate entries', () => {
    expect(
      canManageControlStaff(actor, { ...subject, grants: actor.grants }, []),
    ).toBe(false);
    expect(
      canManageControlStaff(
        { ...actor, grants: [...actor.grants, ...actor.grants] },
        {
          ...subject,
          grants: actor.grants,
        },
        [],
      ),
    ).toBe(false);
    expect(
      canManageControlStaff(
        actor,
        { ...subject, grants: [...actor.grants, 'cc.plan.manage'] },
        [],
      ),
    ).toBe(false);
    expect(
      canManageControlStaff(
        actor,
        { ...subject, grants: ['cc.plan.read'] },
        [],
      ),
    ).toBe(false);
  });

  it('denies requested authority the actor does not explicitly hold', () => {
    expect(canManageControlStaff(actor, subject, ['cc.plan.read'])).toBe(false);
    expect(
      canManageControlStaff(actor, subject, [
        'cc.staff.manage',
        'cc.audit.read',
      ]),
    ).toBe(false);
  });

  it('denies invalid stored grants and unknown requested keys without discarding them', () => {
    for (const invalid of [
      null,
      'cc.staff.manage',
      ['cc.future.read'],
      ['staff.manage'],
      [null],
      [42],
    ]) {
      expect(
        canManageControlStaff({ ...actor, grants: invalid }, subject, []),
      ).toBe(false);
      expect(
        canManageControlStaff(actor, { ...subject, grants: invalid }, []),
      ).toBe(false);
      expect(canManageControlStaff(actor, subject, invalid)).toBe(false);
    }
    expect(
      canManageControlStaff(
        { ...actor, grants: [...actor.grants, '__proto__'] },
        subject,
        [],
      ),
    ).toBe(false);
  });
});
