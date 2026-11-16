import { ErrorTypes } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { AccessLimits } from '~/access';
import { createCheckSendAccess } from './refuse';
import { createAccess } from '~/access';

const limits: AccessLimits = {
  specs: new Map([['Fjarmal', { users: ['boss@x.is'] }]]),
  endpoints: new Map([['Mistral', { users: ['boss@x.is'] }]]),
  mcpServers: new Map([['sindri', { groups: ['Þjónusta'] }]]),
};
const outsider = createAccess(limits, { email: 'a@x.is', groups: new Set() });
const insider = createAccess(limits, { email: ' BOSS@x.is ', groups: new Set(['Þjónusta']) });

const run = async (getAccess: jest.Mock, body: Record<string, unknown>) => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await createCheckSendAccess({ getAccess })({ body } as Request, res as unknown as Response, next);
  return { res, next };
};

describe('createCheckSendAccess', () => {
  it('refuses a limited spec with the 403 body', async () => {
    const { res, next } = await run(jest.fn().mockResolvedValue(outsider), { spec: 'Fjarmal' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      type: ErrorTypes.ACCESS_REFUSED,
      kind: 'spec',
      message: 'You do not have access to this model.',
    });
  });

  it('refuses a limited endpoint', async () => {
    const { res } = await run(jest.fn().mockResolvedValue(outsider), { endpoint: 'Mistral' });
    expect(res.json.mock.calls[0][0].kind).toBe('endpoint');
  });

  it('refuses a limited ephemeral MCP server', async () => {
    const { res } = await run(jest.fn().mockResolvedValue(outsider), {
      endpoint: 'openAI',
      ephemeralAgent: { mcp: ['other', 'sindri'] },
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].kind).toBe('mcpServer');
  });

  it('lets a permitted caller through and writes nothing', async () => {
    const { res, next } = await run(jest.fn().mockResolvedValue(insider), {
      spec: 'Fjarmal',
      endpoint: 'Mistral',
      ephemeralAgent: { mcp: ['sindri'] },
    });
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('passes straight through when the file has no limits', async () => {
    const getAccess = jest.fn().mockResolvedValue(null);
    const { res, next } = await run(getAccess, { spec: 'Fjarmal' });
    expect(getAccess).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('forwards a getAccess rejection to next(err)', async () => {
    const err = new Error('lookup failed');
    const { res, next } = await run(jest.fn().mockRejectedValue(err), { spec: 'Fjarmal' });
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
  it('refuses an open spec that pins a limited tool server or endpoint', async () => {
    for (const spec of [
      { name: 'Open', preset: { endpoint: 'openAI' }, mcpServers: ['sindri'] },
      { name: 'Open', preset: { endpoint: 'Mistral' } },
    ]) {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      const next = jest.fn();
      const req = { body: { spec: 'Open' }, config: { modelSpecs: { list: [spec] } } };
      await createCheckSendAccess({ getAccess: jest.fn().mockResolvedValue(outsider) })(
        req as unknown as Request,
        res as unknown as Response,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });
});
