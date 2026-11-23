import path from 'path';
import { z } from 'zod';
import JSZip from 'jszip';
import crypto from 'crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SkillSyncS3SourceConfig } from 'librechat-data-provider';
import type { RepoCommit, RepoTreeEntry, GitRepoAdapter, FetchTreeEntriesParams } from './types';
import { SkillSyncError } from '../errors';

/** Zip-bomb limits, applied per plugin archive. */
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const marketplaceSchema = z.object({
  plugins: z.array(
    z.object({
      name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
      source: z.object({
        source: z.literal('archive'),
        url: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    }),
  ),
});

export type S3PluginAdapterConfig = {
  source: SkillSyncS3SourceConfig;
  /** Injectable for tests; defaults to a client using the ambient credential chain. */
  s3?: Pick<S3Client, 'send'>;
};

type S3Reader = (key: string) => Promise<Uint8Array>;

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function archiveError(message: string): SkillSyncError {
  return new SkillSyncError('S3_INVALID_ARCHIVE', message);
}

/** Marketplace-relative url -> bucket key; refuses anything that could leave the feed folder. */
function resolveZipKey(marketplaceKey: string, url: string): string {
  if (
    url.startsWith('/') ||
    url.includes('\\') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ||
    url.split('/').includes('..')
  ) {
    throw new SkillSyncError('S3_INVALID_MARKETPLACE', `Unsafe plugin archive url "${url}"`);
  }
  return `${path.posix.dirname(marketplaceKey)}/${url}`;
}

/** Returns `<plugin>/skills/<skill>/<file>` -> bytes for every file under the zip's `skills/`. */
async function extractSkillFiles(plugin: string, bytes: Uint8Array): Promise<Map<string, Buffer>> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw archiveError(`Plugin archive "${plugin}" is not a valid zip`);
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw archiveError(`Plugin archive "${plugin}" has too many entries`);
  }
  const out = new Map<string, Buffer>();
  let total = 0;
  for (const entry of entries) {
    const segments = entry.name.split('/');
    if (entry.name.startsWith('/') || entry.name.includes('\\') || segments.includes('..')) {
      throw archiveError(`Plugin archive "${plugin}" has an unsafe entry name`);
    }
    if (entry.dir || segments[0] !== 'skills' || segments.length < 3) {
      continue;
    }
    // ponytail: JSZip has no public pre-inflate size, so a single huge entry is inflated
    // before this check; the per-archive download is small and bounded by the sha256 pin.
    const content = Buffer.from(await entry.async('uint8array'));
    total += content.length;
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw archiveError(`Plugin archive "${plugin}" is too large`);
    }
    out.set(`${plugin}/${entry.name}`, content);
  }
  return out;
}

async function loadFeed(
  read: S3Reader,
  marketplaceKey: string,
): Promise<{ commit: RepoCommit; files: Map<string, Buffer> }> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(await read(marketplaceKey)).toString('utf8'));
  } catch (error) {
    if (error instanceof SkillSyncError) {
      throw error;
    }
    throw new SkillSyncError('S3_INVALID_MARKETPLACE', 'marketplace.json is not valid JSON');
  }
  const parsed = marketplaceSchema.safeParse(json);
  if (!parsed.success) {
    throw new SkillSyncError('S3_INVALID_MARKETPLACE', 'marketplace.json has an invalid shape');
  }
  const files = new Map<string, Buffer>();
  const shas: string[] = [];
  for (const plugin of parsed.data.plugins) {
    const zipBytes = await read(resolveZipKey(marketplaceKey, plugin.source.url));
    if (sha256Hex(zipBytes) !== plugin.source.sha256) {
      throw archiveError(`Plugin archive "${plugin.name}" does not match its sha256`);
    }
    shas.push(plugin.source.sha256);
    for (const [filePath, content] of await extractSkillFiles(plugin.name, zipBytes)) {
      files.set(filePath, content);
    }
  }
  const id = sha256Hex(Buffer.from(shas.sort().join('\n')));
  return { commit: { id, treeId: id }, files };
}

export function createS3PluginAdapter(config: S3PluginAdapterConfig): GitRepoAdapter {
  const { source } = config;
  const s3 = config.s3 ?? new S3Client({ region: source.region });
  let feed: ReturnType<typeof loadFeed> | null = null;

  const read: S3Reader = async (key) => {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: key }));
      if (!res.Body) {
        throw new Error('empty body');
      }
      return await res.Body.transformToByteArray();
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new SkillSyncError('S3_READ_FAILED', `Could not read s3 object "${key}" (${name})`);
    }
  };

  async function resolveCommit(): Promise<RepoCommit> {
    feed ??= loadFeed(read, source.key);
    return (await feed).commit;
  }

  async function fetchTreeEntries(
    _commit: RepoCommit,
    params: FetchTreeEntriesParams,
  ): Promise<RepoTreeEntry[]> {
    params.assertNotCancelled();
    const { files } = await (feed ?? Promise.reject(new Error('resolveCommit was not called')));
    return [...files].map(([entryPath, bytes]) => ({
      path: entryPath,
      type: 'blob' as const,
      id: sha256Hex(bytes),
      size: bytes.length,
    }));
  }

  async function fetchFileContent(_commit: RepoCommit, entry: RepoTreeEntry): Promise<Buffer> {
    const bytes = (await feed)?.files.get(entry.path);
    if (!bytes) {
      throw new SkillSyncError('S3_READ_FAILED', `File "${entry.path}" is not in the plugin feed`);
    }
    return bytes;
  }

  return { resolveCommit, fetchTreeEntries, fetchFileContent };
}
