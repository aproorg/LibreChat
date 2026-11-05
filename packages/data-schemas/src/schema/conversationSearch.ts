import { Schema } from 'mongoose';
import type { Types } from 'mongoose';
import type { ConversationSearchRecord } from '~/types/search';
import { MAX_SEARCH_TOKENS } from './messageSearch';

export type ConversationSearchDocument = Omit<ConversationSearchRecord, '_id'> & {
  _id: Types.ObjectId;
};

const conversationSearchSchema: Schema<ConversationSearchDocument> = new Schema(
  {
    _id: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    user: {
      type: String,
      required: true,
    },
    conversationId: {
      type: String,
      required: true,
    },
    h: {
      type: String,
      required: true,
    },
    v: {
      type: String,
      required: true,
    },
    e: {
      type: Number,
      required: true,
    },
    tokens: {
      type: [String],
      required: true,
      validate: {
        validator: (tokens: string[]) => tokens.length <= MAX_SEARCH_TOKENS,
        message: `At most ${MAX_SEARCH_TOKENS} tokens`,
      },
    },
    tenantId: {
      type: String,
    },
  },
  {
    collection: 'csearch',
    autoCreate: false,
    autoIndex: false,
    versionKey: false,
  },
);

conversationSearchSchema.index({ user: 1, tokens: 1 });

export default conversationSearchSchema;
