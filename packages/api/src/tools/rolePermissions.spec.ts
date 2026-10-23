import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { Request as ServerRequest } from 'express';
import { checkWebSearchGrant } from './rolePermissions';

const buildRole = (use?: boolean) => ({
  name: 'USER',
  permissions: { [PermissionTypes.WEB_SEARCH]: { [Permissions.USE]: use } },
});

const buildReq = (user: unknown = { id: 'user-1', role: 'USER' }) =>
  ({ user }) as unknown as ServerRequest;

describe('checkWebSearchGrant', () => {
  it('grants when the role allows WEB_SEARCH.USE', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(buildRole(true));
    await expect(checkWebSearchGrant({ req: buildReq(), getRoleByName })).resolves.toBe(true);
    expect(getRoleByName).toHaveBeenCalledWith('USER');
  });

  it('denies when the role withholds WEB_SEARCH.USE', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(buildRole(false));
    await expect(checkWebSearchGrant({ req: buildReq(), getRoleByName })).resolves.toBe(false);
  });

  /** A permission block seeded without an explicit `USE` must not read as a grant. */
  it('denies when the permission block is empty', async () => {
    const getRoleByName = jest.fn().mockResolvedValue({ name: 'USER', permissions: {} });
    await expect(checkWebSearchGrant({ req: buildReq(), getRoleByName })).resolves.toBe(false);
  });

  it('denies when the role does not exist', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(null);
    await expect(checkWebSearchGrant({ req: buildReq(), getRoleByName })).resolves.toBe(false);
  });

  it('denies when the request carries no user', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(buildRole(true));
    const req = {} as ServerRequest;
    await expect(checkWebSearchGrant({ req, getRoleByName })).resolves.toBe(false);
    expect(getRoleByName).not.toHaveBeenCalled();
  });

  it('denies when the user carries no role', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(buildRole(true));
    await expect(
      checkWebSearchGrant({ req: buildReq({ id: 'user-1' }), getRoleByName }),
    ).resolves.toBe(false);
    expect(getRoleByName).not.toHaveBeenCalled();
  });

  /** Fails closed rather than propagating: a role store outage must not hand a
   *  denied user provider-native web search. */
  it('denies, without throwing, when the role lookup fails', async () => {
    const getRoleByName = jest.fn().mockRejectedValue(new Error('mongo down'));
    await expect(checkWebSearchGrant({ req: buildReq(), getRoleByName })).resolves.toBe(false);
  });

  it('authorizes an explicit user over req.user', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(buildRole(true));
    await checkWebSearchGrant({
      req: buildReq({ id: 'other', role: 'IGNORED' }),
      user: { id: 'user-1', role: 'USER' } as never,
      getRoleByName,
    });
    expect(getRoleByName).toHaveBeenCalledWith('USER');
  });
});
