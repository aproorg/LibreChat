import type { SearchHarness } from '../__tests__/helpers/harness';
import { createSearchHarness } from '../__tests__/helpers/harness';
import { createVocabCounter, MAX_PENDING_TOKENS } from './vocab';
import { waitFor } from './__tests__/helpers/sync';

/** T112: counts merge in memory and reach the word list only at a flush, from the holder. */
describe('the writer’s word list counts', () => {
  let harness: SearchHarness;
  const vocab = () =>
    harness.database.connection.db!.collection('search_vocab').find().sort({ _id: 1 }).toArray();

  beforeAll(async () => {
    harness = await createSearchHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it('writes nothing per message, then one merged `$inc` per token at the flush', async () => {
    const increment = jest.spyOn(harness.methods, 'incrementSearchVocab');
    const counter = createVocabCounter({
      methods: harness.methods,
      flushSeconds: 300,
      holds: () => true,
      logger: harness.logger,
    });

    counter.add(['kerfi', 'word', 'kerfi']);
    counter.add(['kerfi']);
    expect(increment).not.toHaveBeenCalled();
    expect(await vocab()).toEqual([]);

    await counter.flush();
    expect(increment).toHaveBeenCalledTimes(1);
    expect(await vocab()).toEqual([
      { _id: 'kerfi', df: 2 },
      { _id: 'word', df: 1 },
    ]);
    increment.mockRestore();
  });

  it('flushes once it holds its bound, in chunks, without waiting for the timer', async () => {
    const increment = jest.spyOn(harness.methods, 'incrementSearchVocab');
    const counter = createVocabCounter({
      methods: harness.methods,
      flushSeconds: 300,
      holds: () => true,
      logger: harness.logger,
    });

    counter.add(Array.from({ length: MAX_PENDING_TOKENS - 1 }, (_, index) => `w${index}`));
    await counter.settle();
    expect(increment).not.toHaveBeenCalled();

    counter.add(['one-more']);
    await counter.settle();

    expect(counter.pending()).toBe(0);
    expect(increment.mock.calls.length).toBeGreaterThan(1);
    expect(increment.mock.calls.every(([{ counts }]) => counts.length <= 10_000)).toBe(true);
    expect(await harness.database.connection.db!.collection('search_vocab').countDocuments()).toBe(
      MAX_PENDING_TOKENS,
    );
    increment.mockRestore();
  }, 60_000);

  it('puts back only what a failed flush did not write', async () => {
    let calls = 0;
    const counter = createVocabCounter({
      methods: {
        ...harness.methods,
        incrementSearchVocab: async (params) => {
          calls += 1;
          if (calls === 2) {
            throw new Error('write failed');
          }
          return harness.methods.incrementSearchVocab(params);
        },
      },
      flushSeconds: 300,
      holds: () => true,
      logger: harness.logger,
    });
    counter.add(Array.from({ length: 25_000 }, (_, index) => `w${index}`));

    await counter.flush();

    /* The first chunk of 10,000 is written, and the other 15,000 wait for the next flush. */
    expect(counter.pending()).toBe(15_000);
    await counter.flush();
    expect(counter.pending()).toBe(0);
    const rows = await vocab();
    expect(rows).toHaveLength(25_000);
    expect(rows.every(({ df }) => df === 1)).toBe(true);
  }, 60_000);

  it('flushes every vocabFlushSeconds, and once more on stop', async () => {
    const increment = jest.spyOn(harness.methods, 'incrementSearchVocab');
    const counter = createVocabCounter({
      methods: harness.methods,
      flushSeconds: 1,
      holds: () => true,
      logger: harness.logger,
    });
    counter.start();
    counter.add(['kerfi']);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(increment).not.toHaveBeenCalled();
    await waitFor(() => increment.mock.calls.length === 1, { timeoutMs: 3000 });

    counter.add(['word']);
    await counter.stop();
    expect(increment).toHaveBeenCalledTimes(2);
    expect(counter.pending()).toBe(0);
    increment.mockRestore();
  });

  it('writes only while this process holds the lease', async () => {
    let held = false;
    const counter = createVocabCounter({
      methods: harness.methods,
      flushSeconds: 300,
      holds: () => held,
      logger: harness.logger,
    });
    counter.add(['kerfi']);
    await counter.flush();
    expect(await vocab()).toEqual([]);

    held = true;
    counter.add(['word']);
    await counter.flush();
    expect(await vocab()).toEqual([{ _id: 'word', df: 1 }]);
  });

  it('stamps the run during a rebuild, so a new word survives its copy pass', async () => {
    await harness.methods.writeSearchState('vocab', { run: 4, status: 'running' });
    const counter = createVocabCounter({
      methods: harness.methods,
      flushSeconds: 300,
      holds: () => true,
      logger: harness.logger,
    });
    counter.add(['kerfi']);
    await counter.flush();

    expect(await vocab()).toEqual([{ _id: 'kerfi', df: 1, r: 4 }]);
  });

  it('keeps its counts through a failed flush, and logs no token', async () => {
    const methods = {
      ...harness.methods,
      incrementSearchVocab: jest.fn().mockRejectedValueOnce(new Error('kerfi')),
    };
    const counter = createVocabCounter({
      methods,
      flushSeconds: 300,
      holds: () => true,
      logger: harness.logger,
    });
    counter.add(['kerfi']);
    await counter.flush();
    expect(counter.pending()).toBe(1);
    expect(JSON.stringify(harness.logged)).not.toContain('kerfi');
  });
});
