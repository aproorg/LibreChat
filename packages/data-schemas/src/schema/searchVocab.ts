import { Schema } from 'mongoose';
import type { SearchVocabRow } from '~/types/search';

/** `_id` serves prefix ranges, so this collection has no other index. */
const searchVocabSchema: Schema<SearchVocabRow> = new Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    df: {
      type: Number,
      required: true,
    },
    dfNext: {
      type: Number,
    },
    r: {
      type: Number,
    },
  },
  {
    collection: 'search_vocab',
    autoCreate: false,
    autoIndex: false,
    versionKey: false,
  },
);

export default searchVocabSchema;
