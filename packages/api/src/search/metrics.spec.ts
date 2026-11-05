import type { SearchMetrics, SearchMetricsLogger } from './metrics';
import { createSearchMetrics } from './metrics';

const SENTINEL = 'SENTINEL-user words 123';

const createLogger = () => {
  const lines: unknown[][] = [];
  const write = (...args: unknown[]) => {
    lines.push(args);
  };
  const logger: SearchMetricsLogger = { info: write, warn: write };
  return { logger, lines };
};

/** Answers every field an emitter reads with the sentinel, so a new field is covered untouched. */
const sentinelFields = new Proxy(
  {},
  {
    get: () => SENTINEL,
    has: () => true,
    ownKeys: () => ['query', 'text', 'error'],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: SENTINEL }),
  },
);

type Emitters = Record<string, (...args: unknown[]) => void>;

const validRequest = {
  surface: 'messages',
  backend: 'search',
  detached: false,
  ms: 12,
  reads: 2,
  rows: 30,
  words: 1,
  tierReached: 'lemma',
  coldAfterIdle: false,
  isLargestUser: true,
  outcome: 'ok',
} as const;

describe('createSearchMetrics', () => {
  it('names every event in the telemetry contract', () => {
    const { logger, lines } = createLogger();
    const metrics = createSearchMetrics(logger);

    metrics.request(validRequest);
    metrics.shadow({ surface: 'messages', state: 'ok', dropped: false });
    metrics.cursorError({ surface: 'messages', retries: 2, final: true });
    metrics.syncLag({ lagMs: 10, batch: 5 });
    metrics.syncStatus({ savedAgeMs: 10, hasHolder: true, isHolder: false });
    metrics.syncGap({ resumeFailed: true, restartedAt: 1000 });
    metrics.syncSkip({ id: '0123456789abcdef01234567', attempts: 3, code: 'write_failed' });
    metrics.lease({
      holder: '123e4567-e89b-12d3-a456-426614174000',
      epoch: 2,
      event: 'acquired',
    });
    metrics.partial({ surface: 'conversations', code: 'search_failed' });
    metrics.reconcile({ missing: 1, orphans: 2, stale: 3, of: 100 });
    metrics.verify({ status: 'passed', mismatchedUsers: 0, round: 1 });
    metrics.pack({ id: 'en', state: 'loaded', ms: 5, rssDelta: 1024 });
    metrics.backfill({
      collection: 'messages',
      rate: 100,
      status: 'paused',
      pausedReason: 'operator',
    });
    metrics.probe({ check: 'temporary', leak: false });
    metrics.realtext.addMessage(10, false);
    metrics.flushRealtext();

    expect(lines.map(([event]) => event)).toEqual([
      'search.request',
      'search.shadow',
      'search.cursor_error',
      'search.sync_lag',
      'search.sync_status',
      'search.sync_gap',
      'search.sync_skip',
      'search.lease',
      'search.partial',
      'search.reconcile',
      'search.verify',
      'search.pack',
      'search.backfill',
      'search.probe',
      'search.realtext',
    ]);
    expect(lines[0][1]).toEqual(validRequest);
    expect(lines[7][1]).toEqual({
      holder: '123e4567-e89b-12d3-a456-426614174000',
      epoch: 2,
      event: 'acquired',
    });
    expect(lines[12][1]).toEqual({
      collection: 'messages',
      rate: 100,
      status: 'paused',
      pausedReason: 'operator',
    });
  });

  it('never logs a sentinel passed in any field of any emitter', () => {
    const { logger, lines } = createLogger();
    const metrics = createSearchMetrics(logger);
    const emitters = Object.entries(metrics as unknown as Emitters).filter(
      ([name, value]) =>
        typeof value === 'function' && name !== 'flushRealtext' && name !== 'startRealtextFlush',
    );

    expect(emitters.length).toBe(14);
    for (const [, emit] of emitters) {
      emit(sentinelFields);
    }
    expect(lines).toHaveLength(14);
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
    expect(JSON.stringify(lines)).not.toContain('user words');
  });

  it('drops fields the contract does not allow, from a valid call', () => {
    const { logger, lines } = createLogger();
    const metrics = createSearchMetrics(logger);

    metrics.request({ ...validRequest, query: SENTINEL } as never);
    metrics.partial({
      surface: 'conversations',
      code: 'search_failed',
      error: new Error(SENTINEL),
    } as never);

    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('never logs a sentinel through the realtext accumulator', () => {
    const { logger, lines } = createLogger();
    const metrics = createSearchMetrics(logger);
    const { realtext } = metrics as unknown as { realtext: Emitters };

    for (const add of Object.values(realtext)) {
      add(SENTINEL, SENTINEL);
    }
    metrics.flushRealtext();

    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('logs no sentinel with an Error or object in place of a value', () => {
    const { logger, lines } = createLogger();
    const metrics = createSearchMetrics(logger);

    metrics.syncSkip({
      id: new Error(SENTINEL),
      attempts: { SENTINEL },
      code: [SENTINEL],
    } as never);

    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  describe('search.realtext', () => {
    const flushed = (metrics: SearchMetrics, lines: unknown[][]) => {
      metrics.flushRealtext();
      return lines[lines.length - 1]?.[1];
    };

    it('emits nothing with nothing accumulated', () => {
      const { logger, lines } = createLogger();
      createSearchMetrics(logger).flushRealtext();
      expect(lines).toHaveLength(0);
    });

    it('accumulates each field from its owner, then resets on flush', () => {
      const { logger, lines } = createLogger();
      const metrics = createSearchMetrics(logger);

      metrics.realtext.addMessage(10, false);
      metrics.realtext.addMessage(30, true);
      metrics.realtext.addTier('exact');
      metrics.realtext.addTier('exact');
      metrics.realtext.addTier('prefix');
      metrics.realtext.addTier('prefix');
      metrics.realtext.addPrefixFanout(4);
      metrics.realtext.addPrefixFanout(8);
      metrics.realtext.addVocabRowsTruncated();
      metrics.realtext.addTypoSkippedWordExists();
      metrics.realtext.addNoLetterQuery();
      metrics.realtext.addStopOnlyQuery();
      metrics.realtext.addStopOnlyQuery();

      expect(flushed(metrics, lines)).toEqual({
        tokensPerMessage: 20,
        atCap: 1,
        tierShare: { exact: 0.5, prefix: 0.5 },
        prefixFanout: 6,
        vocabRowsTruncated: 1,
        typoSkippedWordExists: 1,
        noLetterQueries: 1,
        stopOnlyQueries: 2,
      });

      metrics.flushRealtext();
      expect(lines).toHaveLength(1);
    });

    it('flushes each minute until stopped, without holding the process open', () => {
      jest.useFakeTimers();
      try {
        const { logger, lines } = createLogger();
        const metrics = createSearchMetrics(logger);
        const stop = metrics.startRealtextFlush();

        metrics.realtext.addNoLetterQuery();
        jest.advanceTimersByTime(59_999);
        expect(lines).toHaveLength(0);
        jest.advanceTimersByTime(1);
        expect(lines).toHaveLength(1);

        stop();
        metrics.realtext.addNoLetterQuery();
        jest.advanceTimersByTime(120_000);
        expect(lines).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
