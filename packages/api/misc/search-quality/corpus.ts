import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import type { SearchSource } from '~/search/sync/extract';

/**
 * Lines of a `.ndjson` or `.ndjson.gz` file. A missing file fails here: a read stream's
 * error does not cross `pipe`, so the line reader would wait until the test timed out.
 */
export async function* readNdjson<T>(path: string): AsyncGenerator<T> {
  await access(path);
  const file = createReadStream(path);
  const input: Readable = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
  for await (const line of createInterface({ input })) {
    if (line.length > 0) {
      yield JSON.parse(line) as T;
    }
  }
}

/** One line of `gen.mjs`'s `messages-*` or `convos-*` shards: a source plus its reference text. */
export type CorpusDocument = SearchSource & { _indexable?: boolean; _text?: string };

async function* readShards(dir: string, prefix: string): AsyncGenerator<CorpusDocument> {
  const shards = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
  for (const shard of shards) {
    yield* readNdjson<CorpusDocument>(join(dir, shard));
  }
}

/** Corpus documents carry no `_id`, so one is derived from a stable field. */
const derivedId = (key: string): string =>
  createHash('sha1').update(key).digest('hex').slice(0, 24);

export async function* corpusMessages(dir: string): AsyncGenerator<CorpusDocument> {
  for await (const doc of readShards(dir, 'messages')) {
    yield { ...doc, _id: doc._id ?? derivedId(String(doc.messageId)) };
  }
}

export async function* corpusConversations(dir: string): AsyncGenerator<CorpusDocument> {
  for await (const doc of readShards(dir, 'convos')) {
    yield { ...doc, _id: doc._id ?? derivedId(String(doc.conversationId)) };
  }
}
