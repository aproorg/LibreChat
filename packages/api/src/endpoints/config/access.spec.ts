import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { createEndpointsConfigService } from './endpoints';
import { filterModelsByAccess } from './access';
import { createAccess } from '~/access';

const access = createAccess(
  {
    specs: new Map(),
    endpoints: new Map([['Mistral', { users: ['a@x.is'] }]]),
    mcpServers: new Map(),
  },
  { email: 'b@x.is', groups: new Set() },
);

const deps = () => ({
  getAppConfig: jest.fn().mockResolvedValue({} as AppConfig),
  loadDefaultEndpointsConfig: jest
    .fn()
    .mockResolvedValue({ [EModelEndpoint.openAI]: { userProvide: false } }),
  loadCustomEndpointsConfig: jest.fn().mockReturnValue({ Mistral: { userProvide: false } }),
});
const req = { user: { id: 'u1' } } as ServerRequest;

describe('endpoints access filtering', () => {
  it('drops a limited endpoint and keeps unlimited ones', async () => {
    const { getEndpointsConfig } = createEndpointsConfigService({
      ...deps(),
      getAccess: async () => access,
    });
    const result = await getEndpointsConfig(req);
    expect(result?.Mistral).toBeUndefined();
    expect(result?.[EModelEndpoint.openAI]).toBeDefined();
  });

  it('does not filter without the dep or with null access', async () => {
    const a = await createEndpointsConfigService(deps()).getEndpointsConfig(req);
    const b = await createEndpointsConfigService({
      ...deps(),
      getAccess: async () => null,
    }).getEndpointsConfig(req);
    expect(a?.Mistral).toBeDefined();
    expect(b?.Mistral).toBeDefined();
  });
});

describe('filterModelsByAccess', () => {
  const models = { openAI: ['gpt'], Mistral: ['m1'] };
  it('drops the model list of a limited endpoint', () => {
    expect(filterModelsByAccess(models, access)).toEqual({ openAI: ['gpt'] });
  });
  it('returns the input for null access', () => {
    expect(filterModelsByAccess(models, null)).toBe(models);
  });
});
