import { SearchError } from '@librechat/data-schemas';
import { createSharedRead } from './window';

type Entry = { rows: number };

describe('createSharedRead', () => {
  const never = () => new Promise<Entry>(() => undefined);
  const shared = (overrides = {}) =>
    createSharedRead<Entry>({
      ttlMs: 30_000,
      maxBytes: 1_000_000,
      sizeOf: () => 100,
      ...overrides,
    });
  const live = () => new AbortController().signal;

  it('runs one read for two waiters on one key', async () => {
    const read = shared();
    const start = jest.fn(async () => ({ rows: 1 }));

    const [first, second] = await Promise.all([
      read.get('key', live(), start),
      read.get('key', live(), start),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('serves a finished read for 30 seconds, not after', async () => {
    let now = 0;
    const read = shared({ now: () => now });
    const start = jest.fn(async () => ({ rows: 1 }));

    await read.get('key', live(), start);
    now = 29_999;
    await read.get('key', live(), start);
    expect(start).toHaveBeenCalledTimes(1);

    now = 30_000;
    await read.get('key', live(), start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('drops an expired entry with no later search', async () => {
    jest.useFakeTimers();
    try {
      let now = 0;
      const read = shared({ now: () => now });
      const start = jest.fn(async () => ({ rows: 1 }));

      await read.get('old', live(), start);
      now = 30_000;
      jest.advanceTimersByTime(30_000);
      /* Back inside its window: only a removed entry reads again. */
      now = 1;
      await read.get('old', live(), start);

      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps keys apart', async () => {
    const read = shared();
    const start = jest.fn(async () => ({ rows: 1 }));
    await read.get('a', live(), start);
    await read.get('b', live(), start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('stores no failure', async () => {
    const read = shared();
    const start = jest
      .fn<Promise<Entry>, [AbortSignal]>()
      .mockRejectedValueOnce(new SearchError('search_failed'))
      .mockResolvedValue({ rows: 1 });

    await expect(read.get('key', live(), start)).rejects.toMatchObject({ code: 'search_failed' });
    await expect(read.get('key', live(), start)).resolves.toEqual({ rows: 1 });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('one waiter leaving does not fail the other', async () => {
    const read = shared();
    let finish: (entry: Entry) => void = () => undefined;
    let inner: AbortSignal | undefined;
    const start = (signal: AbortSignal) => {
      inner = signal;
      return new Promise<Entry>((resolve) => {
        finish = resolve;
      });
    };
    const leaving = new AbortController();

    const left = read.get('key', leaving.signal, start);
    const staying = read.get('key', live(), start);
    leaving.abort();

    await expect(left).rejects.toMatchObject({ code: 'search_busy' });
    expect(inner?.aborted).toBe(false);

    finish({ rows: 3 });
    await expect(staying).resolves.toEqual({ rows: 3 });
  });

  it('aborts the read when the last waiter leaves, and starts a new one after', async () => {
    const read = shared();
    let inner: AbortSignal | undefined;
    const first = new AbortController();
    const second = new AbortController();
    const start = (signal: AbortSignal) => {
      inner = signal;
      return never();
    };

    const one = read.get('key', first.signal, start);
    const two = read.get('key', second.signal, start);
    first.abort();
    second.abort();

    await expect(one).rejects.toMatchObject({ code: 'search_busy' });
    await expect(two).rejects.toMatchObject({ code: 'search_busy' });
    expect(inner?.aborted).toBe(true);

    await expect(read.get('key', live(), async () => ({ rows: 9 }))).resolves.toEqual({ rows: 9 });
  });

  it('turns away a waiter already gone, and starts nothing', async () => {
    const read = shared();
    const controller = new AbortController();
    controller.abort();
    const start = jest.fn(async () => ({ rows: 1 }));
    await expect(read.get('key', controller.signal, start)).rejects.toMatchObject({
      code: 'search_busy',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('evicts the oldest past its byte budget, and does not store what cannot fit', async () => {
    const read = shared({ maxBytes: 250 });
    const start = jest.fn(async () => ({ rows: 1 }));

    await read.get('a', live(), start);
    await read.get('b', live(), start);
    await read.get('c', live(), start);
    expect(start).toHaveBeenCalledTimes(3);

    await read.get('c', live(), start);
    expect(start).toHaveBeenCalledTimes(3);
    await read.get('a', live(), start);
    expect(start).toHaveBeenCalledTimes(4);

    const tiny = shared({ maxBytes: 50 });
    await tiny.get('a', live(), start);
    await tiny.get('a', live(), start);
    expect(start).toHaveBeenCalledTimes(6);
  });
});
