const express = require('express');
const request = require('supertest');
const {
  resolveHeaders,
  createSafeUser,
  OMIT_UNAVAILABLE_OPENID_HEADERS,
} = require('@librechat/api');

let mockSeen;
let mockAuthUser;

jest.mock('~/server/controllers/agents/openai', () => ({
  OpenAIChatCompletionController: (req, res) => res.sendStatus(200),
  GetModelController: (req, res) => res.sendStatus(200),
  ListModelsController: (req, res) => {
    mockSeen = req.user;
    res.sendStatus(200);
  },
}));
jest.mock('~/server/middleware', () => ({
  requireTermsAcceptance: (req, res, next) => next(),
  agentEventUserLimiter: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
}));
jest.mock('~/server/services/Agents/triggers', () => ({
  enqueueAgentTrigger: jest.fn(),
  getAgentTriggerDeliveryStatus: jest.fn(),
}));
jest.mock('~/models', () => ({}));
jest.mock('../middleware', () => ({
  checkAgentPermission: (req, res, next) => next(),
  checkAgentTriggerPermission: (req, res, next) => next(),
  preAuthTenantMiddleware: (req, res, next) => next(),
  checkRemoteAgentsFeature: (req, res, next) => next(),
  requireRemoteAgentAuth: (req, res, next) => {
    req.user = mockAuthUser ? { ...mockAuthUser } : undefined;
    next();
  },
}));

const openai = require('../openai');

const headers = {
  authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}',
  'x-openid-access-token': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
  'x-user-email': '{{LIBRECHAT_USER_EMAIL}}',
};
const CALLER_TOKEN = 'caller-bearer';
const baseUser = { id: 'u1', email: 'me@example.com', provider: 'openid', openidId: 'sub' };
const oidcUser = {
  ...baseUser,
  federatedTokens: { access_token: CALLER_TOKEN, expires_at: Math.floor(Date.now() / 1000) + 3600 },
};

async function call(user) {
  mockAuthUser = user;
  mockSeen = undefined;
  const app = express();
  app.use('/v1', openai);
  await request(app).get('/v1/models');
  return mockSeen;
}

describe('agents/openai.js REMOTE_AGENTS_OMIT_UNAVAILABLE_OPENID_HEADERS', () => {
  afterEach(() => {
    delete process.env.REMOTE_AGENTS_OMIT_UNAVAILABLE_OPENID_HEADERS;
  });

  it('flag on, API key: omits credential headers, keeps x-user-email', async () => {
    process.env.REMOTE_AGENTS_OMIT_UNAVAILABLE_OPENID_HEADERS = 'true';
    const user = await call(baseUser);
    expect(user[OMIT_UNAVAILABLE_OPENID_HEADERS]).toBe(true);
    expect(resolveHeaders({ headers, user: createSafeUser(user), stripUnresolved: true })).toEqual({
      'x-user-email': 'me@example.com',
    });
  });

  it('flag on, OIDC: caller bearer reaches no header but federatedTokens stays for MCP OBO', async () => {
    process.env.REMOTE_AGENTS_OMIT_UNAVAILABLE_OPENID_HEADERS = 'true';
    const user = await call(oidcUser);
    const result = resolveHeaders({ headers, user: createSafeUser(user), stripUnresolved: true });
    expect(result).toEqual({ 'x-user-email': 'me@example.com' });
    expect(JSON.stringify(result)).not.toContain(CALLER_TOKEN);
    expect(user.federatedTokens.access_token).toBe(CALLER_TOKEN);
  });

  it('flag off: req.user untouched and the bearer still resolves (pins current behaviour)', async () => {
    const user = await call(oidcUser);
    expect(user[OMIT_UNAVAILABLE_OPENID_HEADERS]).toBeUndefined();
    expect(
      resolveHeaders({
        headers: { a: headers['x-openid-access-token'] },
        user: createSafeUser(user),
      }),
    ).toEqual({ a: CALLER_TOKEN });
  });

  it('flag on but auth rejected (no req.user): does nothing', async () => {
    process.env.REMOTE_AGENTS_OMIT_UNAVAILABLE_OPENID_HEADERS = 'true';
    expect(await call(undefined)).toBeUndefined();
  });
});
