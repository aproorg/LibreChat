import { Model } from 'mongoose';
import type { SearchStateEntry } from '~/types/search';
import searchStateSchema from '~/schema/searchState';

/** One tenant per database, so sync state carries no `tenantId`. */
export function createSearchStateModel(
  mongoose: typeof import('mongoose'),
): Model<SearchStateEntry> {
  return (
    mongoose.models.SearchState ||
    mongoose.model<SearchStateEntry>('SearchState', searchStateSchema)
  );
}
