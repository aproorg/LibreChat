import { Schema } from 'mongoose';
import type { SearchStateEntry } from '~/types/search';

/** One loose document per key, because each key has its own fields. */
const searchStateSchema: Schema<SearchStateEntry> = new Schema(
  {
    _id: {
      type: String,
      required: true,
    },
  },
  {
    collection: 'search_state',
    strict: false,
    autoCreate: false,
    autoIndex: false,
    versionKey: false,
  },
);

export default searchStateSchema;
