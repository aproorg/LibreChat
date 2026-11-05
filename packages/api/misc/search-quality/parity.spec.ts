import { join } from 'node:path';
import { buildMessageRecord } from '~/search/sync/record';
import { queryWord } from '~/search/analyzer/query';
import { corpusMessages, readNdjson } from './corpus';
import { requireQualityEnv } from './env';
import { loadQualityAnalyzer } from './analyzer';

/**
 * FR-007: tokens equal `final/analyze.mjs`'s. T016 generates what these read, out of tree:
 *
 *   SEARCH_QUALITY_CORPUS/messages-*.ndjson.gz   from `gen.mjs`
 *   SEARCH_QUALITY_DIR/index-tokens.ndjson.gz    { "messageId": string, "tokens": string[] }
 *                                                from `docTokens(doc._text)`, for each indexable doc
 *   SEARCH_QUALITY_DIR/query-tokens.ndjson.gz    { "word": string, ...queryWord(word) }
 *
 * A missing input fails the run: a skipped check would prove nothing.
 */
const MAX_REPORTED = 20;

/**
 * One process checks about 90 messages a second, so the whole corpus takes hours.
 * `SEARCH_QUALITY_PARITY_SHARD=i/n` checks every nth item: run i from 0 to n-1, one
 * process each, and only a pass of all n covers the corpus. Unset means all of it.
 */
const parseShard = (value: string | undefined): { index: number; count: number } => {
  if (!value) {
    return { index: 0, count: 1 };
  }
  const [index, count] = value.split('/').map(Number);
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) {
    throw new Error('SEARCH_QUALITY_PARITY_SHARD must be i/n with 0 <= i < n');
  }
  return { index, count };
};

const shard = parseShard(process.env.SEARCH_QUALITY_PARITY_SHARD);

interface ExpectedIndexTokens {
  messageId: string;
  tokens: string[];
}

interface ExpectedQueryWord {
  word: string;
  raw: string;
  exact: string;
  lemmas: string[];
  parts: string[];
  stop: boolean;
}

/** Holds IDs and words only, and only from out-of-tree inputs on the operator's machine. */
const report = (differences: string[], kind: string, total: number): void => {
  if (differences.length > 0) {
    throw new Error(
      `${differences.length} of ${total} ${kind} differ. First: ${differences
        .slice(0, MAX_REPORTED)
        .join('; ')}`,
    );
  }
};

describe('token parity with the reference', () => {
  it('builds the same index tokens for every indexable message', async () => {
    const analyzer = await loadQualityAnalyzer(requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR'));
    const expected = readNdjson<ExpectedIndexTokens>(
      join(requireQualityEnv('SEARCH_QUALITY_DIR'), 'index-tokens.ndjson.gz'),
    )[Symbol.asyncIterator]();
    const differences: string[] = [];
    let seen = 0;
    let total = 0;

    for await (const doc of corpusMessages(requireQualityEnv('SEARCH_QUALITY_CORPUS'))) {
      if (doc._indexable === false) {
        continue;
      }
      const next = await expected.next();
      if (next.done) {
        throw new Error('The corpus holds more indexable messages than the expected tokens');
      }
      seen += 1;
      if (next.value.messageId !== doc.messageId) {
        throw new Error('The corpus and the expected tokens are not in the same order');
      }
      if ((seen - 1) % shard.count !== shard.index) {
        continue;
      }
      total += 1;
      const record = buildMessageRecord(doc, { analyzer, version: 'parity' });
      if (JSON.stringify(record?.tokens) !== JSON.stringify(next.value.tokens)) {
        differences.push(next.value.messageId);
      }
    }

    expect((await expected.next()).done).toBe(true);
    expect(total).toBeGreaterThan(0);
    report(differences, 'messages', total);
  }, 7_200_000);

  it('builds the same query tokens for every word', async () => {
    const analyzer = await loadQualityAnalyzer(requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR'));
    const expected = readNdjson<ExpectedQueryWord>(
      join(requireQualityEnv('SEARCH_QUALITY_DIR'), 'query-tokens.ndjson.gz'),
    );
    const differences: string[] = [];
    let seen = 0;
    let total = 0;

    for await (const { word, ...tokens } of expected) {
      seen += 1;
      if ((seen - 1) % shard.count !== shard.index) {
        continue;
      }
      total += 1;
      if (JSON.stringify(queryWord(analyzer, word)) !== JSON.stringify(tokens)) {
        differences.push(word);
      }
    }

    expect(total).toBeGreaterThan(0);
    report(differences, 'query words', total);
  }, 600_000);
});
