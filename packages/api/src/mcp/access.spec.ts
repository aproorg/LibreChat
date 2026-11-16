import { ErrorTypes } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { Access } from '~/access';
import { createCheckMcpServerAccess, filterServersByAccess } from './access';
import { redactServerSecrets } from './utils';

const access = {
  allowsMcpServer: (name: string) => name !== 'sindri',
} as unknown as Access;

describe('filterServersByAccess', () => {
  const configs = { sindri: { type: 'sse' }, open: { type: 'sse' } };

  it('leaves limited servers out and keeps unlimited ones', () => {
    expect(Object.keys(filterServersByAccess(configs, access))).toEqual(['open']);
  });

  it('returns the same object when access is null', () => {
    expect(filterServersByAccess(configs, null)).toBe(configs);
  });

  it('never carries allowedFor into a client-bound config', () => {
    const redacted = redactServerSecrets({
      type: 'sse',
      url: 'https://x.test',
      allowedFor: { users: ['jon@apro.is'] },
    } as Parameters<typeof redactServerSecrets>[0]);
    expect(JSON.stringify(redacted)).not.toContain('allowedFor');
    expect(JSON.stringify(redacted)).not.toContain('jon@apro.is');
  });
});

describe('createCheckMcpServerAccess', () => {
  const run = async (getAccess: jest.Mock, serverName: string) => {
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }) } as unknown as Response;
    const next = jest.fn();
    await createCheckMcpServerAccess({ getAccess })(
      { params: { serverName } } as unknown as Request,
      res,
      next,
    );
    return { res, json, next };
  };

  it('answers 403 access_refused for a refused server', async () => {
    const { res, json, next } = await run(jest.fn().mockResolvedValue(access), 'sindri');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ type: ErrorTypes.ACCESS_REFUSED, kind: 'mcpServer' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for an allowed server', async () => {
    const { next } = await run(jest.fn().mockResolvedValue(access), 'open');
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next() when access is null', async () => {
    const { next, json } = await run(jest.fn().mockResolvedValue(null), 'sindri');
    expect(next).toHaveBeenCalledWith();
    expect(json).not.toHaveBeenCalled();
  });

  it('forwards a getAccess rejection to next(err)', async () => {
    const err = new Error('lookup failed');
    const { next, json } = await run(jest.fn().mockRejectedValue(err), 'open');
    expect(next).toHaveBeenCalledWith(err);
    expect(json).not.toHaveBeenCalled();
  });
});
