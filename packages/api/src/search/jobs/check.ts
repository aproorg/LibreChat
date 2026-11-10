import { isIndexableSource } from '@librechat/data-schemas';
import type { SearchMethods, SearchSourceCollection } from '@librechat/data-schemas';

export type SourceCheckMethods = Pick<
  SearchMethods,
  'readSearchSourcesById' | 'deleteSearchRecords'
>;

export const EXCLUDE_PATH = { messages: 'subagentTask', conversations: 'subagentThread' } as const;

/**
 * The post-write source check (R-09). A source can be deleted or turn temporary between a
 * batch's read and its write, and the write would bring its record back (FR-022). One read
 * after the write settles it, whichever order the two happened in.
 */
export async function removeRecordsOfGoneSources(
  methods: SourceCheckMethods,
  collection: SearchSourceCollection,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const current = await methods.readSearchSourcesById(collection, ids);
  const kept = new Set(
    current.filter((row) => isIndexableSource(row, EXCLUDE_PATH[collection])).map(({ _id }) => _id),
  );
  return methods.deleteSearchRecords(
    collection,
    ids.filter((id) => !kept.has(id)),
  );
}
