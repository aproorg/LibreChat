import { Model } from 'mongoose';
import type { MessageSearchDocument } from '~/schema/messageSearch';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import messageSearchSchema from '~/schema/messageSearch';

export function createMessageSearchModel(
  mongoose: typeof import('mongoose'),
): Model<MessageSearchDocument> {
  applyTenantIsolation(messageSearchSchema);
  return (
    mongoose.models.MessageSearch ||
    mongoose.model<MessageSearchDocument>('MessageSearch', messageSearchSchema)
  );
}
