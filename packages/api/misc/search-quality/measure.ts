import type { ConditionRow, QualityCondition, QualityManifest, QualityQuery } from './conditions';
import type { PrecisionJudgement, QueryScore } from './scoring';
import type { Analyzer } from '~/search/analyzer/analyze';
import type { QualityReadMethods } from './reads';
import { gradeTexts, judgePage, reciprocalRank, scoreAt, stripCondition } from './scoring';
import { rankedMessageIds } from './reads';
import { requireQualityEnv } from './env';

const FIRST_PAGE = 25;
const SHALLOW = 200;
const DEEP = 1000;

export interface QueryMeasure {
  cat?: string;
  query: string;
  words: number;
  us1: boolean;
  /** `/search`'s page. */
  page: QueryScore;
  /** The ranked shared read at `sidebarLimit` 200 and 1,000 (R-13). */
  at200: QueryScore;
  at1000: QueryScore;
  /** The reference's top 200: the first 200 of its read at 1,000. */
  at200OfDeep: QueryScore;
  /** Whether the page came out the same from both read sizes (R-08). */
  pageStable: boolean;
  rr: number | null;
  judged: PrecisionJudgement | null;
  returned: number;
  /** IDs only, kept out of tree, for the per-query comparison. */
  firstPage: string[];
  ranks: Record<string, number>;
}

export interface ConditionMeasure {
  rows: QueryMeasure[];
  grades: Array<{ query: string; judged: PrecisionJudgement | null; returned: number }>;
  /** Returned IDs another user owns, or that may not be searched. Must stay empty. */
  isolationViolations: string[];
}

const passes = (rows: QueryMeasure[], pick: (row: QueryMeasure) => QueryScore): number =>
  rows.filter((row) => pick(row).pass).length;

const meanPrecision = (judged: Array<PrecisionJudgement | null>) => {
  const pages = judged.filter((page): page is PrecisionJudgement => page != null);
  const mean = (value: (page: PrecisionJudgement) => number) =>
    pages.length === 0
      ? 0
      : Number((pages.reduce((sum, page) => sum + value(page), 0) / pages.length).toFixed(3));
  return {
    rel: mean((page) => page.rel / page.of),
    strict: mean((page) => page.strict / page.of),
    pages: pages.length,
  };
};

const tally = (rows: QueryMeasure[]) => ({
  queries: rows.length,
  page: passes(rows, ({ page }) => page),
  at200: passes(rows, ({ at200 }) => at200),
  at1000: passes(rows, ({ at1000 }) => at1000),
  at200OfDeep: passes(rows, ({ at200OfDeep }) => at200OfDeep),
  expectedOnPage: rows.reduce((sum, { page }) => sum + page.found, 0),
  expectedAt200: rows.reduce((sum, { at200 }) => sum + at200.found, 0),
  expected: rows.reduce((sum, { page }) => sum + page.of, 0),
  mrr: (() => {
    const ranked = rows.filter(({ rr }) => rr != null);
    return ranked.length === 0
      ? 0
      : Number((ranked.reduce((sum, { rr }) => sum + (rr ?? 0), 0) / ranked.length).toFixed(3));
  })(),
  precision: meanPrecision(rows.map(({ judged }) => judged)),
});

/** The tables `final/report.py` prints, as counts only: no query text. */
export function summarizeMeasure({ rows, grades, isolationViolations }: ConditionMeasure) {
  const categories = [...new Set(rows.map(({ cat }) => cat ?? ''))];
  return {
    all: tally(rows),
    us1: tally(rows.filter(({ us1 }) => us1)),
    byCategory: Object.fromEntries(
      categories.map((category) => [category, tally(rows.filter(({ cat }) => cat === category))]),
    ),
    floodProne: meanPrecision(grades.map(({ judged }) => judged)),
    unstablePages: rows.filter(({ pageStable }) => !pageStable).length,
    isolationViolations: isolationViolations.length,
  };
}

/**
 * Runs the reference's queries and flood-prone queries through the production read,
 * and every word that only an excluded or foreign message holds. Scores with the
 * reference's rules. It reports, and holds no thresholds: T076 owns the SC-001 gate.
 */
export async function measureCondition(
  methods: QualityReadMethods,
  analyzer: Analyzer,
  manifest: QualityManifest,
  condition: QualityCondition,
  conditionRows: ReadonlyMap<string, ConditionRow>,
): Promise<ConditionMeasure> {
  const violations = new Set<string>();
  const checkIsolation = (ids: readonly string[]) => {
    for (const id of ids) {
      const row = conditionRows.get(id);
      if (row?.user !== condition.user || !row.indexable) {
        violations.add(id);
      }
    }
  };
  const textsOf = (ids: readonly string[]) => ids.map((id) => conditionRows.get(id)?.text ?? '');
  const search = async (query: string): Promise<QueryReads> => {
    const shallow = await rankedMessageIds(methods, analyzer, condition.user, query, SHALLOW);
    const deep = await rankedMessageIds(methods, analyzer, condition.user, query, DEEP);
    checkIsolation([...shallow.firstPage, ...shallow.top, ...deep.firstPage, ...deep.top]);
    return { shallow, deep };
  };
  const judge = async (query: string, firstPage: readonly string[]) =>
    judgePage(
      firstPage.length === 0
        ? []
        : await gradeTexts(
            requireQualityEnv('SEARCH_QUALITY_DIR'),
            query,
            textsOf(firstPage.slice(0, FIRST_PAGE)),
          ),
    );

  const rows: QueryMeasure[] = [];
  for (const query of manifest.queries) {
    rows.push(await measureQuery(query, await search(query.query), judge));
  }

  const grades: ConditionMeasure['grades'] = [];
  for (const query of manifest.gradeQueries) {
    const { shallow, deep } = await search(query);
    grades.push({
      query,
      judged: await judge(query, shallow.firstPage),
      returned: deep.top.length,
    });
  }

  for (const query of manifest.isolationQueries) {
    await search(query);
  }

  return {
    rows,
    grades,
    isolationViolations: [...violations],
  };
}

interface QueryReads {
  shallow: Awaited<ReturnType<typeof rankedMessageIds>>;
  deep: Awaited<ReturnType<typeof rankedMessageIds>>;
}

async function measureQuery(
  query: QualityQuery,
  { shallow, deep }: QueryReads,
  judge: (query: string, firstPage: readonly string[]) => Promise<PrecisionJudgement | null>,
): Promise<QueryMeasure> {
  const page = deep.firstPage.map(stripCondition);
  const top200 = shallow.top.map(stripCondition);
  const top1000 = deep.top.map(stripCondition);
  const ranks = Object.fromEntries(
    query.expected.map((id) => [id, top1000.indexOf(`gold-${id}`) + 1]),
  );
  return {
    cat: query.cat,
    query: query.query,
    words: query.words,
    us1: query.us1,
    page: scoreAt(query, page, FIRST_PAGE),
    at200: scoreAt(query, top200, SHALLOW),
    at1000: scoreAt(query, top1000, DEEP),
    at200OfDeep: scoreAt(query, top1000, SHALLOW),
    pageStable: JSON.stringify(shallow.firstPage) === JSON.stringify(deep.firstPage),
    rr: reciprocalRank(query, page),
    judged: await judge(query.query, deep.firstPage),
    returned: top1000.length,
    firstPage: page,
    ranks,
  };
}
