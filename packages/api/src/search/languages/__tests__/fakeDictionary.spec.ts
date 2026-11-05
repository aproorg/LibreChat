import { createFakeDictionaryPack } from './helpers/fakeDictionary';
import { describePackContract } from './helpers/contract';

describePackContract({
  name: 'fake dictionary',
  create: () => createFakeDictionaryPack(),
  createBroken: () => createFakeDictionaryPack({ failLoad: true }),
});
