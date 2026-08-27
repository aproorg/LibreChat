const { EModelEndpoint } = require('librechat-data-provider');

jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: jest.fn(),
  getModelsConfig: jest.fn(),
}));

const { getEndpointsConfig, getModelsConfig } = require('~/server/services/Config');
const endpointController = require('~/server/controllers/EndpointController');

const custom = (extra = {}) => ({ order: 0, type: EModelEndpoint.custom, ...extra });

const respond = async () => {
  const res = { send: jest.fn() };
  await endpointController({}, res);
  return JSON.parse(res.send.mock.calls[0][0]);
};

describe('endpointController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('withholds a custom endpoint with no models available to the request', async () => {
    getEndpointsConfig.mockResolvedValue({ Anthropic: custom(), Google: custom() });
    getModelsConfig.mockResolvedValue({ Anthropic: ['claude-sonnet-5'], Google: [] });

    const body = await respond();

    expect(body.Anthropic).toBeDefined();
    expect(body).not.toHaveProperty('Google');
  });

  it('serves every endpoint when the models config cannot be resolved', async () => {
    getEndpointsConfig.mockResolvedValue({ Anthropic: custom(), Google: custom() });
    getModelsConfig.mockRejectedValue(new Error('gateway unreachable'));

    const body = await respond();

    expect(body.Anthropic).toBeDefined();
    expect(body.Google).toBeDefined();
  });
});
