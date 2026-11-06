import type { SearchLoaderModels } from './helpers/loader';
import { loadSearchRecords } from './helpers/loader';
import { createAnalyzer } from '../analyzer/analyze';
import { createEnPack } from '../languages/en';

describe('loadSearchRecords', () => {
  it('fails when a row fails validation, instead of counting it as loaded', async () => {
    const insertMany = jest.fn(async () => ({
      mongoose: { validationErrors: [new Error('bad')] },
    }));
    const models: SearchLoaderModels = {
      MessageSearch: { insertMany },
      ConversationSearch: { insertMany },
      SearchVocab: { insertMany },
      SearchState: { create: async () => undefined },
    };

    const en = createEnPack();
    await en.load?.();

    await expect(
      loadSearchRecords(models, {
        analyzer: createAnalyzer({ packs: [en], cacheWords: 10 }),
        version: 'v',
        messages: [
          {
            _id: 'id',
            messageId: 'm',
            conversationId: 'c',
            user: 'u',
            text: 'word',
            createdAt: new Date(),
          },
        ],
      }),
    ).rejects.toThrow('1 of 1 rows failed validation');
  });
});
