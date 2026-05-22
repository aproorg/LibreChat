import type { Model } from 'mongoose';
import type { IMongoFile } from '@librechat/data-schemas';
import {
  getStaleEmbedTimeout,
  getStaleEmbedSweepInterval,
  sweepStaleEmbeddings,
  startStaleEmbedSweep,
} from './staleEmbedSweep';

const FIVE_MIN = 5 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;

describe('stale embed sweep helpers', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STALE_EMBED_TIMEOUT_MS;
    delete process.env.STALE_EMBED_SWEEP_INTERVAL_MS;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.STALE_EMBED_TIMEOUT_MS;
    delete process.env.STALE_EMBED_SWEEP_INTERVAL_MS;
  });

  describe('getStaleEmbedTimeout', () => {
    it('returns the default when env var is unset or blank', () => {
      expect(getStaleEmbedTimeout(undefined)).toBe(THIRTY_MIN);
      expect(getStaleEmbedTimeout('')).toBe(THIRTY_MIN);
      expect(getStaleEmbedTimeout('   ')).toBe(THIRTY_MIN);
    });

    it('returns the parsed value when finite and positive', () => {
      expect(getStaleEmbedTimeout('60000')).toBe(60_000);
    });

    it('falls back to default for non-numeric or non-positive values', () => {
      expect(getStaleEmbedTimeout('abc')).toBe(THIRTY_MIN);
      expect(getStaleEmbedTimeout('0')).toBe(THIRTY_MIN);
      expect(getStaleEmbedTimeout('-1')).toBe(THIRTY_MIN);
    });
  });

  describe('getStaleEmbedSweepInterval', () => {
    it('returns the default when env var is unset', () => {
      expect(getStaleEmbedSweepInterval(undefined)).toBe(FIVE_MIN);
    });

    it('honours `0` to disable the sweep (mirrors retention sweep semantics)', () => {
      expect(getStaleEmbedSweepInterval('0')).toBe(0);
    });

    it('rejects negative or non-numeric values, falling back to default', () => {
      expect(getStaleEmbedSweepInterval('-1')).toBe(FIVE_MIN);
      expect(getStaleEmbedSweepInterval('abc')).toBe(FIVE_MIN);
    });
  });

  describe('sweepStaleEmbeddings', () => {
    it('runs an updateMany scoped to embedding records older than the cutoff', async () => {
      const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 3 });
      const File = { updateMany } as unknown as Model<IMongoFile>;

      const modified = await sweepStaleEmbeddings(File, logger, 60_000);

      expect(modified).toBe(3);
      expect(updateMany).toHaveBeenCalledTimes(1);
      const [filter, update] = updateMany.mock.calls[0];
      expect(filter.embedStatus).toBe('embedding');
      expect(filter.updatedAt.$lt).toBeInstanceOf(Date);
      expect(update.$set).toEqual({ embedStatus: 'error', embedError: 'sweep:stale' });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Marked 3'));
    });

    it('logs nothing when no records were stale', async () => {
      const File = {
        updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      } as unknown as Model<IMongoFile>;

      await sweepStaleEmbeddings(File, logger, 60_000);
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('startStaleEmbedSweep', () => {
    it('returns null and logs when STALE_EMBED_SWEEP_INTERVAL_MS=0', () => {
      process.env.STALE_EMBED_SWEEP_INTERVAL_MS = '0';
      const File = { updateMany: jest.fn() } as unknown as Model<IMongoFile>;

      const handle = startStaleEmbedSweep(File, logger);

      expect(handle).toBeNull();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Disabled by'));
    });

    it('runs an immediate sweep on start and schedules an interval', async () => {
      jest.useFakeTimers();
      const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
      const File = { updateMany } as unknown as Model<IMongoFile>;

      const handle = startStaleEmbedSweep(File, logger);
      try {
        /* `advanceTimersByTimeAsync` flushes the microtasks the immediate
         * sweep schedules, so the in-flight `isSweeping` flag resets
         * before the interval tick. With sync `advanceTimersByTime` the
         * interval tick is dropped because the first sweep is still
         * pending in the microtask queue. */
        expect(updateMany).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(FIVE_MIN);
        expect(updateMany).toHaveBeenCalledTimes(2);
      } finally {
        if (handle) clearInterval(handle);
      }
    });
  });
});
