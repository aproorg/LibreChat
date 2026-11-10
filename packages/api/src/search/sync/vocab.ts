import type { SearchMethods } from '@librechat/data-schemas';
import { JOB_STATE_READ, VOCAB_KEY } from '../jobs/control';
import { getSafeErrorMetadata } from '~/utils/errors';

export type VocabCounterMethods = Pick<SearchMethods, 'readSearchState' | 'incrementSearchVocab'>;

/** The word list's counts from the sync writer, held in memory between flushes (R-10). */
export interface VocabCounter {
  /** Counts one new or changed record's tokens. Writes nothing. */
  add(tokens: readonly string[]): void;
  /** Writes what is held, if this process still holds the lease. Never rejects. */
  flush(): Promise<void>;
  /** Flushes every `vocabFlushSeconds`. Its timer never keeps the process alive. */
  start(): void;
  /** Stops the timer and flushes once more. */
  stop(): Promise<void>;
  /** Distinct tokens waiting for the next flush. */
  pending(): number;
}

/**
 * `df` only increases here, because the writer reads no old tokens. It only orders expansions
 * and rarity, and reconcile's rebuild corrects it. During a rebuild every flushed row is
 * stamped with its run, so a word that first appears mid-walk survives the copy pass.
 */
export function createVocabCounter({
  methods,
  flushSeconds,
  holds,
  logger,
}: {
  methods: VocabCounterMethods;
  flushSeconds: number;
  /** Only the active writer writes the word list. */
  holds(): boolean;
  logger: { warn(message: string, meta: object): unknown };
}): VocabCounter {
  let counts = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;

  async function write(): Promise<void> {
    if (counts.size === 0) {
      return;
    }
    const held = counts;
    counts = new Map();
    if (!holds()) {
      /* A writer that lost its turn may have lost its records too: the next rebuild counts them. */
      return;
    }
    try {
      const rebuild = await methods.readSearchState(VOCAB_KEY, JOB_STATE_READ);
      const run =
        rebuild?.status === 'running' && typeof rebuild.run === 'number' ? rebuild.run : null;
      await methods.incrementSearchVocab({ counts: [...held], run });
    } catch (error) {
      for (const [token, count] of held) {
        counts.set(token, (counts.get(token) ?? 0) + count);
      }
      logger.warn('[search] Word list flush failed', getSafeErrorMetadata(error));
    }
  }

  function flush(): Promise<void> {
    if (!flushing) {
      flushing = write().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  return {
    add(tokens) {
      for (const token of new Set(tokens)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    },
    flush,
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => void flush(), flushSeconds * 1000);
      timer.unref();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await flushing;
      await flush();
    },
    pending: () => counts.size,
  };
}
