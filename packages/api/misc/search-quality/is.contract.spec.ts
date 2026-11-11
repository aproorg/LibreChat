import { describePackContract } from '~/search/languages/__tests__/helpers/contract';
import { createIsPack } from '~/search/languages/is';
import { requireQualityEnv } from './env';

const languageDataDir = requireQualityEnv('SEARCH_LANGUAGE_DATA_DIR');

describePackContract({
  name: 'is',
  create: () => createIsPack({ languageDataDir }),
  createBroken: () => createIsPack({ languageDataDir, expectedSha512: 'a'.repeat(128) }),
  loadTimeoutMs: 120000,
});
