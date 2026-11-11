import { Model } from 'mongoose';
import type { ConversationSearchDocument } from '~/schema/conversationSearch';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import conversationSearchSchema from '~/schema/conversationSearch';

export function createConversationSearchModel(
  mongoose: typeof import('mongoose'),
): Model<ConversationSearchDocument> {
  applyTenantIsolation(conversationSearchSchema);
  return (
    mongoose.models.ConversationSearch ||
    mongoose.model<ConversationSearchDocument>('ConversationSearch', conversationSearchSchema)
  );
}
