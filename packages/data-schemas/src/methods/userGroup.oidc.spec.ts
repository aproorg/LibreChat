import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createUserGroupMethods } from './userGroup';
import groupSchema from '~/schema/group';
import userSchema from '~/schema/user';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryReplSet;
let Group: mongoose.Model<t.IGroup>;
let User: mongoose.Model<t.IUser>;
let methods: ReturnType<typeof createUserGroupMethods>;

beforeAll(async () => {
  applyTenantIsolation(groupSchema);
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Group = mongoose.models.Group || mongoose.model<t.IGroup>('Group', groupSchema);
  User = mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);
  methods = createUserGroupMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await Group.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Group.deleteMany({});
  await User.deleteMany({});
});

const createUser = (overrides: Partial<t.IUser> = {}) =>
  User.create({
    name: 'Test User',
    email: `user-${new Types.ObjectId()}@test.com`,
    password: 'password123',
    provider: 'openid',
    role: SystemRoles.USER,
    ...overrides,
  });

const memberGroups = async (memberId: string) =>
  (await Group.find({ memberIds: memberId }).lean()).map((g) => g.idOnTheSource).sort();

describe('syncUserOidcGroups', () => {
  it('creates missing groups named by id and adds the member (read path sees them)', async () => {
    const user = await createUser();
    const memberId = user._id.toString();
    await methods.syncUserOidcGroups({ memberId, groupIds: ['A', 'B'] });

    const groups = await Group.find({ source: 'oidc' }).lean();
    expect(groups.map((g) => [g.name, g.idOnTheSource]).sort()).toEqual([
      ['A', 'A'],
      ['B', 'B'],
    ]);
    const principals = await methods.getUserPrincipals({ userId: memberId });
    const ids = principals
      .filter((p) => p.principalType === PrincipalType.GROUP)
      .map((p) => String(p.principalId))
      .sort();
    expect(ids).toEqual(groups.map((g) => g._id.toString()).sort());
    expect((await methods.findGroupsByMemberId(user._id)).length).toBe(2);
  });

  it('uses idOnTheSource as member key when the user has one', async () => {
    const user = await createUser({ idOnTheSource: 'oid-1' });
    await methods.syncUserOidcGroups({ memberId: 'oid-1', groupIds: ['A'] });
    expect((await methods.findGroupsByMemberId(user._id)).map((g) => g.name)).toEqual(['A']);
    const principals = await methods.getUserPrincipals({
      userId: user._id.toString(),
      idOnTheSource: 'oid-1',
    });
    expect(principals.filter((p) => p.principalType === PrincipalType.GROUP)).toHaveLength(1);
  });

  it('adds, keeps and removes on the next sync; the dropped group document stays', async () => {
    await methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['A', 'B'] });
    await methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['B', 'C'] });
    expect(await memberGroups('u1')).toEqual(['B', 'C']);
    expect(await Group.countDocuments({ source: 'oidc', idOnTheSource: 'A' })).toBe(1);
  });

  it('invalidates the principals cache for the member', async () => {
    const store = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (k: string) => store.get(k)),
      set: jest.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      delete: jest.fn(async (k: string) => store.delete(k)),
      clear: jest.fn(async () => store.clear()),
    };
    const cached = createUserGroupMethods(mongoose, {
      getCache: () => cache,
    });
    const userId = new Types.ObjectId().toString();
    await cached.syncUserOidcGroups({ memberId: userId, groupIds: ['A'] });
    const before = await cached.getUserPrincipals({ userId });
    expect(before.filter((p) => p.principalType === PrincipalType.GROUP)).toHaveLength(1);
    await cached.syncUserOidcGroups({ memberId: userId, groupIds: [] });
    const after = await cached.getUserPrincipals({ userId });
    expect(after.filter((p) => p.principalType === PrincipalType.GROUP)).toHaveLength(0);
  });

  it('empty claim removes all oidc memberships but never touches local or entra groups', async () => {
    await Group.create([
      { name: 'L', source: 'local', memberIds: ['u1'] },
      { name: 'X', source: 'entra', idOnTheSource: 'X', memberIds: ['u1'] },
      { name: 'Y', source: 'local', memberIds: ['u1'] },
    ]);
    await methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['X', 'Y', 'Z'] });
    expect(await Group.countDocuments({ source: 'oidc', memberIds: 'u1' })).toBe(3);
    await methods.syncUserOidcGroups({ memberId: 'u1', groupIds: [] });
    expect(await Group.countDocuments({ source: 'oidc', memberIds: 'u1' })).toBe(0);
    expect((await Group.find({ memberIds: 'u1' }).lean()).map((g) => g.name).sort()).toEqual([
      'L',
      'X',
      'Y',
    ]);
  });

  it('does not attach to an entra or local group sharing the claim value', async () => {
    await Group.create({ name: 'X', source: 'entra', idOnTheSource: 'X', memberIds: [] });
    await methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['X'] });
    expect(await Group.countDocuments({ source: 'entra', memberIds: 'u1' })).toBe(0);
    expect(await Group.countDocuments({ source: 'oidc', memberIds: 'u1' })).toBe(1);
  });

  it('keeps tenants apart', async () => {
    await tenantStorage.run({ tenantId: 'tenant-1' }, () =>
      methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['A'], tenantId: 'tenant-1' }),
    );
    await tenantStorage.run({ tenantId: 'tenant-2' }, () =>
      methods.syncUserOidcGroups({ memberId: 'u2', groupIds: ['A'], tenantId: 'tenant-2' }),
    );
    const groups = await Group.collection.find({ source: 'oidc' }).toArray();
    expect(groups).toHaveLength(2);
    const byTenant = Object.fromEntries(
      groups.map((g) => [g.tenantId as string, g.memberIds as string[]]),
    );
    expect(byTenant).toEqual({ 'tenant-1': ['u1'], 'tenant-2': ['u2'] });
  });

  it.each([
    ['no ambient tenant', <T>(fn: () => Promise<T>) => fn()],
    ['SYSTEM scope (refresh path)', <T>(fn: () => Promise<T>) => runAsSystem(fn)],
  ])('a tenant-less user never joins another tenant group (%s)', async (_label, wrap) => {
    await tenantStorage.run({ tenantId: 'tenant-2' }, () =>
      methods.ensureOidcGroup('Finance', 'tenant-2'),
    );
    await wrap(() => methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['Finance'] }));
    const groups = await Group.collection.find({ source: 'oidc' }).toArray();
    const other = groups.find((g) => g.tenantId === 'tenant-2');
    expect(other!.memberIds).toEqual([]);
    const own = groups.find((g) => g.tenantId === undefined);
    expect(own!.memberIds).toEqual(['u1']);
  });

  it('two concurrent logins with a new value end with one group holding both', async () => {
    for (let i = 0; i < 5; i++) {
      await Group.deleteMany({});
      await Promise.all([
        methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['N'] }),
        methods.syncUserOidcGroups({ memberId: 'u2', groupIds: ['N'] }),
      ]);
      const groups = await Group.find({ source: 'oidc' }).lean();
      expect(groups).toHaveLength(1);
      expect([...groups[0].memberIds!].sort()).toEqual(['u1', 'u2']);
    }
  });

  it('keeps an admin-given name across syncs and ensureOidcGroup', async () => {
    await methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['A'] });
    await Group.updateOne({ idOnTheSource: 'A', source: 'oidc' }, { name: 'Renamed' });
    await methods.syncUserOidcGroups({ memberId: 'u1', groupIds: ['A'] });
    const id = await methods.ensureOidcGroup('A');
    const group = await Group.findById(id).lean();
    expect(group!.name).toBe('Renamed');
  });
});

describe('ensureOidcGroup', () => {
  it('creates an empty group named by id and reuses it', async () => {
    const first = await methods.ensureOidcGroup('Finance');
    const second = await methods.ensureOidcGroup('Finance');
    expect(second).toBe(first);
    const group = await Group.findById(first).lean();
    expect(group).toMatchObject({ name: 'Finance', source: 'oidc', memberIds: [] });
  });
});
