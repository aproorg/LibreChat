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
    /*
     * Each key has its own fields, and none are declared. The app's global `strictQuery: true`
     * would strip them from filters, leaving the lease's holder, epoch and expiry checks empty.
     */
    strictQuery: false,
    autoCreate: false,
    autoIndex: false,
    versionKey: false,
  },
);

export default searchStateSchema;
