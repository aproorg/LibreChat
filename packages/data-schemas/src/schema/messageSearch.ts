import { Schema } from 'mongoose';
import type { Types } from 'mongoose';
import type { MessageSearchRecord } from '~/types/search';

/**
 * Compound and inflected forms of a long message stop here (FR-007). The analyzer's cap is
 * this same constant, so a record it builds always passes the validators below.
 */
export const MAX_SEARCH_TOKENS = 3000;

export type MessageSearchDocument = Omit<MessageSearchRecord, '_id'> & { _id: Types.ObjectId };

const messageSearchSchema: Schema<MessageSearchDocument> = new Schema(
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
    messageId: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      required: true,
    },
    n: {
      type: Number,
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
    collection: 'msearch',
    autoCreate: false,
    autoIndex: false,
    versionKey: false,
  },
);

messageSearchSchema.index({ user: 1, tokens: 1, createdAt: -1 }, { name: 'user_tokens_created' });

export default messageSearchSchema;
