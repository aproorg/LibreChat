import { Model } from 'mongoose';
import type { SearchVocabRow } from '~/types/search';
import searchVocabSchema from '~/schema/searchVocab';

/** One tenant per database, so the word list carries no `tenantId`. */
export function createSearchVocabModel(mongoose: typeof import('mongoose')): Model<SearchVocabRow> {
  return (
    mongoose.models.SearchVocab || mongoose.model<SearchVocabRow>('SearchVocab', searchVocabSchema)
  );
}
