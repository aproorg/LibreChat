import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createMethods } from '@librechat/data-schemas';
import type { ConditionName, QualityManifest } from './conditions';
import { measureCondition, summarizeMeasure } from './measure';
import { loadCondition, readQualityJson } from './conditions';
import { buildMessageRecord } from '~/search/sync/record';
import { requireQualityEnv } from './env';
import { connectQualityDatabase } from './database';
import { loadQualityAnalyzer } from './analyzer';
import { missedTargets } from './gate';

const QUERIES = 84;
const EXPECTED_MESSAGES = 113;
const FLOOD_PRONE = 20;
const CONDITIONS: ConditionName[] = ['P', 'H'];

/**
 * Measures with the reference's conditions and writes the numbers out of tree, to
 * `SEARCH_QUALITY_DIR/results`, because a row names query text. Then it holds SC-001
 * to SC-004 (`gate.ts`). The numbers are written first, so a miss can be read. A
 * re-baseline needs FR-034's written decision.
 */
describe('measuring the reference conditions', () => {
  it.each(CONDITIONS)(
    'condition %s: tokens equal the reference, isolation holds, and SC-001 to SC-004 pass',
    async (name) => {
      const manifest = await readQualityJson<QualityManifest>('queries.json');
      expect(manifest.queries).toHaveLength(QUERIES);
      expect(manifest.queries.reduce((sum, { expected }) => sum + expected.length, 0)).toBe(
        EXPECTED_MESSAGES,
      );
      expect(manifest.gradeQueries).toHaveLength(FLOOD_PRONE);

      const analyzer = await loadQualityAnalyzer(requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR'));
      const database = await connectQualityDatabase(
        requireQualityEnv('SEARCH_QUALITY_MONGO_URI'),
        `search_quality_${name}`,
      );
      try {
        const { condition, rows } = await loadCondition(database, analyzer, manifest, name);
        const differ = [...rows.entries()].filter(
          ([, { indexable, tokens, source, user }]) =>
            indexable &&
            user === condition.user &&
            JSON.stringify(buildMessageRecord(source, { analyzer, version: 'parity' })?.tokens) !==
              JSON.stringify(tokens),
        );
        expect(differ.map(([id]) => id)).toEqual([]);

        const measure = await measureCondition(
          createMethods(database.connection),
          analyzer,
          manifest,
          condition,
          rows,
        );
        const dir = join(requireQualityEnv('SEARCH_QUALITY_DIR'), 'results');
        await mkdir(dir, { recursive: true });
        const summary = summarizeMeasure(measure);
        await writeFile(
          join(dir, `measure-${name}.json`),
          JSON.stringify({ summary, ...measure }, null, 1),
        );
        expect(measure.isolationViolations).toEqual([]);
        /* The same page whichever surface fired first, at limits 200 and 1,000 (FR-015). */
        expect(summary.unstablePages).toBe(0);
        expect(missedTargets(name, summary)).toEqual([]);
      } finally {
        await database.close();
      }
    },
    7_200_000,
  );
});
