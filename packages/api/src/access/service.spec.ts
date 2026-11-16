import type { AppConfig } from '@librechat/data-schemas';
import { createAccessService } from './service';

const limited = {
  config: { mcpServers: { sindri: { allowedFor: { groups: ['Þjónusta'] } } } },
} as unknown as AppConfig;
const unlimited = { config: { mcpServers: { sindri: {} } } } as unknown as AppConfig;

const setup = (appConfig: AppConfig, groups: Array<{ name: string }> = []) => {
  const getAppConfig = jest.fn().mockResolvedValue(appConfig);
  const getUserGroups = jest.fn().mockResolvedValue(groups);
  return {
    getAppConfig,
    getUserGroups,
    service: createAccessService({ getAppConfig, getUserGroups }),
  };
};

describe('createAccessService', () => {
  it('resolves null and reads no groups when the file has no limits', async () => {
    const { service, getUserGroups } = setup(unlimited);
    expect(await service.getAccess({ user: { id: '1', email: 'a@b.is' } })).toBeNull();
    expect(getUserGroups).not.toHaveBeenCalled();
  });

  it('reads the base config only and looks up groups once per request', async () => {
    const { service, getUserGroups, getAppConfig } = setup(limited, [{ name: 'Þjónusta' }]);
    const req = { user: { id: '1', email: 'a@b.is', tenantId: 't' } };
    const first = await service.getAccess(req);
    const second = await service.getAccess(req);
    expect(first).toBe(second);
    expect(first?.allowsMcpServer('sindri')).toBe(true);
    expect(getUserGroups).toHaveBeenCalledTimes(1);
    expect(getUserGroups).toHaveBeenCalledWith('1');
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true, tenantId: 't' });
  });

  it('refuses a caller outside the group', async () => {
    const { service } = setup(limited, [{ name: 'Annað' }]);
    const access = await service.getAccess({ user: { id: '1', email: 'a@b.is' } });
    expect(access?.allowsMcpServer('sindri')).toBe(false);
  });

  it('rejects when the group lookup fails', async () => {
    const { service, getUserGroups } = setup(limited);
    getUserGroups.mockRejectedValue(new Error('db down'));
    await expect(service.getAccess({ user: { id: '1' } })).rejects.toThrow('db down');
  });

  it('treats a missing user as a caller with no email and no groups', async () => {
    const { service, getUserGroups } = setup(limited);
    const access = await service.getAccess({});
    expect(access?.allowsMcpServer('sindri')).toBe(false);
    expect(getUserGroups).not.toHaveBeenCalled();
  });
  it('reads the email of a user known only by id, and only when the file has limits', async () => {
    const byEmail = {
      config: { mcpServers: { sindri: { allowedFor: { users: ['jon@apro.is'] } } } },
    } as unknown as AppConfig;
    const getUserEmail = jest.fn().mockResolvedValue('Jon@apro.is');
    const getUserGroups = jest.fn().mockResolvedValue([]);
    const withLimits = createAccessService({
      getAppConfig: jest.fn().mockResolvedValue(byEmail),
      getUserGroups,
      getUserEmail,
    });
    const access = await withLimits.getAccessForUser('1');
    expect(access?.allowsMcpServer('sindri')).toBe(true);
    expect(getUserEmail).toHaveBeenCalledWith('1');

    getUserEmail.mockClear();
    const noLimits = createAccessService({
      getAppConfig: jest.fn().mockResolvedValue(unlimited),
      getUserGroups,
      getUserEmail,
    });
    expect(await noLimits.getAccessForUser('1')).toBeNull();
    expect(getUserEmail).not.toHaveBeenCalled();
  });

  it('resolves null when there is no config file at all', async () => {
    const { service } = setup({} as AppConfig);
    expect(await service.getAccess({ user: { id: '1' } })).toBeNull();
  });
});
