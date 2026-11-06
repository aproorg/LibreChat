import { createSearchLimiter } from './limiter';

describe('createSearchLimiter', () => {
  const never = () => new Promise<never>(() => undefined);

  it('fails at the cap at once, with no queue', async () => {
    const limiter = createSearchLimiter({ maxConcurrent: 1, timeoutMs: 1000 });
    const controller = new AbortController();
    const held = limiter.run(controller.signal, never);

    const start = Date.now();
    await expect(limiter.run(new AbortController().signal, async () => 'x')).rejects.toMatchObject({
      code: 'search_busy',
    });
    expect(Date.now() - start).toBeLessThan(50);

    controller.abort();
    await expect(held).rejects.toMatchObject({ code: 'search_busy' });
    expect(limiter.active()).toBe(0);
  });

  it('frees the slot after success and failure', async () => {
    const limiter = createSearchLimiter({ maxConcurrent: 1, timeoutMs: 1000 });
    const { signal } = new AbortController();

    await expect(limiter.run(signal, async () => 'one')).resolves.toBe('one');
    await expect(
      limiter.run(signal, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(limiter.active()).toBe(0);
    await expect(limiter.run(signal, async () => 'two')).resolves.toBe('two');
  });

  it('stops at the timeout, aborting the work and freeing the slot', async () => {
    const limiter = createSearchLimiter({ maxConcurrent: 1, timeoutMs: 20 });
    let inner: AbortSignal | undefined;

    await expect(
      limiter.run(new AbortController().signal, ({ signal }) => {
        inner = signal;
        return never();
      }),
    ).rejects.toMatchObject({ code: 'search_busy' });

    expect(inner?.aborted).toBe(true);
    expect(limiter.active()).toBe(0);
  });

  it('hands the work a deadline at the timeout', async () => {
    const limiter = createSearchLimiter({ maxConcurrent: 1, timeoutMs: 1000 });
    const before = Date.now();
    const deadline = await limiter.run(
      new AbortController().signal,
      async (scope) => scope.deadline,
    );
    expect(deadline).toBeGreaterThanOrEqual(before + 1000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
