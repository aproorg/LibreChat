import express from 'express';
import { SearchError } from '@librechat/data-schemas';
import { createServer, request as httpRequest } from 'node:http';
import type { SearchContext } from '@librechat/data-schemas';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSearchContext } from './context';
import { searchErrorResponse } from './errors';

describe('createSearchContext', () => {
  let server: Server;
  let contexts: SearchContext[];
  let finished: Promise<void>;
  let onFinished: () => void;
  const hold = { release: () => {} };

  beforeEach(async () => {
    contexts = [];
    finished = new Promise((resolve) => {
      onFinished = resolve;
    });
    const app = express();
    app.get('/done', (req, res) => {
      (req as unknown as { user: { id: string } }).user = { id: 'session-user' };
      contexts.push(createSearchContext(req as never, res));
      res.on('close', () => onFinished());
      res.json({ ok: true });
    });
    app.get('/hold', (req, res) => {
      (req as unknown as { user: { id: string } }).user = { id: 'session-user' };
      contexts.push(createSearchContext(req as never, res));
      res.on('close', () => onFinished());
      hold.release = () => res.end();
      res.flushHeaders();
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const port = () => (server.address() as AddressInfo).port;

  it('takes the user from the session and records its start', async () => {
    const response = await fetch(`http://127.0.0.1:${port()}/done?user=forged`);
    await response.json();
    await finished;
    expect(contexts[0].user).toBe('session-user');
    expect(contexts[0].startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('does not fire when a response completes normally', async () => {
    const response = await fetch(`http://127.0.0.1:${port()}/done`);
    await response.json();
    await finished;
    expect(contexts[0].signal.aborted).toBe(false);
  });

  it('fires on a real disconnect', async () => {
    const request = httpRequest(`http://127.0.0.1:${port()}/hold`);
    request.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      request.on('response', () => resolve());
      request.end();
    });
    request.destroy();
    await finished;
    expect(contexts[0].signal.aborted).toBe(true);
  });
});

describe('searchErrorResponse', () => {
  it.each([
    ['search_busy', 503],
    ['search_failed', 500],
    ['search_cursor_invalid', 400],
  ] as const)('maps %s to %i with only the code', (code, status) => {
    expect(searchErrorResponse(new SearchError(code))).toEqual({ status, body: { code } });
  });

  it('never forwards raw text', () => {
    const response = searchErrorResponse(new Error('SENTINEL raw driver text'));
    expect(response).toEqual({ status: 500, body: { code: 'search_failed' } });
  });
});
