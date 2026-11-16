import { ErrorTypes } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { AccessLimits } from '~/access';
import { createCheckEndpointAccess, createCheckSendAccess } from './refuse';
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

  describe('addedConvo', () => {
    const added = (addedConvo: Record<string, unknown>) => ({ endpoint: 'openAI', addedConvo });

    it.each([
      ['spec', { spec: 'Fjarmal' }, 'spec'],
      ['endpoint', { endpoint: 'Mistral' }, 'endpoint'],
      ['ephemeral MCP server', { ephemeralAgent: { mcp: ['sindri'] } }, 'mcpServer'],
    ])('refuses a limited %s', async (_name, addedConvo, kind) => {
      const { res, next } = await run(jest.fn().mockResolvedValue(outsider), added(addedConvo));
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json.mock.calls[0][0].kind).toBe(kind);
    });

    it('refuses an open added spec that pins a limited tool server', async () => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      const next = jest.fn();
      const req = {
        body: added({ spec: 'Open' }),
        config: { modelSpecs: { list: [{ name: 'Open', mcpServers: ['sindri'] }] } },
      };
      await createCheckSendAccess({ getAccess: jest.fn().mockResolvedValue(outsider) })(
        req as unknown as Request,
        res as unknown as Response,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('lets a permitted caller through', async () => {
      const { res, next } = await run(
        jest.fn().mockResolvedValue(insider),
        added({ spec: 'Fjarmal', endpoint: 'Mistral', ephemeralAgent: { mcp: ['sindri'] } }),
      );
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});

describe('createCheckEndpointAccess', () => {
  const guard = async (getAccess: jest.Mock, endpoint: string | null = 'Mistral') => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await createCheckEndpointAccess({ getAccess, getEndpoint: () => endpoint })(
      {} as Request,
      res as unknown as Response,
      next,
    );
    return { res, next };
  };

  it('refuses a limited endpoint with the 403 body', async () => {
    const { res, next } = await guard(jest.fn().mockResolvedValue(outsider));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      type: ErrorTypes.ACCESS_REFUSED,
      kind: 'endpoint',
      message: 'You do not have access to this endpoint.',
    });
  });

  it('lets a permitted caller, an open endpoint and a missing endpoint through', async () => {
    for (const [access, endpoint] of [
      [insider, 'Mistral'],
      [outsider, 'openAI'],
      [outsider, null],
    ] as const) {
      const { res, next } = await guard(jest.fn().mockResolvedValue(access), endpoint);
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('reads the endpoint from the body or the query by default', async () => {
    for (const req of [{ body: { endpoint: 'Mistral' } }, { query: { endpoint: 'Mistral' } }]) {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      const next = jest.fn();
      await createCheckEndpointAccess({ getAccess: jest.fn().mockResolvedValue(outsider) })(
        req as unknown as Request,
        res as unknown as Response,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it('passes straight through without limits', async () => {
    const { next } = await guard(jest.fn().mockResolvedValue(null));
    expect(next).toHaveBeenCalledWith();
  });

  it('forwards a getAccess rejection to next(err)', async () => {
    const err = new Error('lookup failed');
    const { res, next } = await guard(jest.fn().mockRejectedValue(err));
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
