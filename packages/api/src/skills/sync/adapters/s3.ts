import path from 'path';
import { z } from 'zod';
import JSZip from 'jszip';
import crypto from 'crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SkillSyncS3SourceConfig } from 'librechat-data-provider';
import type { RepoCommit, RepoTreeEntry, GitRepoAdapter, FetchTreeEntriesParams } from './types';
import { SkillSyncError } from '../errors';

/** Per-archive entry cap, feed-wide inflated-bytes budget, and per-object download caps. */
const MAX_ZIP_ENTRIES = 2000;
const MAX_FEED_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_MARKETPLACE_BYTES = 1024 * 1024;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

const marketplaceSchema = z.object({
  plugins: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
        source: z.object({
          source: z.literal('archive'),
          url: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      }),
    )
    .superRefine((plugins, ctx) => {
      const seen = new Set<string>();
      for (const [index, plugin] of plugins.entries()) {
        if (seen.has(plugin.name)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'name'],
            message: `Duplicate plugin name "${plugin.name}"`,
          });
        }
        seen.add(plugin.name);
      }
    }),
});

export type S3PluginAdapterConfig = {
  source: SkillSyncS3SourceConfig;
  /** Injectable for tests; defaults to a client using the ambient credential chain. */
  s3?: Pick<S3Client, 'send'>;
};

type S3Reader = (key: string, maxBytes: number) => Promise<Uint8Array>;

/** JSZip keeps the declared inflated size here; there is no public accessor. */
type SizedZipEntry = { _data?: { uncompressedSize?: number } };

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
async function extractSkillFiles(
  plugin: string,
  bytes: Uint8Array,
  budget: { remaining: number },
): Promise<Map<string, Buffer>> {
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
  for (const entry of entries) {
    const segments = entry.name.split('/');
    if (entry.name.startsWith('/') || entry.name.includes('\\') || segments.includes('..')) {
      throw archiveError(`Plugin archive "${plugin}" has an unsafe entry name`);
    }
    if (entry.dir || segments[0] !== 'skills' || segments.length < 3) {
      continue;
    }
    // ponytail: the declared size is attacker-controlled metadata; the post-inflate check below
    // is the backstop. The feed-wide budget bounds inflated bytes, not the transient inflate buffer.
    const declared = (entry as unknown as SizedZipEntry)._data?.uncompressedSize;
    if (declared != null && declared > budget.remaining) {
      throw archiveError(`Plugin archive "${plugin}" is too large`);
    }
    const content = Buffer.from(await entry.async('uint8array'));
    budget.remaining -= content.length;
    if (budget.remaining < 0) {
      throw archiveError(`Plugin archive "${plugin}" is too large`);
    }
    out.set(`${plugin}/${entry.name}`, content);
  }
  if (out.size === 0) {
    // A plugin that lost its skills must fail the run, never reconcile its mirrors away.
    throw archiveError(`Plugin archive "${plugin}" contains no files under skills/`);
  }
  return out;
}

async function loadFeed(
  read: S3Reader,
  marketplaceKey: string,
): Promise<{ commit: RepoCommit; files: Map<string, Buffer> }> {
  let json: unknown;
  try {
    json = JSON.parse(
      Buffer.from(await read(marketplaceKey, MAX_MARKETPLACE_BYTES)).toString('utf8'),
    );
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
  const budget = { remaining: MAX_FEED_UNCOMPRESSED_BYTES };
  for (const plugin of parsed.data.plugins) {
    const zipBytes = await read(resolveZipKey(marketplaceKey, plugin.source.url), MAX_ZIP_BYTES);
    if (sha256Hex(zipBytes) !== plugin.source.sha256) {
      throw archiveError(`Plugin archive "${plugin.name}" does not match its sha256`);
    }
    shas.push(plugin.source.sha256);
    for (const [filePath, content] of await extractSkillFiles(plugin.name, zipBytes, budget)) {
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

  const read: S3Reader = async (key, maxBytes) => {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: key }));
      if (!res.Body) {
        throw new Error('empty body');
      }
      if (res.ContentLength != null && res.ContentLength > maxBytes) {
        throw new SkillSyncError('S3_READ_FAILED', `s3 object "${key}" exceeds ${maxBytes} bytes`);
      }
      // Count while streaming so a missing or wrong ContentLength cannot defeat the cap.
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) {
          throw new SkillSyncError(
            'S3_READ_FAILED',
            `s3 object "${key}" exceeds ${maxBytes} bytes`,
          );
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof SkillSyncError) {
        throw error;
      }
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
