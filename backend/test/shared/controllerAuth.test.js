jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { authorizeController, requireControllerOwner } = require('../../src/shared/controllerAuth');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, OWNER } = require('../helpers');

describe('authorizeController', () => {
  test('allows a SoftwareAdmin in the ControllerOwner group', async () => {
    requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
    await expect(authorizeController({})).resolves.toBe(CONTROLLER_ADMIN);
  });

  test('rejects a SoftwareAdmin who is not in ControllerOwner', async () => {
    requireAuth.mockResolvedValue(PLAIN_ADMIN);
    await expect(authorizeController({})).rejects.toMatchObject({ statusCode: 403 });
  });

  test.each(['Owner', 'Manager', 'TeamMember', 'SoftwareRep'])(
    'rejects a %s even if they were somehow added to ControllerOwner',
    async (role) => {
      requireAuth.mockResolvedValue({ ...OWNER, role, groups: ['ControllerOwner'] });
      await expect(authorizeController({})).rejects.toMatchObject({ statusCode: 403 });
    }
  );

  test('passes through a 401 for a missing or invalid token', async () => {
    const err = Object.assign(new Error('Invalid or expired token'), { statusCode: 401 });
    requireAuth.mockRejectedValue(err);
    await expect(authorizeController({})).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('requireControllerOwner', () => {
  test('treats missing groups as no access', () => {
    expect(() => requireControllerOwner({ role: 'SoftwareAdmin' })).toThrow('Not authorized');
  });
});
