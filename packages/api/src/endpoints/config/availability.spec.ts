import { EModelEndpoint, normalizeEndpointName } from 'librechat-data-provider';
import type { TConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import {
  declaredModelNames,
  hasModelSource,
  filterManagedEndpoints,
  withholdEmptyEndpoints,
} from './availability';
import { createLoadConfigModels } from './models';

const GATEWAY = {
  baseURL: 'https://gateway.example.com/v1',
  apiKey: 'gateway-key',
};

/** One gateway, several endpoints over it — the shape `filter` exists for. */
const buildAppConfig = (endpoints: Record<string, unknown>[]) => ({
  endpoints: {
    [EModelEndpoint.custom]: endpoints.map((endpoint) => ({ ...GATEWAY, ...endpoint })),
  },
});

const buildRequest = () =>
  ({ user: { id: 'user-1' }, config: undefined }) as unknown as ServerRequest;

const load = (endpoints: Record<string, unknown>[], fetchModels: jest.Mock) =>
  createLoadConfigModels({
    getAppConfig: jest.fn().mockResolvedValue(buildAppConfig(endpoints)),
    getUserKeyValues: jest.fn().mockResolvedValue(null),
    fetchModels,
  })(buildRequest());

describe('declaredModelNames', () => {
  it('normalizes both string and object model entries', () => {
    expect(
      declaredModelNames({
        models: { default: ['a', { name: 'b', description: 'B' }] },
      } as never),
    ).toEqual(['a', 'b']);
  });

  it('treats a missing or malformed list as no declaration', () => {
    expect(declaredModelNames(undefined)).toEqual([]);
    expect(declaredModelNames({ models: { default: [] } } as never)).toEqual([]);
    expect(declaredModelNames({ models: {} } as never)).toEqual([]);
  });
});

describe('hasModelSource', () => {
  it('is true for a fetching endpoint even with nothing declared', () => {
    expect(hasModelSource({ models: { default: [], fetch: true } } as never)).toBe(true);
  });

  it('is true for a declared list with no fetch', () => {
    expect(hasModelSource({ models: { default: ['a'] } } as never)).toBe(true);
  });

  it('is false for an empty declaration with no fetch, where a truthiness test would pass', () => {
    const endpoint = { models: { default: [] } } as never;
    expect(Boolean((endpoint as { models: { default: string[] } }).models.default)).toBe(true);
    expect(hasModelSource(endpoint)).toBe(false);
  });
});

describe('loadConfigModels – declared ∩ fetched', () => {
  let fetchModels: jest.Mock;

  beforeEach(() => {
    fetchModels = jest.fn();
  });

  it('serves only declared models the gateway actually has, in declared order', async () => {
    fetchModels.mockResolvedValue(['gpt-5.6', 'claude-sonnet-5', 'cohere-rerank']);

    const result = await load(
      [
        {
          name: 'Claude',
          models: { default: ['claude-opus-5', 'claude-sonnet-5'], fetch: true, filter: true },
        },
      ],
      fetchModels,
    );

    expect(result.Claude).toEqual(['claude-sonnet-5']);
  });

  it('gives endpoints over one gateway their own slice from a single fetch', async () => {
    fetchModels.mockResolvedValue(['claude-sonnet-5', 'gpt-5.6', 'gemini-3.7-flash']);

    const result = await load(
      [
        { name: 'Claude', models: { default: ['claude-sonnet-5'], fetch: true, filter: true } },
        { name: 'OpenAI', models: { default: ['gpt-5.6'], fetch: true, filter: true } },
      ],
      fetchModels,
    );

    expect(result.Claude).toEqual(['claude-sonnet-5']);
    expect(result.OpenAI).toEqual(['gpt-5.6']);
    /* Same baseURL, apiKey and headers: one coalesced fetch serves both. */
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('resolves to nothing when the gateway answers with an empty catalog', async () => {
    fetchModels.mockResolvedValue([]);

    const result = await load(
      [{ name: 'Claude', models: { default: ['claude-sonnet-5'], fetch: true, filter: true } }],
      fetchModels,
    );

    expect(result.Claude).toEqual([]);
  });

  it('does not need an authorization header to fail closed on an empty answer', async () => {
    fetchModels.mockResolvedValue([]);

    const result = await load(
      [
        {
          name: 'Claude',
          headers: { 'x-user-email': '{{LIBRECHAT_USER_EMAIL}}' },
          models: { default: ['claude-sonnet-5'], fetch: true, filter: true },
        },
      ],
      fetchModels,
    );

    expect(result.Claude).toEqual([]);
  });

  it('falls back to the declared list when the fetch fails outright', async () => {
    fetchModels.mockRejectedValue(new Error('gateway unreachable'));

    const result = await load(
      [
        {
          name: 'Claude',
          models: { default: ['claude-opus-5', 'claude-sonnet-5'], fetch: true, filter: true },
        },
      ],
      fetchModels,
    );

    expect(result.Claude).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('fails open on a failed fetch even when the endpoint sends an authorization header', async () => {
    fetchModels.mockRejectedValue(new Error('gateway unreachable'));

    const result = await load(
      [
        {
          name: 'Claude',
          headers: { authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}' },
          models: { default: ['claude-sonnet-5'], fetch: true, filter: true },
        },
      ],
      fetchModels,
    );

    expect(result.Claude).toEqual(['claude-sonnet-5']);
  });

  it('leaves the declared list alone when there is no fetch to intersect', async () => {
    const result = await load(
      [{ name: 'Claude', models: { default: ['claude-sonnet-5'], filter: true } }],
      fetchModels,
    );

    expect(result.Claude).toEqual(['claude-sonnet-5']);
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it('skips an endpoint that declares nothing and fetches nothing', async () => {
    const result = await load(
      [
        { name: 'Other', models: { default: [], filter: true } },
        { name: 'Claude', models: { default: ['claude-sonnet-5'] } },
      ],
      fetchModels,
    );

    expect(result).not.toHaveProperty('Other');
    expect(result.Claude).toEqual(['claude-sonnet-5']);
  });
});

describe('loadConfigModels – endpoints without `filter` are unchanged', () => {
  let fetchModels: jest.Mock;

  beforeEach(() => {
    fetchModels = jest.fn();
  });

  it('replaces the declared list with the fetched catalog', async () => {
    fetchModels.mockResolvedValue(['gpt-5.6', 'cohere-rerank']);

    const result = await load(
      [{ name: 'LiteLLM', models: { default: ['stale-name'], fetch: true } }],
      fetchModels,
    );

    expect(result.LiteLLM).toEqual(['gpt-5.6', 'cohere-rerank']);
  });

  it('keeps the OIDC empty-answer behaviour: authorization header yields nothing', async () => {
    fetchModels.mockResolvedValue([]);

    const result = await load(
      [
        {
          name: 'LiteLLM',
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}' },
          models: { default: ['claude-sonnet-5'], fetch: true },
        },
      ],
      fetchModels,
    );

    expect(result.LiteLLM).toEqual([]);
  });

  it('keeps the fallback to declared models on an empty answer without that header', async () => {
    fetchModels.mockResolvedValue([]);

    const result = await load(
      [{ name: 'LiteLLM', models: { default: ['claude-sonnet-5'], fetch: true } }],
      fetchModels,
    );

    expect(result.LiteLLM).toEqual(['claude-sonnet-5']);
  });
});

describe('filterManagedEndpoints', () => {
  const appConfig = (endpoints: Record<string, unknown>[]) =>
    ({ endpoints: { [EModelEndpoint.custom]: endpoints } }) as never;

  it('collects only endpoints that both filter and fetch', () => {
    const managed = filterManagedEndpoints(
      appConfig([
        { name: 'Claude', models: { default: ['a'], fetch: true, filter: true } },
        { name: 'Gemini', models: { default: ['b'], fetch: true, filter: true } },
        { name: 'Plain', models: { default: ['c'], fetch: true } },
      ]),
    );

    expect([...managed].sort()).toEqual(['Claude', 'Gemini']);
  });

  it('excludes `filter` without `fetch` — there is no catalog to intersect', () => {
    const managed = filterManagedEndpoints(
      appConfig([{ name: 'Claude', models: { default: ['a'], filter: true } }]),
    );

    expect(managed.size).toBe(0);
  });

  it('keys by the normalized endpoint name, as the models config is', () => {
    const managed = filterManagedEndpoints(
      appConfig([{ name: ' Claude ', models: { default: ['a'], fetch: true, filter: true } }]),
    );

    expect(managed.has(normalizeEndpointName(' Claude '))).toBe(true);
  });

  it('is empty for a config with no custom endpoints at all', () => {
    expect(filterManagedEndpoints(undefined).size).toBe(0);
    expect(filterManagedEndpoints(null).size).toBe(0);
    expect(filterManagedEndpoints({ endpoints: {} } as never).size).toBe(0);
  });
});

describe('withholdEmptyEndpoints', () => {
  const custom = (extra: Partial<TConfig> = {}): TConfig =>
    ({ order: 0, type: EModelEndpoint.custom, userProvide: false, ...extra }) as TConfig;
  const managed = (...names: string[]) => new Set(names);

  it('withholds nothing when no endpoint is filter-managed', () => {
    const endpointsConfig = { Anthropic: custom(), Google: custom() };
    const result = withholdEmptyEndpoints(
      endpointsConfig,
      { Anthropic: ['claude-sonnet-5'], Google: [] },
      managed(),
    );

    expect(result).toBe(endpointsConfig);
  });

  it('leaves an empty endpoint alone when it is not the one filtering', () => {
    const result = withholdEmptyEndpoints(
      { Filtered: custom(), Plain: custom() },
      { Filtered: ['claude-sonnet-5'], Plain: [] },
      managed('Filtered'),
    );

    expect(result?.Plain).toBeDefined();
  });

  it('drops a filter-managed endpoint whose model list is empty', () => {
    const result = withholdEmptyEndpoints(
      { Anthropic: custom(), Google: custom() },
      { Anthropic: ['claude-sonnet-5'], Google: [] },
      managed('Anthropic', 'Google'),
    );

    expect(result?.Anthropic).toBeDefined();
    expect(result).not.toHaveProperty('Google');
  });

  it('keeps every endpoint that has at least one model', () => {
    const result = withholdEmptyEndpoints(
      { Anthropic: custom(), Google: custom() },
      { Anthropic: ['claude-sonnet-5'], Google: ['gemini-3-pro'] },
      managed('Anthropic', 'Google'),
    );

    expect(Object.keys(result ?? {})).toEqual(['Anthropic', 'Google']);
  });

  it('never withholds a user-provided endpoint — its empty list reflects a fixable key', () => {
    const result = withholdEmptyEndpoints(
      {
        Shared: custom(),
        BYOK: custom({ userProvide: true }),
        ByURL: custom({ userProvideURL: true }),
      },
      { Shared: [], BYOK: [], ByURL: [] },
      managed('Shared', 'BYOK', 'ByURL'),
    );

    expect(result).not.toHaveProperty('Shared');
    expect(result?.BYOK).toBeDefined();
    expect(result?.ByURL).toBeDefined();
  });

  it('never withholds a built-in endpoint, whatever the models config says', () => {
    const result = withholdEmptyEndpoints(
      { [EModelEndpoint.openAI]: { order: 0 } as TConfig, Google: custom() },
      { [EModelEndpoint.openAI]: [], Google: [] },
      managed(EModelEndpoint.openAI, 'Google'),
    );

    expect(result?.[EModelEndpoint.openAI]).toBeDefined();
    expect(result).not.toHaveProperty('Google');
  });

  it('fails open when there is no models config to judge against', () => {
    const endpointsConfig = { Google: custom() };

    expect(withholdEmptyEndpoints(endpointsConfig, null, managed('Google'))).toBe(endpointsConfig);
    expect(withholdEmptyEndpoints(endpointsConfig, undefined, managed('Google'))).toBe(
      endpointsConfig,
    );
  });

  it('fails open for an endpoint the models config has no entry for', () => {
    const result = withholdEmptyEndpoints(
      { Anthropic: custom(), Google: custom() },
      { Anthropic: ['claude-sonnet-5'] },
      managed('Anthropic', 'Google'),
    );

    expect(result?.Google).toBeDefined();
  });

  it('preserves endpoint order, which the caller has already resolved', () => {
    const result = withholdEmptyEndpoints(
      { First: custom(), Dropped: custom(), Second: custom() },
      { First: ['a'], Dropped: [], Second: ['b'] },
      managed('First', 'Dropped', 'Second'),
    );

    expect(Object.keys(result ?? {})).toEqual(['First', 'Second']);
  });
});
