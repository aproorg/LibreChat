import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Scoring as `final/relevance.mjs` defines it. That script exports nothing and needs
 * the reference's own candidates, so its pass, top and precision rules are carried here.
 */
export interface GoldenQuery {
  cat?: string;
  query: string;
  expected: string[];
  avoid?: string[];
  top?: string;
}

export interface QueryScore {
  found: number;
  of: number;
  pass: boolean;
}

export interface PrecisionJudgement {
  /** Results the grader accepts, at any grade. */
  rel: number;
  /** Results the grader gives its top grade. */
  strict: number;
  of: number;
}

const GOLD_PREFIX = 'gold-';
const FIRST_PAGE = 25;

/** Drops a loading condition's message ID prefix, as `final/conditions.mjs`'s `stripCondition`. */
export const stripCondition = (id: string): string => id.replace(/^[UPH]-/, '');

/** Pass at `k`: every expected message in the top `k`, none avoided, and the right first result. */
export function scoreAt(query: GoldenQuery, ids: readonly string[], k: number): QueryScore {
  const top = new Set(ids.slice(0, k));
  const found = query.expected.filter((id) => top.has(GOLD_PREFIX + id)).length;
  const avoided = (query.avoid ?? []).filter((id) => top.has(GOLD_PREFIX + id)).length;
  const topOk = query.top ? ids[0] === GOLD_PREFIX + query.top : true;
  return {
    found,
    of: query.expected.length,
    pass: found === query.expected.length && avoided === 0 && topOk,
  };
}

/** 1 over the rank of the first expected message, or `null` for a query expecting none. */
export function reciprocalRank(query: GoldenQuery, ids: readonly string[]): number | null {
  if (query.expected.length === 0) {
    return null;
  }
  const index = ids.findIndex(
    (id) => id.startsWith(GOLD_PREFIX) && query.expected.includes(id.slice(GOLD_PREFIX.length)),
  );
  return index < 0 ? 0 : 1 / (index + 1);
}

/** Tallies grades of a first page, or `null` for an empty page. */
export function judgePage(grades: readonly number[]): PrecisionJudgement | null {
  const page = grades.slice(0, FIRST_PAGE);
  if (page.length === 0) {
    return null;
  }
  return {
    rel: page.filter((grade) => grade >= 1).length,
    strict: page.filter((grade) => grade === 2).length,
    of: page.length,
  };
}

/**
 * Grades texts through T016's grader, in `SEARCH_QUALITY_DIR/grade.mjs`, as a child
 * process, because the oracle it wraps holds the private data's full binary. It takes
 * `{ "query": string, "texts": string[] }` on stdin and prints a JSON array of 0, 1 or 2.
 */
export function gradeTexts(
  qualityDir: string,
  query: string,
  texts: readonly string[],
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [join(qualityDir, 'grade.mjs')], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`The grader exited with ${code}`));
        return;
      }
      try {
        const grades: unknown = JSON.parse(output);
        if (!Array.isArray(grades) || grades.length !== texts.length) {
          throw new Error('The grader answered the wrong number of grades');
        }
        resolve(grades as number[]);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ query, texts }));
  });
}
