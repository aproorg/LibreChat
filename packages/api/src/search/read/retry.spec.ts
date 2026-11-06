import { SearchError } from '@librechat/data-schemas';
import type { SearchMetricsLogger } from '../metrics';
import { createReadGate, createReadRunner } from './retry';
import { createSearchMetrics } from '../metrics';

const cursorLimit = () => Object.assign(new Error('Cannot open a new cursor'), { code: 2 });

describe('createReadRunner', () => {
  let events: Array<{ event: string; meta: object }>;
  let runnerLogger: { warn: jest.Mock };

  const metricsLogger: SearchMetricsLogger = {
    info: (event, meta) => events.push({ event, meta }),
    warn: (event, meta) => events.push({ event, meta }),
  };

  const runner = (overrides: Partial<Parameters<typeof createReadRunner>[0]> = {}) =>
    createReadRunner({
      surface: 'messages',
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
      gate: createReadGate(2),
      metrics: createSearchMetrics(metricsLogger),
      logger: runnerLogger,
      sleep: async () => undefined,
      ...overrides,
    });

  beforeEach(() => {
    events = [];
    runnerLogger = { warn: jest.fn() };
  });

  it('applies the signal and the remaining time to each read', async () => {
    const { signal } = new AbortController();
    const read = jest.fn(async () => 'rows');

    await expect(runner({ signal })(read)).resolves.toBe('rows');

    const [options] = read.mock.calls[0] as unknown as [{ maxTimeMS: number; signal: AbortSignal }];
    expect(options.signal).toBe(signal);
    expect(options.maxTimeMS).toBeGreaterThan(4000);
    expect(options.maxTimeMS).toBeLessThanOrEqual(5000);
  });

  it('retries the cursor limit twice with jitter, then succeeds', async () => {
    const sleep = jest.fn(async () => undefined);
    const read = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(cursorLimit())
      .mockRejectedValueOnce(cursorLimit())
      .mockResolvedValue('rows');

    await expect(runner({ sleep })(read)).resolves.toBe('rows');

    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { event: 'search.cursor_error', meta: { surface: 'messages', retries: 0, final: false } },
      { event: 'search.cursor_error', meta: { surface: 'messages', retries: 1, final: false } },
    ]);
  });

  it('raises search_busy after two retries, and says the last was final', async () => {
    const read = jest.fn(async () => {
      throw cursorLimit();
    });

    await expect(runner()(read)).rejects.toMatchObject({ code: 'search_busy' });

    expect(read).toHaveBeenCalledTimes(3);
    expect(events[events.length - 1]).toEqual({
      event: 'search.cursor_error',
      meta: { surface: 'messages', retries: 2, final: true },
    });
  });

  it('does not retry code 2 with another message', async () => {
    const read = jest.fn(async () => {
      throw Object.assign(new Error('BadValue'), { code: 2 });
    });

    await expect(runner()(read)).rejects.toMatchObject({ code: 'search_failed' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('maps a server time limit to search_busy', async () => {
    const read = async () => {
      throw Object.assign(new Error('operation exceeded time limit'), { code: 50 });
    };
    await expect(runner()(read)).rejects.toMatchObject({ code: 'search_busy' });
  });

  it('stops at the deadline, even when the read never answers', async () => {
    const read = () => new Promise<string>(() => undefined);
    await expect(runner({ deadline: Date.now() + 20 })(read)).rejects.toMatchObject({
      code: 'search_busy',
    });
  });

  it('runs no read past the deadline or after the signal fired', async () => {
    const read = jest.fn(async () => 'rows');
    const controller = new AbortController();
    controller.abort();

    await expect(runner({ deadline: Date.now() - 1 })(read)).rejects.toMatchObject({
      code: 'search_busy',
    });
    await expect(runner({ signal: controller.signal })(read)).rejects.toMatchObject({
      code: 'search_busy',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('stops when the signal fires mid-read', async () => {
    const controller = new AbortController();
    const pending = runner({ signal: controller.signal })(() => new Promise(() => undefined));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'search_busy' });
  });

  it('maps anything else to search_failed, with no raw text anywhere', async () => {
    const sentinel = 'SENTINEL_RAW_DRIVER_TEXT';
    const failure = await runner()(async () => {
      throw new Error(sentinel);
    }).catch((error: unknown) => error as Error);

    expect(failure).toMatchObject({ name: 'SearchError', code: 'search_failed' });
    expect((failure as Error).message).not.toContain(sentinel);
    expect(JSON.stringify(runnerLogger.warn.mock.calls)).not.toContain(sentinel);
    expect(runnerLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('passes a SearchError through untouched', async () => {
    await expect(
      runner()(async () => {
        throw new SearchError('search_cursor_invalid');
      }),
    ).rejects.toMatchObject({ code: 'search_cursor_invalid' });
  });

  it('holds its gate: no more than the limit at once', async () => {
    const run = runner({ gate: createReadGate(2) });
    let active = 0;
    let highest = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        run(async () => {
          active += 1;
          highest = Math.max(highest, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(highest).toBe(2);
  });

  it('frees its gate on a stopped read', async () => {
    const gate = createReadGate(1);
    const controller = new AbortController();
    const stuck = runner({ gate, signal: controller.signal })(() => new Promise(() => undefined));
    controller.abort();
    await expect(stuck).rejects.toMatchObject({ code: 'search_busy' });
    await expect(runner({ gate })(async () => 'next')).resolves.toBe('next');
  });
});
