import type { ConditionName } from './conditions';
import type { summarizeMeasure } from './measure';

type Summary = ReturnType<typeof summarizeMeasure>;

/** A category's floor from SC-003, where the spec states one. */
interface CategoryFloor {
  category: string;
  page?: number;
  at200?: number;
}

interface ConditionGate {
  /** SC-001, or SC-003's first-page count on condition H. */
  page: number;
  /** Queries with every expected message in the top 200. */
  at200: number;
  /** SC-002's expected messages on the first page. */
  expectedOnPage?: number;
  /** Precision at 25 on the flood-prone queries, to the two decimals the spec states it in. */
  precision: number;
  categories: CategoryFloor[];
}

/**
 * SC-001 to SC-003 as numbers. Changing one is a written decision under FR-034, not a
 * tuning step.
 *
 * "Top 200" here is the first 200 of the ranked read at limit 1,000, which is how the
 * reference produced these targets. R-13's own top 200, the read at `sidebarLimit` 200,
 * sees only the newest 200 rows of each job before ranking, so on condition H it finds
 * fewer. `measure.spec.ts` writes both, as `at200OfDeep` and `at200`. Which of the
 * two the criterion means is the owner's call under FR-034.
 */
export const QUALITY_GATES: Readonly<Record<ConditionName, ConditionGate>> = {
  P: {
    page: 63,
    at200: 76,
    expectedOnPage: 92,
    precision: 0.98,
    categories: [
      { category: 'inflection', page: 9 },
      { category: 'compound', at200: 7 },
      { category: 'no-accents', page: 11 },
    ],
  },
  H: { page: 32, at200: 47, precision: 0.9, categories: [] },
};

/** Each missed target as `name: got, needs`. Empty means the condition passes. */
export function missedTargets(name: ConditionName, summary: Summary): string[] {
  const gate = QUALITY_GATES[name];
  const { all, byCategory, floodProne, isolationViolations } = summary;
  const checks: Array<[string, number, number]> = [
    ['queries passing on the first page', all.page, gate.page],
    ['queries with all expected in the top 200', all.at200OfDeep, gate.at200],
    [
      'precision at 25 on flood-prone queries',
      Math.round(floodProne.rel * 100) / 100,
      gate.precision,
    ],
    ...(gate.expectedOnPage === undefined
      ? []
      : [
          ['expected messages on the first page', all.expectedOnPage, gate.expectedOnPage] as [
            string,
            number,
            number,
          ],
        ]),
    ...gate.categories.flatMap(
      ({ category, page, at200 }): Array<[string, number, number]> => [
        ...(page === undefined
          ? []
          : [
              [`${category} on the first page`, byCategory[category]?.page ?? 0, page] as [
                string,
                number,
                number,
              ],
            ]),
        ...(at200 === undefined
          ? []
          : [
              [`${category} in the top 200`, byCategory[category]?.at200OfDeep ?? 0, at200] as [
                string,
                number,
                number,
              ],
            ]),
      ],
    ),
  ];
  return [
    ...checks
      .filter(([, got, needs]) => got < needs)
      .map(([what, got, needs]) => `${what}: ${got}, needs ${needs}`),
    /* SC-004: any result another user owns, or that may not be searched. */
    ...(isolationViolations > 0 ? [`isolation violations: ${isolationViolations}, needs 0`] : []),
  ];
}
