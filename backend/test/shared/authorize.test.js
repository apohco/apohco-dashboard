const { requireRole, requireGroupAccess, DASHBOARD_ROLES } = require('../../src/shared/authorize');

const G = 'group-1';

describe('requireGroupAccess', () => {
  test('platform roles reach any Group; practice roles only their own', () => {
    expect(() => requireGroupAccess({ role: 'SoftwareAdmin', groupId: null }, G)).not.toThrow();
    expect(() => requireGroupAccess({ role: 'SoftwareRep', groupId: null }, G)).not.toThrow();
    expect(() => requireGroupAccess({ role: 'Owner', groupId: G }, G)).not.toThrow();
    expect(() => requireGroupAccess({ role: 'TeamMember', groupId: 'other' }, G)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  test('the Accountant role is refused everywhere, even with a matching groupId', () => {
    expect(() => requireGroupAccess({ role: 'Accountant', groupId: null }, G)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => requireGroupAccess({ role: 'Accountant', groupId: G }, G)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  test('an unknown or missing role is refused', () => {
    expect(() => requireGroupAccess({ role: undefined, groupId: G }, G)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => requireGroupAccess({ role: 'Auditor', groupId: G }, G)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

test('DASHBOARD_ROLES are the five dashboard roles, without Accountant', () => {
  expect(DASHBOARD_ROLES).toEqual(['SoftwareAdmin', 'SoftwareRep', 'Owner', 'Manager', 'TeamMember']);
  expect(() => requireRole({ role: 'Accountant' }, DASHBOARD_ROLES)).toThrow(expect.objectContaining({ statusCode: 403 }));
});
