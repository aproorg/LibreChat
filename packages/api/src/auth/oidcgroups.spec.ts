import { tenantStorage, getTenantId } from '@librechat/data-schemas';
import {
  parseGroupClaim,
  normalizeGroupId,
  syncOidcGroups,
  syncOidcGroupsFromConfig,
} from './oidcgroups';

describe('parseGroupClaim', () => {
  it('keeps trimmed valid strings, de-duplicated', () => {
    expect(parseGroupClaim([' a ', 'a', 'b'])).toEqual(['a', 'b']);
    expect(parseGroupClaim('solo')).toEqual(['solo']);
  });

  it('drops garbage without throwing', () => {
    const long = 'x'.repeat(257);
    expect(parseGroupClaim({ a: 1 })).toEqual([]);
    expect(
      parseGroupClaim([1, null, undefined, {}, [], '', '  ', long, 'a\nb', 'c\u0000', 'ok']),
    ).toEqual(['ok']);
    expect(parseGroupClaim(undefined)).toEqual([]);
    expect(parseGroupClaim('x'.repeat(256))).toHaveLength(1);
  });

  it('caps at 500 values', () => {
    const many = Array.from({ length: 600 }, (_, i) => `g${i}`);
    expect(parseGroupClaim(many)).toHaveLength(500);
  });

  it('normalizeGroupId rejects non-strings', () => {
    expect(normalizeGroupId(5)).toBeNull();
    expect(normalizeGroupId(' a ')).toBe('a');
  });
});

describe('syncOidcGroups', () => {
  const claims = { sub: 's', iat: Math.floor(Date.now() / 1000), 'cognito:groups': ['A', 'B'] };
  const make = () => jest.fn().mockResolvedValue({ added: 1, removed: 0 });

  it('does nothing when the claim name is unset', async () => {
    const sync = make();
    await syncOidcGroups({ claims, user: { _id: 'u' }, syncUserOidcGroups: sync });
    expect(sync).not.toHaveBeenCalled();
  });

  it('syncs the claim values under the same key the read path uses', async () => {
    const sync = make();
    await syncOidcGroups({
      claimName: 'cognito:groups',
      claims,
      user: { _id: 'u1' },
      syncUserOidcGroups: sync,
    });
    expect(sync).toHaveBeenCalledWith({ memberId: 'u1', groupIds: ['A', 'B'] });
    await syncOidcGroups({
      claimName: 'cognito:groups',
      claims,
      user: { _id: 'u1', idOnTheSource: 'oid' },
      syncUserOidcGroups: sync,
    });
    expect(sync).toHaveBeenLastCalledWith({ memberId: 'oid', groupIds: ['A', 'B'] });
  });

  it('treats a missing claim as no groups', async () => {
    const sync = make();
    await syncOidcGroups({
      claimName: 'cognito:groups',
      claims: { sub: 's', iat: Math.floor(Date.now() / 1000) },
      user: { _id: 'u1' },
      syncUserOidcGroups: sync,
    });
    expect(sync).toHaveBeenCalledWith({ memberId: 'u1', groupIds: [] });
  });

  it('skips claims that were not freshly issued, so an old id token cannot re-add a group', async () => {
    const sync = jest.fn();
    const stale = { ...claims, iat: Math.floor(Date.now() / 1000) - 3600 };
    const { iat: _iat, ...undated } = claims;
    for (const old of [stale, undated]) {
      await syncOidcGroups({
        claimName: 'cognito:groups',
        claims: old,
        user: { _id: 'u' },
        syncUserOidcGroups: sync,
      });
    }
    expect(sync).not.toHaveBeenCalled();
  });

  it('skips when there are no verified claims', async () => {
    const sync = make();
    await syncOidcGroups({
      claimName: 'cognito:groups',
      claims: {},
      user: { _id: 'u1' },
      syncUserOidcGroups: sync,
    });
    expect(sync).not.toHaveBeenCalled();
  });

  it('swallows failures', async () => {
    const sync = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(
      syncOidcGroups({
        claimName: 'cognito:groups',
        claims,
        user: { _id: 'u1' },
        syncUserOidcGroups: sync,
      }),
    ).resolves.toBeUndefined();
  });

  it('runs inside the user tenant', async () => {
    let seen: string | undefined;
    const sync = jest.fn(async () => {
      seen = getTenantId();
      return { added: 0, removed: 0 };
    });
    await syncOidcGroups({
      claimName: 'cognito:groups',
      claims,
      user: { _id: 'u1', tenantId: 't1' },
      syncUserOidcGroups: sync,
    });
    expect(seen).toBe('t1');
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }));
    await tenantStorage.run({ tenantId: 'other' }, () =>
      syncOidcGroups({
        claimName: 'cognito:groups',
        claims,
        user: { _id: 'u1', tenantId: 't1' },
        syncUserOidcGroups: sync,
      }),
    );
    expect(seen).toBe('other');
  });
});

describe('syncOidcGroupsFromConfig', () => {
  const claims = { sub: 's', iat: Math.floor(Date.now() / 1000), 'cognito:groups': ['A'] };

  it('does not throw when the config read fails', async () => {
    const sync = jest.fn();
    await expect(
      syncOidcGroupsFromConfig({
        getAppConfig: jest.fn().mockRejectedValue(new Error('config down')),
        claims,
        user: { _id: 'u1' },
        syncUserOidcGroups: sync,
      }),
    ).resolves.toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });

  it('uses the base-config claim name', async () => {
    const sync = jest.fn().mockResolvedValue({ added: 1, removed: 0 });
    await syncOidcGroupsFromConfig({
      getAppConfig: jest
        .fn()
        .mockResolvedValue({ config: { openidGroupsClaim: 'cognito:groups' } }),
      claims,
      user: { _id: 'u1' },
      syncUserOidcGroups: sync,
    });
    expect(sync).toHaveBeenCalledWith({ memberId: 'u1', groupIds: ['A'], tenantId: undefined });
  });
});
