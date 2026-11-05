import { BASE_ONLY_CONFIG_SECTIONS, configSchema, searchConfigSchema } from '../src/config';
import { SEARCH_ERROR_CODES, SEARCH_REASONS } from '../src/types/search';
import type {
  SearchPanelCompareResponse,
  SearchPanelVerdictRequest,
  SearchErrorResponse,
  SearchErrorCode,
  SearchMeta,
} from '../src/types/search';
import type {
  ConversationListResponse,
  MessagesListResponse,
  SharedLinksResponse,
} from '../src/types/queries';

const CONTRACT_DEFAULTS = {
  data: false,
  backend: 'meilisearch',
  languages: ['is', 'en'],
  languageDataDir: '',
  sidebarLimit: 1000,
  rankWindow: 200,
  readConcurrency: 2,
  maxConcurrentSearches: 4,
  queryWordLimit: 10,
  searchTimeoutMs: 10000,
  syncTakeoverSeconds: 30,
  vocabFlushSeconds: 300,
  reconcileDays: 30,
  sharedReadMaxBytes: 67108864,
  statusCacheSeconds: 15,
  analysisCacheWords: 100000,
  meiliResyncPending: false,
  jobs: { batchSize: 200, batchDelayMs: 1000 },
  rank: { lengthBucket: true },
  prefix: { maxCommonReads: 4, maxRareTokens: 200, maxVocabRows: 50000 },
  typo: { maxCorrections: 8, maxVocabRows: 50000 },
  shadow: { maxConcurrent: 4, panelRound: 1, panelUsers: [], largestUserId: '' },
};

describe('search config schema', () => {
  it('leaves an omitted block absent, so a config without it parses as today', () => {
    const parsed = configSchema.parse({ version: '1.3.0' });
    expect(parsed.search).toBeUndefined();
  });

  it('applies the contract defaults to an empty block, including nested blocks', () => {
    expect(searchConfigSchema.parse({})).toEqual(CONTRACT_DEFAULTS);
  });

  it('accepts the block through configSchema', () => {
    const parsed = configSchema.parse({ version: '1.3.0', search: { backend: 'shadow' } });
    expect(parsed.search?.backend).toBe('shadow');
  });

  it.each(['meilisearch', 'shadow', 'search'])('accepts backend %s', (backend) => {
    expect(searchConfigSchema.safeParse({ backend }).success).toBe(true);
  });

  it('rejects an unknown backend', () => {
    expect(searchConfigSchema.safeParse({ backend: 'elastic' }).success).toBe(false);
  });

  it.each([
    [{ unknownField: 1 }],
    [{ jobs: { unknownField: 1 } }],
    [{ rank: { unknownField: true } }],
    [{ prefix: { unknownField: 1 } }],
    [{ typo: { unknownField: 1 } }],
    [{ shadow: { unknownField: 1 } }],
  ])('is strict at every level: %j', (block) => {
    expect(searchConfigSchema.safeParse(block).success).toBe(false);
  });

  it.each([
    'sidebarLimit',
    'rankWindow',
    'readConcurrency',
    'maxConcurrentSearches',
    'queryWordLimit',
    'searchTimeoutMs',
    'syncTakeoverSeconds',
    'vocabFlushSeconds',
    'reconcileDays',
    'sharedReadMaxBytes',
    'statusCacheSeconds',
    'analysisCacheWords',
  ])('requires %s to be an integer of at least 1', (field) => {
    expect(searchConfigSchema.safeParse({ [field]: 0 }).success).toBe(false);
    expect(searchConfigSchema.safeParse({ [field]: 1.5 }).success).toBe(false);
    expect(searchConfigSchema.safeParse({ [field]: 1 }).success).toBe(true);
  });

  it.each([
    ['jobs', 'batchSize'],
    ['jobs', 'batchDelayMs'],
    ['prefix', 'maxCommonReads'],
    ['prefix', 'maxRareTokens'],
    ['prefix', 'maxVocabRows'],
    ['typo', 'maxCorrections'],
    ['typo', 'maxVocabRows'],
    ['shadow', 'maxConcurrent'],
    ['shadow', 'panelRound'],
  ])('requires %s.%s to be an integer of at least 1', (block, field) => {
    expect(searchConfigSchema.safeParse({ [block]: { [field]: 0 } }).success).toBe(false);
    expect(searchConfigSchema.safeParse({ [block]: { [field]: 1 } }).success).toBe(true);
  });

  it('caps rankWindow at 200, which bounds cursor size', () => {
    expect(searchConfigSchema.safeParse({ rankWindow: 200 }).success).toBe(true);
    expect(searchConfigSchema.safeParse({ rankWindow: 201 }).success).toBe(false);
  });

  it('keeps languages a plain string array, checked later against registered packs', () => {
    const parsed = searchConfigSchema.parse({ languages: ['xx'] });
    expect(parsed.languages).toEqual(['xx']);
    expect(searchConfigSchema.safeParse({ languages: 'is' }).success).toBe(false);
  });

  it('is a base-only section', () => {
    expect(BASE_ONLY_CONFIG_SECTIONS).toContain('search');
    expect(BASE_ONLY_CONFIG_SECTIONS).toContain('filters');
  });
});

describe('search API types', () => {
  it('names the stable error codes and reasons of the HTTP contract', () => {
    expect([...SEARCH_ERROR_CODES]).toEqual([
      'search_busy',
      'search_failed',
      'search_cursor_invalid',
    ]);
    expect([...SEARCH_REASONS]).toEqual(['only_stop_words']);
  });

  it('describes the additive response shapes', () => {
    const code: SearchErrorCode = 'search_busy';
    const error: SearchErrorResponse = { code };
    const meta: SearchMeta = {
      attribution: { text: 'text', url: 'https://example.com' },
      panel: { eligible: true },
    };
    const compare: SearchPanelCompareResponse = {
      meilisearch: { messages: [] },
      search: { messages: [], state: 'dropped' },
    };
    const verdict: SearchPanelVerdictRequest = { verdict: 'equal', knownMissed: false };
    const conversations: ConversationListResponse = {
      conversations: [],
      nextCursor: null,
      partial: true,
      reason: 'only_stop_words',
    };
    const messages: MessagesListResponse = {
      messages: [],
      nextCursor: null,
      reason: 'only_stop_words',
    };
    const shares: SharedLinksResponse = {
      links: [],
      nextCursor: null,
      hasNextPage: false,
      reason: 'only_stop_words',
    };
    const empty: SearchMeta = {};

    expect(error.code).toBe('search_busy');
    expect(meta.panel?.eligible).toBe(true);
    expect(compare.search.state).toBe('dropped');
    expect(verdict.knownMissed).toBe(false);
    expect(conversations.partial).toBe(true);
    expect(messages.reason).toBe('only_stop_words');
    expect(shares.reason).toBe('only_stop_words');
    expect(empty).toEqual({});
  });
});
