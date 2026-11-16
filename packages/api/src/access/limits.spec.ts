import { configSchema } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AccessCaller } from './limits';
import { collectLimits, createAccess, permits } from './limits';

const caller = (email: string, ...groups: string[]): AccessCaller => ({
  email,
  groups: new Set(groups),
});

const yaml = {
  version: '1.3.0',
  cache: true,
  modelSpecs: {
    list: [
      {
        name: 'fjarmal',
        label: 'Fjarmal GPT',
        preset: { endpoint: 'openAI', model: 'gpt-4o' },
        allowedFor: { groups: ['Fjármálasvið'], users: ['jon@apro.is'] },
      },
      { name: 'open', label: 'Open', preset: { endpoint: 'openAI', model: 'gpt-4o' } },
    ],
  },
  endpoints: {
    agents: { allowedFor: { groups: ['Þjónusta'] } },
    custom: [
      {
        name: 'Ollama',
        apiKey: 'k',
        baseURL: 'http://x',
        models: { default: ['a'] },
        allowedFor: { users: ['jon@apro.is'] },
      },
      { name: 'Open', apiKey: 'k', baseURL: 'http://x', models: { default: ['a'] } },
    ],
  },
  mcpServers: {
    sindri: { type: 'sse', url: 'http://x/sse', allowedFor: { groups: ['Þjónusta'] } },
  },
};

describe('collectLimits', () => {
  it('is null with no allowedFor key anywhere', () => {
    expect(collectLimits(undefined)).toBeNull();
    expect(collectLimits({})).toBeNull();
    expect(
      collectLimits({ endpoints: { agents: {}, custom: [{ name: 'x' }] } } as TCustomConfig),
    ).toBeNull();
  });

  it('picks up specs, built-in and custom endpoints, and mcp servers', () => {
    const limits = collectLimits(yaml as unknown as TCustomConfig);
    expect([...(limits?.specs.keys() ?? [])]).toEqual(['fjarmal']);
    expect([...(limits?.endpoints.keys() ?? [])].sort()).toEqual(['agents', 'ollama']);
    expect([...(limits?.mcpServers.keys() ?? [])]).toEqual(['sindri']);
  });

  it('keeps a key whose rule has the wrong shape so it permits nobody', () => {
    const limits = collectLimits({ mcpServers: { a: { allowedFor: 'everyone' } } } as never);
    expect(limits?.mcpServers.has('a')).toBe(true);
  });
});

describe('permits', () => {
  it('matches email trimmed and lowercased on both sides', () => {
    expect(permits({ users: ['  Jon@Apro.IS '] }, caller(' JON@apro.is  '))).toBe(true);
    expect(permits({ users: ['jon@apro.is'] }, caller('other@apro.is'))).toBe(false);
  });

  it('matches group names exactly, keeping Icelandic letters and case', () => {
    expect(permits({ groups: ['Fjármálasvið'] }, caller('', 'Fjármálasvið'))).toBe(true);
    expect(permits({ groups: ['Fjármálasvið'] }, caller('', 'fjármálasvið'))).toBe(false);
  });

  it('lets either list be enough', () => {
    const rule = { groups: ['A'], users: ['a@b.is'] };
    expect(permits(rule, caller('a@b.is'))).toBe(true);
    expect(permits(rule, caller('', 'A'))).toBe(true);
  });

  it.each([
    [{}],
    [{ groups: [], users: [] }],
    [{ groups: [''], users: [''] }],
    [null],
    ['x'],
    [[]],
  ])('permits nobody for %j', (rule) => {
    expect(permits(rule, caller('', ''))).toBe(false);
    expect(permits(rule, caller('a@b.is', 'A'))).toBe(false);
  });
});

describe('createAccess', () => {
  const limits = collectLimits(yaml as unknown as TCustomConfig);
  if (!limits) {
    throw new Error('fixture has limits');
  }

  it('lets unlimited names pass and checks limited ones', () => {
    const access = createAccess(limits, caller('x@y.is'));
    expect(access.allowsSpec('open')).toBe(true);
    expect(access.allowsSpec('fjarmal')).toBe(false);
    expect(access.allowsEndpoint('Open')).toBe(true);
    expect(access.allowsEndpoint('OLLAMA')).toBe(false);
    expect(access.allowsMcpServer('other')).toBe(true);
  });

  it('reports the first refusal in the order spec, endpoint, mcpServers', () => {
    const access = createAccess(limits, caller('x@y.is'));
    const all = { spec: 'fjarmal', endpoint: 'agents', mcpServers: ['sindri'] };
    expect(access.check(all)).toEqual({ kind: 'spec', name: 'fjarmal' });
    expect(access.check({ ...all, spec: 'open' })).toEqual({ kind: 'endpoint', name: 'agents' });
    expect(access.check({ ...all, spec: null, endpoint: 'Open' })).toEqual({
      kind: 'mcpServer',
      name: 'sindri',
    });
    expect(access.check({ spec: 'open', endpoint: 'Open', mcpServers: ['z'] })).toBeNull();
  });

  it('passes a permitted caller', () => {
    const access = createAccess(limits, caller('jon@apro.is', 'Þjónusta'));
    expect(
      access.check({ spec: 'fjarmal', endpoint: 'agents', mcpServers: ['sindri'] }),
    ).toBeNull();
  });
});

describe('configSchema', () => {
  it('accepts allowedFor on a spec, built-in and custom endpoint, azure and an mcp server', () => {
    const azure = {
      groups: [{ group: 'g', apiKey: 'k', instanceName: 'i', models: { m: true } }],
      allowedFor: { groups: ['G'] },
    };
    const result = configSchema.strict().safeParse({
      ...yaml,
      endpoints: {
        ...yaml.endpoints,
        azureOpenAI: azure,
        openAI: { allowedFor: { users: ['a@b.is'] } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('drops allowedFor from endpoints.all so a typo cannot limit everything', () => {
    const result = configSchema.safeParse({
      version: '1.3.0',
      cache: true,
      endpoints: { all: { allowedFor: { users: ['a@b.is'] } } },
    });
    expect(result.success).toBe(true);
    expect(collectLimits(result.success ? result.data : null)).toBeNull();
  });

  it('rejects a wrong-shaped allowedFor', () => {
    expect(
      configSchema
        .strict()
        .safeParse({ version: '1.3.0', cache: true, endpoints: { agents: { allowedFor: 'x' } } })
        .success,
    ).toBe(false);
  });
});
