import type { Model } from 'mongoose';
import type { IMongoFile } from '@librechat/data-schemas';

/* Mark a record as failed if `embedStatus === 'embedding'` for longer than this.
 * Covers two failure modes that leave records orphaned in 'embedding':
 *   1. The LibreChat backend crashed mid-`uploadVectors` — the in-flight
 *      handler is gone but the record persists.
 *   2. The downstream RAG service hung past any reasonable ingestion time.
 * The default is generous (30 min) because Bedrock-backed RAG can take 20+
 * minutes for large PDFs; tune via STALE_EMBED_TIMEOUT_MS. */
const DEFAULT_STALE_EMBED_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STALE_EMBED_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type SweepLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, error?: unknown) => void;
};

export function getStaleEmbedTimeout(raw = process.env.STALE_EMBED_TIMEOUT_MS): number {
  if (raw == null || raw.trim() === '') {
    return DEFAULT_STALE_EMBED_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_STALE_EMBED_TIMEOUT_MS;
  }
  return value;
}

export function getStaleEmbedSweepInterval(
  raw = process.env.STALE_EMBED_SWEEP_INTERVAL_MS,
): number {
  if (raw == null || raw.trim() === '') {
    return DEFAULT_STALE_EMBED_SWEEP_INTERVAL_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_STALE_EMBED_SWEEP_INTERVAL_MS;
  }
  return value;
}

export async function sweepStaleEmbeddings(
  File: Model<IMongoFile>,
  logger: SweepLogger,
  timeoutMs: number = getStaleEmbedTimeout(),
): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs);
  const result = await File.updateMany(
    { embedStatus: 'embedding', updatedAt: { $lt: cutoff } },
    { $set: { embedStatus: 'error', embedError: 'sweep:stale' } },
  );
  if (result.modifiedCount > 0) {
    logger.info(
      `[staleEmbedSweep] Marked ${result.modifiedCount} stale embed records (older than ${timeoutMs}ms) as error.`,
    );
  }
  return result.modifiedCount;
}

export function startStaleEmbedSweep(
  File: Model<IMongoFile>,
  logger: SweepLogger,
): NodeJS.Timeout | null {
  const intervalMs = getStaleEmbedSweepInterval();
  if (intervalMs === 0) {
    logger.info('[staleEmbedSweep] Disabled by STALE_EMBED_SWEEP_INTERVAL_MS=0');
    return null;
  }

  let isSweeping = false;
  const runSweep = async () => {
    if (isSweeping) {
      return;
    }
    isSweeping = true;
    try {
      await sweepStaleEmbeddings(File, logger);
    } catch (error) {
      logger.error('[staleEmbedSweep] Background sweep failed:', error);
    } finally {
      isSweeping = false;
    }
  };

  runSweep();
  const interval = setInterval(runSweep, intervalMs);
  interval.unref?.();
  return interval;
}
