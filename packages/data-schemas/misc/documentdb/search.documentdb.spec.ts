import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import type { ConnectOptions } from 'mongoose';
import type { ConversationSearchRecord, MessageSearchRecord } from '~/types/search';
import type { SearchMethods, SearchSourceEvent } from '~/methods/search';
import { createSearchMethods } from '~/methods/search';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Amazon DocumentDB live run of the conversation search data methods (R-05).
 *
 * Every probe drives the PRODUCTION method in `src/methods/search.ts`, so the suite cannot
 * drift from the shapes the server sends: the hinted window reads with `$in`, `$and` and
 * `$nin` on `tokens`, the conditional `replaceOne` upsert, the unordered bulk writes, the
 * lease's `findOneAndUpdate` upsert, and the change streams the sync writer reads.
 *
 * The search collections and the `lease` and `stream` keys have fixed names, so this needs a
 * DEDICATED database: it refuses to start where a search collection already holds a document,
 * and it drops the four search collections when it ends. Source rows it writes carry this
 * run's user, and only those are removed.
 *
 * The change-stream probes need streams enabled on the database or on `messages` and
 * `conversations` (`modifyChangeStreams`); where they are not, those probes report it and
 * every other probe still runs.
 *
 * Run (from packages/data-schemas):
 *   DOCUMENTDB_URI="mongodb://user:pass@127.0.0.1:27017/librechat_search_compat\
 *     ?tls=true&retryWrites=false&authSource=admin&authMechanism=SCRAM-SHA-1&directConnection=true" \
 *   DOCUMENTDB_TLS_CA_FILE="global-bundle.pem" \
 *   DOCUMENTDB_TLS_ALLOW_INVALID_HOSTNAMES=true \
 *     npx jest --config misc/documentdb/jest.documentdb.config.mjs search
 *
 * `audit.documentdb.spec.ts` explains each URI parameter. Set DOCUMENTDB_STRICT=true to turn
 * a rejected production shape, or a wrong answer from one, into a failure.
 */
const DOCUMENTDB_URI = process.env.DOCUMENTDB_URI ?? '';
const STRICT = process.env.DOCUMENTDB_STRICT === 'true';
const describeLive = DOCUMENTDB_URI ? describe : describe.skip;

const SEARCH_COLLECTIONS = ['msearch', 'csearch', 'search_vocab', 'search_state'];
const READ = { maxTimeMS: 30_000 };
const STREAM_WAIT_MS = 20_000;

const runId = randomUUID().slice(0, 8);
const ACCEPTED = 'accepted';
const verdicts: Record<string, string> = {};

function getDb() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB database handle not available');
  }
  return db;
}

/**
 * Records whether the engine ran the method and gave the right answer. Never throws: a
 * rejection or a wrong answer is the finding, not a harness failure.
 */
async function probe(label: string, run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    verdicts[label] = ACCEPTED;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    verdicts[label] = `REJECTED - ${message.replace(/\s+/g, ' ').slice(0, 160)}`;
  }
  return verdicts[label];
}

function expectShape(label: string): void {
  expect(verdicts[label]).toBeDefined();
  if (STRICT) {
    expect(verdicts[label]).toBe(ACCEPTED);
  }
}

/** A wrong answer from an accepted shape, reported under the probe's own label. */
function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`wrong answer: ${message}`);
  }
}

const sameMembers = (found: readonly string[], expected: readonly string[]): boolean =>
  found.length === expected.length && [...found].sort().join() === [...expected].sort().join();

describeLive('Amazon DocumentDB - conversation search data methods', () => {
  let methods: SearchMethods;

  const user = `ddb-search-user-${runId}`;
  const otherUser = `ddb-search-other-${runId}`;
  const conversationId = `ddb-search-convo-${runId}`;
  const version = `ddb-${runId}`;
  /** Tokens only this run writes, in one narrow range of the word list. */
  const token = (name: string) => `zzddb${runId}${name}`;
  const day = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset));

  const ids = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId().toHexString());
  const conversationRecordId = new mongoose.Types.ObjectId().toHexString();
  const messageId = (id: string) => `ddb-message-${id}`;

  const messageRecord = (
    id: string,
    fields: Partial<MessageSearchRecord> = {},
  ): MessageSearchRecord => ({
    _id: id,
    user,
    conversationId,
    messageId: messageId(id),
    createdAt: day(0),
    n: 2,
    h: 'h0',
    v: version,
    e: 0,
    tokens: [token('alpha')],
    ...fields,
  });

  const conversationRecord = (
    fields: Partial<ConversationSearchRecord> = {},
  ): ConversationSearchRecord => ({
    _id: conversationRecordId,
    user,
    conversationId,
    h: 'h0',
    v: version,
    e: 0,
    tokens: [token('alpha'), token('beta')],
    ...fields,
  });

  /** One open stream: resolves with the first batch that carries this source's event. */
  async function firstEventFor(
    scope: 'database' | 'collections',
    dropUpdatedText: boolean,
  ): Promise<SearchSourceEvent | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STREAM_WAIT_MS);
    const id = new mongoose.Types.ObjectId();
    let written = false;
    try {
      const stream = methods.watchSearchSources({
        resumeToken: null,
        signal: controller.signal,
        scope,
        dropUpdatedText,
        maxAwaitTimeMS: 500,
      });
      for await (const batch of stream) {
        const found = batch.events.find(
          (event) => event.type !== 'gap' && event.id === id.toHexString(),
        );
        if (found) {
          check(batch.position != null, 'a batch with an event carries no resume position');
          return found;
        }
        /* The first, empty batch shows the stream is open: only then is the write made. */
        if (!written) {
          written = true;
          await getDb()
            .collection('messages')
            .insertOne({
              _id: id,
              user,
              conversationId,
              messageId: messageId(id.toHexString()),
              text: 'stream probe',
            });
        }
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  beforeAll(async () => {
    const options: ConnectOptions = { autoIndex: false, autoCreate: false };
    if (process.env.DOCUMENTDB_TLS_CA_FILE) {
      options.tlsCAFile = process.env.DOCUMENTDB_TLS_CA_FILE;
    }
    if (process.env.DOCUMENTDB_TLS_ALLOW_INVALID_HOSTNAMES === 'true') {
      options.tlsAllowInvalidHostnames = true;
    }
    await mongoose.connect(DOCUMENTDB_URI, options);

    for (const name of SEARCH_COLLECTIONS) {
      if ((await getDb().collection(name).countDocuments({}, { limit: 1 })) > 0) {
        await mongoose.disconnect();
        throw new Error(
          `${name} already holds documents: this suite drops the search collections, so run it against a dedicated database`,
        );
      }
    }

    Object.assign(mongoose.models, createModels(mongoose));
    methods = createSearchMethods(mongoose);

    await getDb()
      .collection('messages')
      .insertMany(
        ids.slice(0, 3).map((id, index) => ({
          _id: new mongoose.Types.ObjectId(id),
          user,
          conversationId,
          messageId: messageId(id),
          text: `probe text ${index}`,
          isCreatedByUser: true,
          createdAt: day(index),
          updatedAt: day(index),
        })),
      );
    await getDb()
      .collection('conversations')
      .insertOne({
        _id: new mongoose.Types.ObjectId(conversationRecordId),
        user,
        conversationId,
        title: 'probe title',
        createdAt: day(0),
        updatedAt: day(0),
      });
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 1) {
      return;
    }
    await getDb()
      .collection('messages')
      .deleteMany({ user })
      .catch(() => undefined);
    await getDb()
      .collection('conversations')
      .deleteMany({ user })
      .catch(() => undefined);
    for (const name of SEARCH_COLLECTIONS) {
      await getDb()
        .collection(name)
        .drop()
        .catch(() => undefined);
    }

    const width = Math.max(...Object.keys(verdicts).map((key) => key.length));
    const rows = Object.entries(verdicts).map(
      ([label, verdict]) => `  ${label.padEnd(width)}  ${verdict}`,
    );
    console.log(`\nDocumentDB search verdicts (run ${runId}):\n${rows.join('\n')}\n`);
    await mongoose.disconnect();
  });

  it('reports the engine build so the verdicts are attributable', async () => {
    const info = await getDb().admin().command({ buildInfo: 1 });
    const engine = typeof info.version === 'string' ? info.version : 'unknown';
    verdicts['engine version'] = engine;
    expect(engine).toBeTruthy();
  });

  describe('collections and indexes', () => {
    it('ensureSearchCollections, twice', async () => {
      await probe('ensureSearchCollections', async () => {
        await methods.ensureSearchCollections();
        await methods.ensureSearchCollections();
        const names = (await getDb().listCollections().toArray()).map(({ name }) => name);
        check(
          SEARCH_COLLECTIONS.every((name) => names.includes(name)),
          'a search collection is missing',
        );
        check(await methods.searchStateExists(), 'searchStateExists is false');
      });
      expectShape('ensureSearchCollections');
    });

    it('ensureSearchIndexes, twice', async () => {
      await probe('ensureSearchIndexes', async () => {
        await methods.ensureSearchIndexes();
        await methods.ensureSearchIndexes();
        const names = (await getDb().collection('msearch').indexes()).map(({ name }) => name);
        check(names.includes('user_tokens_created'), 'the message record index is missing');
      });
      expectShape('ensureSearchIndexes');
    });
  });

  describe('record writes', () => {
    it('insertSearchRecords: unordered, and a record already there wins', async () => {
      await probe('insertSearchRecords', async () => {
        const records = [
          messageRecord(ids[0], { createdAt: day(0), tokens: [token('alpha'), token('beta')] }),
          messageRecord(ids[1], { createdAt: day(1), tokens: [token('alpha'), token('gamma')] }),
          messageRecord(ids[2], { createdAt: day(1), tokens: [token('beta')] }),
          messageRecord(ids[3], { user: otherUser, tokens: [token('alpha')] }),
        ];
        const first = await methods.insertSearchRecords('messages', records);
        check(first.written === 4 && first.duplicates === 0, JSON.stringify(first));
        const again = await methods.insertSearchRecords('messages', [
          ...records.slice(0, 2),
          messageRecord(ids[4], { createdAt: day(2), tokens: [token('gamma')] }),
        ]);
        check(again.written === 1 && again.duplicates === 2, JSON.stringify(again));
        const convo = await methods.insertSearchRecords('conversations', [conversationRecord()]);
        check(convo.written === 1, JSON.stringify(convo));
      });
      expectShape('insertSearchRecords');
    });

    it('replaceSearchRecords: the conditional upsert keeps a newer writer’s record', async () => {
      await probe('replaceSearchRecords', async () => {
        const newer = await methods.replaceSearchRecords('messages', [
          messageRecord(ids[4], { createdAt: day(2), e: 5, h: 'h5', tokens: [token('gamma')] }),
        ]);
        check(newer.written === 1 && newer.duplicates === 0, JSON.stringify(newer));
        const older = await methods.replaceSearchRecords('messages', [
          messageRecord(ids[4], { createdAt: day(2), e: 4, h: 'h4', tokens: [token('stale')] }),
        ]);
        check(older.written === 0 && older.duplicates === 1, JSON.stringify(older));
        const [stamp] = await methods.readSearchRecordStamps('messages', [ids[4]]);
        check(stamp?.e === 5 && stamp.h === 'h5', JSON.stringify(stamp));
      });
      expectShape('replaceSearchRecords');
    });

    it('rewriteSearchRecords: only where h and v still hold what was read', async () => {
      await probe('rewriteSearchRecords', async () => {
        const rewrite = (expectH: string) =>
          methods.rewriteSearchRecords('messages', [
            {
              record: messageRecord(ids[2], {
                createdAt: day(1),
                h: 'h1',
                tokens: [token('beta')],
              }),
              expect: { h: expectH, v: version },
            },
          ]);
        check((await rewrite('other')) === 0, 'a stale expectation rewrote the record');
        check((await rewrite('h0')) === 1, 'a matching expectation rewrote nothing');
      });
      expectShape('rewriteSearchRecords');
    });

    it('deleteSearchRecords: a newer writer’s record stays under atMostEpoch', async () => {
      await probe('deleteSearchRecords', async () => {
        check(
          (await methods.deleteSearchRecords('messages', [ids[4]], { atMostEpoch: 4 })) === 0,
          'a record above the epoch was deleted',
        );
        check(
          (await methods.deleteSearchRecords('messages', [ids[3]])) === 1,
          'an unconditional delete removed nothing',
        );
      });
      expectShape('deleteSearchRecords');
    });
  });

  describe('job reads', () => {
    it('reads records by range, by ID and by analyzer version', async () => {
      await probe('record range reads', async () => {
        const all = await methods.readSearchRecordIds({ collection: 'messages', limit: 100 });
        const mine = all.filter((id) => ids.includes(id));
        check(sameMembers(mine, [ids[0], ids[1], ids[2], ids[4]]), mine.join());
        check([...mine].sort().join() === mine.join(), 'record IDs are out of _id order');
        const present = await methods.readSearchRecordIdsIn('messages', ids);
        check(present.length === 4, `readSearchRecordIdsIn found ${present.length}`);
        const tokens = await methods.readSearchRecordTokenBatch({
          collection: 'messages',
          limit: 100,
        });
        check(
          tokens.some(({ _id, tokens: held }) => _id === ids[0] && held.length === 2),
          'readSearchRecordTokenBatch lost a record’s tokens',
        );
        const stamps = await methods.readSearchRecordStamps('messages', ids);
        check(stamps.length === 4, `readSearchRecordStamps found ${stamps.length}`);
        const others = await methods.countSearchRecordsAtOtherVersion({
          collection: 'messages',
          version: 'another-version',
        });
        check(others >= 4, `countSearchRecordsAtOtherVersion gave ${others}`);
      });
      expectShape('record range reads');
    });

    it('reads sources by page and by ID, with and without text', async () => {
      await probe('source reads', async () => {
        const page = await methods.readSearchSources({
          collection: 'messages',
          afterId: ids[0],
          upToId: ids[2],
          limit: 10,
          withText: true,
        });
        check(
          page.map(({ _id }) => _id).join() === [ids[1], ids[2]].join(),
          page.map(({ _id }) => _id).join(),
        );
        check(typeof page[0].text === 'string', 'withText read no text');
        const byId = await methods.readSearchSourcesById('messages', ids);
        check(byId.length === 3, `readSearchSourcesById found ${byId.length}`);
        check(byId[0].text === undefined, 'a state read carried text');
        check((await methods.countSearchSources('messages')) >= 0, 'countSearchSources failed');
        check(
          Array.isArray(await methods.readSearchSourceTenants()),
          'readSearchSourceTenants failed',
        );
      });
      expectShape('source reads');
    });
  });

  describe('search reads', () => {
    it('readRecordWindow: one token in index order, newest first, for one user', async () => {
      await probe('readRecordWindow, one token', async () => {
        const rows = await methods.readRecordWindow(
          { user, tokens: [token('alpha')], limit: 10 },
          READ,
        );
        check(rows.map(({ _id }) => _id).join() === [ids[1], ids[0]].join(), JSON.stringify(rows));
      });
      expectShape('readRecordWindow, one token');
    });

    it('readRecordWindow: $in with $and, $nin and date bounds under the hint', async () => {
      await probe('readRecordWindow, $in + allOf + noneOf + range', async () => {
        const several = await methods.readRecordWindow(
          { user, tokens: [token('alpha'), token('gamma')], limit: 10 },
          READ,
        );
        check(
          sameMembers([...new Set(several.map(({ _id }) => _id))], [ids[0], ids[1], ids[4]]),
          'the $in read',
        );
        const both = await methods.readRecordWindow(
          { user, tokens: [token('alpha')], allOf: [[token('beta'), token('delta')]], limit: 10 },
          READ,
        );
        check(both.map(({ _id }) => _id).join() === ids[0], 'the allOf read');
        const without = await methods.readRecordWindow(
          { user, tokens: [token('alpha')], noneOf: [token('gamma')], limit: 10 },
          READ,
        );
        check(without.map(({ _id }) => _id).join() === ids[0], 'the noneOf read');
        const bounded = await methods.readRecordWindow(
          {
            user,
            tokens: [token('alpha'), token('gamma')],
            range: { upTo: day(1), after: day(0) },
            limit: 10,
          },
          READ,
        );
        check(bounded.map(({ _id }) => _id).join() === ids[1], 'the bounded read');
      });
      expectShape('readRecordWindow, $in + allOf + noneOf + range');
    });

    it('readRecordTies: one date’s rows in _id order', async () => {
      await probe('readRecordTies', async () => {
        const tied = [ids[1], ids[2]].sort();
        const rows = await methods.readRecordTies(
          { user, tokens: [token('alpha'), token('beta'), token('gamma')], at: day(1), limit: 10 },
          READ,
        );
        check(
          [...new Set(rows.map(({ _id }) => _id))].join() === tied.join(),
          JSON.stringify(rows),
        );
        const after = await methods.readRecordTies(
          {
            user,
            tokens: [token('alpha'), token('beta'), token('gamma')],
            at: day(1),
            afterId: tied[0],
            limit: 10,
          },
          READ,
        );
        check([...new Set(after.map(({ _id }) => _id))].join() === tied[1], 'the afterId read');
      });
      expectShape('readRecordTies');
    });

    it('readRecordTokens, readConversationRecords and the hydration reads', async () => {
      await probe('token, conversation and hydration reads', async () => {
        const tokens = await methods.readRecordTokens({ user, ids: [ids[0], ids[3]] }, READ);
        check(tokens.length === 1 && tokens[0]._id === ids[0], 'readRecordTokens');
        const convos = await methods.readConversationRecords(
          { user, allOf: [[token('alpha')], [token('beta'), token('delta')]], limit: 10 },
          READ,
        );
        check(convos.length === 1 && convos[0].conversationId === conversationId, 'the title read');
        const texts = await methods.readMessageTexts(
          { user, messageIds: ids.slice(0, 3).map(messageId) },
          READ,
        );
        check(texts.length === 3, `readMessageTexts found ${texts.length}`);
        const visible = await methods.getSearchableMessages(
          user,
          ids.slice(0, 3).map(messageId),
          READ,
        );
        check(visible.length === 3, `getSearchableMessages found ${visible.length}`);
        const hits = await methods.getSearchHitConversations(user, [conversationId], READ);
        check(hits.length === 1 && hits[0].title === 'probe title', 'getSearchHitConversations');
      });
      expectShape('token, conversation and hydration reads');
    });

    it('a read stops on maxTimeMS or its signal, and leaves the next read working', async () => {
      await probe('aborted read', async () => {
        const controller = new AbortController();
        controller.abort();
        const aborted = await methods
          .readRecordWindow(
            { user, tokens: [token('alpha')], limit: 10 },
            { maxTimeMS: 1000, signal: controller.signal },
          )
          .then(
            () => false,
            () => true,
          );
        check(aborted, 'an aborted read answered');
        const rows = await methods.readRecordWindow(
          { user, tokens: [token('alpha')], limit: 10 },
          READ,
        );
        check(rows.length === 2, 'the read after an aborted one');
      });
      expectShape('aborted read');
    });
  });

  describe('word list', () => {
    const RUN = 7;

    it('increments, stamps and reads the word list', async () => {
      await probe('word list increments and reads', async () => {
        await methods.incrementSearchVocab({
          counts: [
            [token('a'), 2],
            [token('b'), 1],
            [token('stale'), 4],
          ],
          run: null,
        });
        await methods.incrementSearchVocab({ counts: [[token('writer'), 1]], run: RUN });
        await methods.incrementSearchVocabNext({
          counts: [
            [token('a'), 5],
            [token('b'), 3],
            [token('new'), 1],
          ],
          run: RUN,
        });
        const found = await methods.readVocabFrequencies([token('a'), token('absent')], READ);
        check(found.length === 1 && found[0].df === 2, JSON.stringify(found));
        const range = await methods.readVocabRange(
          { start: token(''), end: `${token('')}￿`, limit: 3 },
          READ,
        );
        check(
          range.map(({ token: held }) => held).join() ===
            [token('a'), token('b'), token('new')].join(),
          JSON.stringify(range),
        );
      });
      expectShape('word list increments and reads');
    });

    it('settleSearchVocab: one unordered write copies, and deletes what the run never stamped', async () => {
      await probe('settleSearchVocab', async () => {
        const page = await methods.readSearchVocabBatch({ afterId: token(''), limit: 100 });
        const mine = page.filter(({ token: held }) => held.startsWith(token('')));
        check(mine.length === 5, `the page holds ${mine.length} of this run’s rows`);
        await methods.settleSearchVocab({
          copy: mine
            .filter(({ r, dfNext }) => r === RUN && dfNext != null)
            .map(({ token: held, dfNext }) => ({ token: held, df: dfNext as number })),
          range: { afterId: token(''), upToId: mine[mine.length - 1].token },
          run: RUN,
        });
        const after = (
          await methods.readSearchVocabBatch({ afterId: token(''), limit: 100 })
        ).filter(({ token: held }) => held.startsWith(token('')));
        const settled = after.map(
          ({ token: held, df, dfNext, r }) =>
            `${held.slice(token('').length)}:${df}:${dfNext}:${r}`,
        );
        check(
          settled.join() ===
            [
              `a:5:undefined:${RUN}`,
              `b:3:undefined:${RUN}`,
              `new:1:undefined:${RUN}`,
              `writer:1:undefined:${RUN}`,
            ].join(),
          settled.join(),
        );
      });
      expectShape('settleSearchVocab');
    });
  });

  describe('state, lease and stream position', () => {
    it('writes, reads, lists and deletes state keys', async () => {
      await probe('search state keys', async () => {
        const key = `ddb-probe-${runId}`;
        await methods.writeSearchState(key, { status: 'running', count: 1 });
        await methods.writeSearchState(key, { count: 2 });
        const entry = await methods.readSearchState(key, READ);
        check(entry?.status === 'running' && entry.count === 2, JSON.stringify(entry));
        await methods.writeSearchState(`jobRequest:${runId}-b`, {
          job: 'verify',
          requestedAt: day(2),
        });
        await methods.writeSearchState(`jobRequest:${runId}-a`, {
          job: 'backfill',
          requestedAt: day(1),
        });
        const requests = (await methods.listSearchJobRequests()).filter(({ _id }) =>
          _id.includes(runId),
        );
        check(
          requests.map(({ job }) => job).join() === 'backfill,verify',
          JSON.stringify(requests),
        );
        await methods.deleteSearchState(key);
        check((await methods.readSearchState(key, READ)) === null, 'a deleted key was read');
      });
      expectShape('search state keys');
    });

    it('the lease: one holder, a raised epoch on takeover, and a fenced renew', async () => {
      await probe('search lease', async () => {
        const now = new Date();
        const until = new Date(now.getTime() + 60_000);
        const first = await methods.acquireSearchLease({ holder: 'a', until, now });
        check(first !== null, 'a free lease was refused');
        check(
          (await methods.acquireSearchLease({ holder: 'b', until, now })) === null,
          'a held lease was given away',
        );
        const epoch = first?.epoch ?? 0;
        check(await methods.renewSearchLease({ holder: 'a', epoch, until }), 'the holder’s renew');
        check(
          !(await methods.renewSearchLease({ holder: 'b', epoch, until })),
          'another holder renewed',
        );
        await methods.releaseSearchLease({ holder: 'a', epoch });
        const next = await methods.acquireSearchLease({ holder: 'b', until, now });
        check(next?.epoch === epoch + 1, `the epoch after takeover is ${next?.epoch}`);
      });
      expectShape('search lease');
    });

    it('saveSearchStreamState: a newer writer’s position stays', async () => {
      await probe('saveSearchStreamState', async () => {
        check(
          await methods.saveSearchStreamState({ epoch: 3, fields: { savedAt: new Date() } }),
          'the first save',
        );
        check(
          !(await methods.saveSearchStreamState({ epoch: 2, fields: { savedAt: new Date() } })),
          'an older writer saved over a newer one',
        );
        check(
          await methods.saveSearchStreamState({ epoch: 3, fields: { savedAt: new Date() } }),
          'the same writer’s next save',
        );
      });
      expectShape('saveSearchStreamState');
    });
  });

  describe('change streams', () => {
    it.each([
      ['database', true],
      ['database', false],
      ['collections', true],
    ] as const)(
      'watchSearchSources on %s, dropUpdatedText %s, delivers an insert with its document',
      async (scope, dropUpdatedText) => {
        const label = `watchSearchSources ${scope}${dropUpdatedText ? ' + $project' : ''}`;
        await probe(label, async () => {
          const event = await firstEventFor(scope, dropUpdatedText);
          check(event !== undefined, `no event within ${STREAM_WAIT_MS} ms`);
          check(
            event?.type === 'upsert' && event.collection === 'messages',
            JSON.stringify({ type: event?.type }),
          );
        });
        expectShape(label);
      },
    );
  });

  describe('drop', () => {
    it('dropSearchCollections removes the four collections and leaves the sources', async () => {
      await probe('dropSearchCollections', async () => {
        const dropped = await methods.dropSearchCollections();
        check(sameMembers(dropped, SEARCH_COLLECTIONS), dropped.join());
        const names = (await getDb().listCollections().toArray()).map(({ name }) => name);
        check(
          !SEARCH_COLLECTIONS.some((name) => names.includes(name)),
          'a search collection stayed',
        );
        check(names.includes('messages'), 'the messages collection went too');
        check(
          (await methods.dropSearchCollections()).length === 0,
          'a second drop removed something',
        );
      });
      expectShape('dropSearchCollections');
    });
  });
});
